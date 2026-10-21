/**
 * Turns a preview automation failure cause into a short reason an agent can act
 * on, such as "TimeoutError: Operation timed out after '1s'". Causes cross the
 * renderer, desktop IPC and server boundaries, so the text is stripped of local
 * paths, URL queries and token-like strings before it leaves the machine's logs.
 */
const MAX_REASON_LENGTH = 300;
const MAX_CAUSE_DEPTH = 4;

const HOME_PATH = /(?:\/Users|\/home|[A-Za-z]:\\Users)[\\/][^\s'"`)\]]+/g;
const FILE_URL = /file:\/\/[^\s'"`)\]]+/g;
const URL_QUERY = /(https?:\/\/[^\s?#'"`)\]]+)[?#][^\s'"`)\]]*/g;
const BEARER = /\b(bearer|token|authorization|cookie|password|secret)([=: ]+)[^\s,;'"`)\]]+/gi;
const OPAQUE_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

export const sanitizePreviewFailureText = (text: string): string =>
  text
    .replace(FILE_URL, "<file>")
    .replace(HOME_PATH, "<path>")
    .replace(URL_QUERY, "$1")
    .replace(BEARER, "$1$2<redacted>")
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
