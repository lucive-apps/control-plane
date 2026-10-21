/**
 * Turns a preview automation failure cause into a short reason an agent can act
 * on, such as "TimeoutError: Operation timed out after '1s'". Causes cross the
 * renderer, desktop IPC and server boundaries, so the text is stripped of local
 * paths, URL queries and token-like strings before it leaves the machine's logs.
 */
const MAX_REASON_LENGTH = 300;
const MAX_CAUSE_DEPTH = 4;

const FILE_URL = /file:\/\/[^\s'"`)\]]+/g;
// Home and temp paths. A space continues the path only when the next word still
// holds a separator, so "Application Support/Control Plane/x" is covered while
// the text after the path is kept.
const LOCAL_PATH =
  /(?:\/Users|\/home|\/private\/var|\/var\/folders|[A-Za-z]:[\\/]Users)[\\/][^\s'"`)\]]*(?: [^\s'"`)\]\\/]*[\\/][^\s'"`)\]]*)*/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`]+@/gi;
const URL_QUERY = /(https?:\/\/[^\s?#'"`)\]]+)[?#][^\s'"`)\]]*/g;
// key=value / key: value / "key":"value" credentials, including "Bearer <token>".
const CREDENTIAL =
  /((?:^|[^A-Za-z0-9])(?:[A-Za-z]+[_-])?(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session(?:id)?|sid)["']?\s*[=:]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s,;'"`)\]]+/gi;
const OPAQUE_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

export const sanitizePreviewFailureText = (text: string): string =>
  text
    .replace(FILE_URL, "<file>")
    .replace(LOCAL_PATH, "<path>")
    .replace(URL_USERINFO, "$1")
    .replace(URL_QUERY, "$1")
    .replace(CREDENTIAL, "$1<redacted>")
    .replace(OPAQUE_TOKEN, "<redacted>")
    .replace(/\s+/g, " ")
    .trim();

const ownMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const message = "message" in value && typeof value.message === "string" ? value.message : "";
  const tag =
    "_tag" in value && typeof value._tag === "string"
      ? value._tag
      : value instanceof Error && value.name !== "Error"
        ? value.name
        : undefined;
  if (!message) return tag;
  return tag && !message.startsWith(tag) ? `${tag}: ${message}` : message;
};

/** Returns undefined when the cause carries nothing beyond its wrapper. */
export const previewFailureReason = (cause: unknown): string | undefined => {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const message = ownMessage(current);
    if (message) {
      const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
      if (firstLine && !parts.some((part) => part.includes(firstLine))) parts.push(firstLine);
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  if (parts.length === 0) return undefined;
  const reason = sanitizePreviewFailureText(parts.join(": "));
  if (!reason) return undefined;
  return reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH - 3)}...`
    : reason;
};
