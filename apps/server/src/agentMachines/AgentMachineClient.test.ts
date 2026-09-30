import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";

import {
  AGENT_MACHINE_PROTOCOL_VERSION,
  AGENT_MACHINE_SCOPE,
  PEER_COMMAND_ALLOWLIST,
  PEER_REQUEST_TIMEOUT,
  PeerError,
  classifyPeerFailure,
  dispatchPeerCommand,
  exchangePairingCredential,
  fetchPeerDescriptor,
  fetchPeerShell,
  fetchPeerThread,
  isPeerCommand,
  requirePeerIdentity,
  validatePeerBaseUrl,
  type PeerCommand,
} from "./AgentMachineClient.ts";

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);
const decodeJson = Schema.decodeUnknownSync(JsonString);

const BASE_URL = "http://mini.tailnet.ts.net:3773";

const failureOf = <A, R>(effect: Effect.Effect<A, PeerError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ kind: error.kind, detail: error.detail })));

describe("validatePeerBaseUrl", () => {
  it.effect("accepts https anywhere and http to loopback, private and tailnet hosts", () =>
    Effect.gen(function* () {
      for (const [raw, origin] of [
        ["https://example.com", "https://example.com"],
        ["https://example.com:8443", "https://example.com:8443"],
        ["http://localhost:3773", "http://localhost:3773"],
        ["http://127.0.0.1:3773", "http://127.0.0.1:3773"],
        ["http://10.0.0.5:3773", "http://10.0.0.5:3773"],
        ["http://192.168.1.20", "http://192.168.1.20"],
        ["http://100.64.0.1:3773", "http://100.64.0.1:3773"],
        ["http://100.101.102.103", "http://100.101.102.103"],
        ["http://mini.tailnet.ts.net:3773", "http://mini.tailnet.ts.net:3773"],
        ["  http://mini.tailnet.ts.net  ", "http://mini.tailnet.ts.net"],
      ] as const) {
        expect(yield* validatePeerBaseUrl(raw), raw).toBe(origin);
      }
    }),
  );

  it.effect("refuses plain http over the internet and anything that is not a URL", () =>
    Effect.gen(function* () {
      for (const raw of [
        "http://example.com",
        "http://8.8.8.8:3773",
        "http://100.128.0.1",
        "ftp://10.0.0.5",
        "not a url",
        "",
        "mini.tailnet.ts.net:3773",
      ]) {
        const error = yield* Effect.flip(validatePeerBaseUrl(raw));
        expect(error.kind, raw).toBe("invalid-url");
      }
    }),
  );

  it.effect("drops the path, query and fragment so a pairing token never survives", () =>
    Effect.gen(function* () {
      const origin = yield* validatePeerBaseUrl(
        "https://mini.tailnet.ts.net/pair?token=SECRET#token=SECRET",
      );
      expect(origin).toBe("https://mini.tailnet.ts.net");
      expect(yield* validatePeerBaseUrl("http://10.0.0.5:3773/some/path/#credential=SECRET")).toBe(
        "http://10.0.0.5:3773",
      );
    }),
  );
});

const command = (type: string) =>
  ({
    type,
    commandId: `cmd-${type}`,
    threadId: "thread-1",
  }) as unknown as ClientOrchestrationCommand;

describe("peer command allowlist", () => {
  it("allows exactly the six agent commands", () => {
    expect([...PEER_COMMAND_ALLOWLIST].toSorted()).toEqual(
      [
        "thread.archive",
        "thread.create",
        "thread.session.stop",
        "thread.settle",
        "thread.turn.interrupt",
        "thread.turn.start",
      ].toSorted(),
    );
    for (const type of PEER_COMMAND_ALLOWLIST) {
      expect(isPeerCommand(command(type)), type).toBe(true);
    }
  });

  it("rejects destructive and project commands", () => {
    for (const type of [
      "thread.delete",
      "project.delete",
      "project.create",
      "thread.meta.update",
    ]) {
      expect(isPeerCommand(command(type)), type).toBe(false);
    }
  });
});

describe("classifyPeerFailure", () => {
  const kindOf = (error: unknown) => classifyPeerFailure(error).kind;

  it("maps 401 and auth failures to unauthorized", () => {
    expect(kindOf({ _tag: "EnvironmentAuthInvalidError" })).toBe("unauthorized");
    expect(kindOf({ _tag: "EnvironmentHttpUnauthorizedError" })).toBe("unauthorized");
    expect(kindOf({ _tag: "ResponseError", response: { status: 401 } })).toBe("unauthorized");
  });

  it("maps 403 and scope failures to unauthorized", () => {
    for (const tag of [
      "EnvironmentScopeRequiredError",
      "EnvironmentOperationForbiddenError",
      "EnvironmentHttpForbiddenError",
    ]) {
      expect(kindOf({ _tag: tag }), tag).toBe("unauthorized");
    }
    expect(kindOf({ _tag: "ResponseError", response: { status: 403 } })).toBe("unauthorized");
  });

  it("maps a timeout to unreachable", () => {
    expect(kindOf({ _tag: "TimeoutError" })).toBe("unreachable");
  });

  it("maps other environment errors to rejected", () => {
    for (const tag of [
      "EnvironmentInternalError",
      "EnvironmentRequestInvalidError",
      "EnvironmentResourceNotFoundError",
    ]) {
      expect(kindOf({ _tag: tag }), tag).toBe("rejected");
    }
  });

  it("maps anything unknown to unreachable", () => {
    for (const error of [
      new Error("socket hang up"),
      { _tag: "TransportError" },
      { _tag: "ResponseError", response: { status: 500 } },
      null,
      undefined,
      "boom",
    ]) {
      expect(kindOf(error)).toBe("unreachable");
    }
  });

  it("passes a PeerError through unchanged", () => {
    const error = new PeerError({ kind: "wrong-environment", detail: "Different server." });
    expect(classifyPeerFailure(error)).toBe(error);
  });
});

// ── HTTP ───────────────────────────────────────────────────────────

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string | null => {
  const body = request.body;
  switch (body._tag) {
    case "Uint8Array":
      return new TextDecoder().decode(body.body);
    case "Raw":
      return typeof body.body === "string" ? body.body : String(body.body);
    default:
      return null;
  }
};

/** A fake peer: each request is recorded and answered by `respond`. */
const fakePeer = (
  respond: (request: Recorded) => { readonly status: number; readonly body: unknown },
) => {
  const requests: Array<Recorded> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const recorded: Recorded = {
        method: request.method,
        url: url.toString(),
        headers: request.headers,
        body: bodyText(request),
      };
      requests.push(recorded);
      const { status, body } = respond(recorded);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  return { requests, layer };
};

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "env-mini",
  label: "Mac Mini",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.40",
  orchestrationProtocolVersion: AGENT_MACHINE_PROTOCOL_VERSION,
  capabilities: {},
  ...overrides,
});

const authInvalid = {
  _tag: "EnvironmentAuthInvalidError",
  code: "auth_invalid",
  reason: "invalid_credential",
  traceId: "trace-1",
};

describe("fetchPeerDescriptor and requirePeerIdentity", () => {
  it.effect("reads the descriptor from the well-known route", () => {
    const peer = fakePeer(() => ({ status: 200, body: descriptor() }));
    return Effect.gen(function* () {
      const result = yield* fetchPeerDescriptor(BASE_URL);
      expect(result.environmentId).toBe("env-mini");
      expect(result.label).toBe("Mac Mini");
      expect(peer.requests.map((r) => [r.method, r.url])).toEqual([
        ["GET", `${BASE_URL}/.well-known/t3/environment`],
      ]);
      expect(peer.requests[0]!.headers["authorization"]).toBeUndefined();
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect("reads a descriptor without a protocol version as protocol 1", () => {
    const { orchestrationProtocolVersion: _omit, ...legacy } = descriptor();
    const peer = fakePeer(() => ({ status: 200, body: legacy }));
    return fetchPeerDescriptor(BASE_URL).pipe(
      Effect.map((result) => expect(result.environmentId).toBe("env-mini")),
      Effect.provide(peer.layer),
    );
  });

  it.effect("refuses a peer that speaks another orchestration protocol", () => {
    const peer = fakePeer(() => ({
      status: 200,
      body: descriptor({ orchestrationProtocolVersion: AGENT_MACHINE_PROTOCOL_VERSION + 1 }),
    }));
    return Effect.gen(function* () {
      const failure = yield* failureOf(fetchPeerDescriptor(BASE_URL));
      expect(failure.kind).toBe("incompatible");
      expect(failure.detail).toContain(`protocol ${AGENT_MACHINE_PROTOCOL_VERSION + 1}`);
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect(
    "requirePeerIdentity passes for the linked environment id and fails for another",
    () => {
      const peer = fakePeer(() => ({ status: 200, body: descriptor() }));
      return Effect.gen(function* () {
        const ok = yield* requirePeerIdentity(BASE_URL, "env-mini");
        expect(ok.environmentId).toBe("env-mini");
        const failure = yield* failureOf(requirePeerIdentity(BASE_URL, "env-studio"));
        expect(failure.kind).toBe("wrong-environment");
      }).pipe(Effect.provide(peer.layer));
    },
  );

  it.effect("an unreadable descriptor is unreachable, not a crash", () => {
    const peer = fakePeer(() => ({ status: 200, body: { hello: "world" } }));
    return failureOf(fetchPeerDescriptor(BASE_URL)).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("unreachable")),
      Effect.provide(peer.layer),
    );
  });
});

describe("exchangePairingCredential", () => {
  it.effect("posts a form-encoded exchange for read and operate only", () => {
    const peer = fakePeer(() => ({
      status: 200,
      body: {
        access_token: "session-token",
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: AGENT_MACHINE_SCOPE,
      },
    }));
    return Effect.gen(function* () {
      const result = yield* exchangePairingCredential({
        baseUrl: BASE_URL,
        credential: "PAIRING-SECRET",
        clientLabel: "Coordinator on MacBook",
      });
      expect(result).toEqual({ token: "session-token", expiresInSeconds: 2_592_000 });

      expect(peer.requests).toHaveLength(1);
      const request = peer.requests[0]!;
      expect([request.method, request.url]).toEqual(["POST", `${BASE_URL}/oauth/token`]);
      expect(request.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      const form = new URLSearchParams(request.body ?? "");
      expect(Object.fromEntries(form)).toEqual({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: "PAIRING-SECRET",
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope: "orchestration:read orchestration:operate",
        client_label: "Coordinator on MacBook",
      });
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect("refuses a DPoP-bound token it cannot use", () => {
    const peer = fakePeer(() => ({
      status: 200,
      body: {
        access_token: "dpop-token",
        issued_token_type: AuthAccessTokenType,
        token_type: "DPoP",
        expires_in: 60,
        scope: AGENT_MACHINE_SCOPE,
      },
    }));
    return failureOf(
      exchangePairingCredential({ baseUrl: BASE_URL, credential: "c", clientLabel: "home" }),
    ).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("rejected")),
      Effect.provide(peer.layer),
    );
  });

  it.effect("a rejected credential (401) is unauthorized", () => {
    const peer = fakePeer(() => ({ status: 401, body: authInvalid }));
    return failureOf(
      exchangePairingCredential({ baseUrl: BASE_URL, credential: "used", clientLabel: "home" }),
    ).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("unauthorized")),
      Effect.provide(peer.layer),
    );
  });
});

const emptyShell = {
  snapshotSequence: 7,
  projects: [],
  threads: [],
  updatedAt: "2026-09-29T12:00:00.000Z",
};

describe("fetchPeerShell", () => {
  it.effect("sends the bearer token to the shell route", () => {
    const peer = fakePeer(() => ({ status: 200, body: emptyShell }));
    return Effect.gen(function* () {
      const shell = yield* fetchPeerShell(BASE_URL, "session-token");
      expect(shell.snapshotSequence).toBe(7);
      expect(peer.requests.map((r) => [r.method, r.url])).toEqual([
        ["GET", `${BASE_URL}/api/orchestration/shell`],
      ]);
      expect(peer.requests[0]!.headers["authorization"]).toBe("Bearer session-token");
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect("an expired token (401) is unauthorized", () => {
    const peer = fakePeer(() => ({ status: 401, body: authInvalid }));
    return failureOf(fetchPeerShell(BASE_URL, "expired")).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("unauthorized")),
      Effect.provide(peer.layer),
    );
  });

  it.effect("a missing scope (403) is unauthorized", () => {
    const peer = fakePeer(() => ({
      status: 403,
      body: {
        _tag: "EnvironmentScopeRequiredError",
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId: "trace-2",
      },
    }));
    return failureOf(fetchPeerShell(BASE_URL, "read-less")).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("unauthorized")),
      Effect.provide(peer.layer),
    );
  });

  it.effect("a peer that never answers is unreachable after the request timeout", () =>
    Effect.gen(function* () {
      const silent = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      );
      const fiber = yield* fetchPeerShell(BASE_URL, "t").pipe(
        Effect.flip,
        Effect.provide(silent),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.sum(PEER_REQUEST_TIMEOUT, Duration.millis(1)));
      const error = yield* Fiber.join(fiber);
      expect(error.kind).toBe("unreachable");
    }),
  );
});

describe("dispatchPeerCommand", () => {
  it.effect("refuses a command outside the allowlist without any HTTP call", () => {
    const peer = fakePeer(() => ({ status: 200, body: { sequence: 1 } }));
    return Effect.gen(function* () {
      for (const type of ["thread.delete", "project.delete", "project.create"]) {
        const failure = yield* failureOf(
          dispatchPeerCommand(BASE_URL, "token", command(type) as PeerCommand),
        );
        expect(failure.kind).toBe("rejected");
        expect(failure.detail).toContain(type);
      }
      assert.strictEqual(peer.requests.length, 0);
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect("posts an allowed command as JSON with the bearer token", () => {
    const peer = fakePeer(() => ({ status: 200, body: { sequence: 12 } }));
    const stop = {
      type: "thread.session.stop",
      commandId: CommandId.make("cp-remote:stop-1"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-09-29T12:00:00.000Z",
    } satisfies PeerCommand;
    return Effect.gen(function* () {
      yield* dispatchPeerCommand(BASE_URL, "session-token", stop);
      expect(peer.requests).toHaveLength(1);
      const request = peer.requests[0]!;
      expect([request.method, request.url]).toEqual([
        "POST",
        `${BASE_URL}/api/orchestration/dispatch`,
      ]);
      expect(request.headers["authorization"]).toBe("Bearer session-token");
      expect(decodeJson(request.body ?? "null")).toEqual(stop);
    }).pipe(Effect.provide(peer.layer));
  });

  it.effect("an opaque peer failure (500) is rejected", () => {
    const peer = fakePeer(() => ({
      status: 500,
      body: {
        _tag: "EnvironmentInternalError",
        code: "internal_error",
        reason: "orchestration_dispatch_failed",
        traceId: "trace-3",
      },
    }));
    return failureOf(
      dispatchPeerCommand(BASE_URL, "t", command("thread.archive") as PeerCommand),
    ).pipe(
      Effect.map((failure) => expect(failure.kind).toBe("rejected")),
      Effect.provide(peer.layer),
    );
  });
});

describe("fetchPeerThread", () => {
  it.effect("is none when the peer has no such thread", () => {
    const peer = fakePeer(() => ({
      status: 404,
      body: {
        _tag: "EnvironmentResourceNotFoundError",
        code: "not_found",
        reason: "thread_not_found",
        traceId: "trace-4",
      },
    }));
    return Effect.gen(function* () {
      const result = yield* fetchPeerThread(BASE_URL, "session-token", "thread-9", 3);
      expect(Option.isNone(result)).toBe(true);
      const url = new URL(peer.requests[0]!.url);
      expect(url.pathname).toBe("/api/orchestration/threads/thread-9");
      expect(url.searchParams.get("turnLimit")).toBe("3");
      expect(peer.requests[0]!.headers["authorization"]).toBe("Bearer session-token");
    }).pipe(Effect.provide(peer.layer));
  });
});
