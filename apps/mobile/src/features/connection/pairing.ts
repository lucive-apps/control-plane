import { readHostedPairingRequest } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = new URL(trimmed);
    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Treat non-URL payloads as raw pairing-url text so the normal input validation can decide.
  }

  return trimmed;
}

export const UNREACHABLE_PAIRING_MESSAGE =
  "Could not reach that computer. Check that Control Plane is running on your Mac and that this phone can reach it, then tap Try again.";
export const SERVER_UNAVAILABLE_PAIRING_MESSAGE =
  "That computer's server is not responding right now. Wait a minute, then tap Try again.";
export const WRONG_CODE_PAIRING_MESSAGE =
  "That pairing code was not accepted. Codes expire, so create a new one on your Mac, then tap Try again.";
export const WRONG_HOST_PAIRING_MESSAGE =
  "That host did not answer as Control Plane. Check the host and pairing code shown on your Mac, then tap Try again.";

/**
 * What the Add Environment screen shows when pairing fails. Transport and
 * status failures (a 503 from a stopped server, a wrong host, no route) get
 * a plain explanation instead of the raw request text, and so does a
 * rejected pairing code. Permission and compatibility failures keep their
 * specific message.
 */
export function pairingErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error && "reason" in error) {
    if (error._tag === "ConnectionTransientError") {
      switch (error.reason) {
        case "remote-unavailable":
          return SERVER_UNAVAILABLE_PAIRING_MESSAGE;
        case "endpoint-unavailable":
          return WRONG_HOST_PAIRING_MESSAGE;
        default:
          return UNREACHABLE_PAIRING_MESSAGE;
      }
    }
    if (error._tag === "ConnectionBlockedError" && error.reason === "authentication") {
      return WRONG_CODE_PAIRING_MESSAGE;
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Failed to pair with the environment.";
}
