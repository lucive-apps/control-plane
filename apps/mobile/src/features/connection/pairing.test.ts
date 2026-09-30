import {
  ConnectionBlockedError,
  ConnectionTransientError,
  mapRemoteEnvironmentError,
} from "@t3tools/client-runtime/connection";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "@t3tools/client-runtime/rpc";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  pairingErrorMessage,
  parsePairingUrl,
  SERVER_UNAVAILABLE_PAIRING_MESSAGE,
  UNREACHABLE_PAIRING_MESSAGE,
  WRONG_CODE_PAIRING_MESSAGE,
  WRONG_HOST_PAIRING_MESSAGE,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});

describe("pairingErrorMessage", () => {
  const requestUrl = "https://review.example.test/.well-known/t3/environment";

  it("explains a server that returns 503", () => {
    const error = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, 503),
    );
    expect(pairingErrorMessage(error)).toBe(SERVER_UNAVAILABLE_PAIRING_MESSAGE);
  });

  it("points at the host and code for a 4xx", () => {
    const error = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, 404),
    );
    expect(pairingErrorMessage(error)).toBe(WRONG_HOST_PAIRING_MESSAGE);
  });

  it("explains an unreachable host", () => {
    for (const reason of ["network", "timeout", "transport"] as const) {
      expect(
        pairingErrorMessage(new ConnectionTransientError({ reason, detail: "fetch failed" })),
      ).toBe(UNREACHABLE_PAIRING_MESSAGE);
    }
  });

  it("explains a rejected pairing code", () => {
    expect(
      pairingErrorMessage(
        new ConnectionBlockedError({
          reason: "authentication",
          detail: "The environment credential is invalid.",
        }),
      ),
    ).toBe(WRONG_CODE_PAIRING_MESSAGE);
  });

  it("keeps specific pairing failures", () => {
    expect(
      pairingErrorMessage(
        new ConnectionBlockedError({ reason: "unsupported", detail: "Update the desktop app." }),
      ),
    ).toBe("Update the desktop app.");
    expect(pairingErrorMessage("nope")).toBe("Failed to pair with the environment.");
  });
});
