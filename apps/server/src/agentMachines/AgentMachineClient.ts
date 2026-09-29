/**
 * The home server's HTTP client for a linked machine. It uses only the
 * environment routes every server already serves, with a bearer token limited
 * to `orchestration:read orchestration:operate`. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module AgentMachineClient
 */
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  type ClientOrchestrationCommand,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

/** Orchestration protocol this build speaks; a peer that differs is refused. */
export const AGENT_MACHINE_PROTOCOL_VERSION = 1;
export const PEER_REQUEST_TIMEOUT = Duration.seconds(3);
export const AGENT_MACHINE_SCOPE = `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`;

export class PeerError extends Schema.TaggedError<PeerError>()("PeerError", {
  kind: Schema.Literals([
    "invalid-url",
    "unreachable",
    "unauthorized",
    "incompatible",
    "wrong-environment",
    "rejected",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * The origin to talk to: https, or http to a loopback, private-range or
 * tailnet host. The path, query and fragment (a pairing token) are dropped.
 */
export function validatePeerBaseUrl(raw: string): Effect.Effect<string, PeerError> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return Effect.fail(
      new PeerError({ kind: "invalid-url", detail: "That is not a valid address." }),
    );
  }
  const secure = url.protocol === "https:";
  const privateHttp =
    url.protocol === "http:" &&
    (isLocalLoopbackHost(url.hostname) || isPrivateNetworkHost(url.hostname));
  if (!secure && !privateHttp) {
    return Effect.fail(
      new PeerError({
        kind: "invalid-url",
        detail:
          "Use https, or http to a machine on your tailnet or private network. Plain http over the internet is refused.",
      }),
    );
  }
  return Effect.succeed(url.origin);
}

/** Allowed over the peer client: anything else could delete or rewrite the peer's work. */
export const PEER_COMMAND_ALLOWLIST = [
  "thread.create",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.session.stop",
  "thread.archive",
  "thread.settle",
] as const satisfies ReadonlyArray<ClientOrchestrationCommand["type"]>;

export type PeerCommand = Extract<
  ClientOrchestrationCommand,
  { type: (typeof PEER_COMMAND_ALLOWLIST)[number] }
>;

export const isPeerCommand = (command: ClientOrchestrationCommand): command is PeerCommand =>
  (PEER_COMMAND_ALLOWLIST as ReadonlyArray<string>).includes(command.type);

const noRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const isPeerError = Schema.is(PeerError);

/** Maps any transport or HTTP failure to a `PeerError`. Peer dispatch errors are opaque 500s. */
export function classifyPeerFailure(error: unknown): PeerError {
  if (isPeerError(error)) return error;
  const tag = (error as { readonly _tag?: string } | null)?._tag ?? "";
  const status = (error as { readonly response?: { readonly status?: number } } | null)?.response
    ?.status;
  if (
    tag === "EnvironmentAuthInvalidError" ||
    tag === "EnvironmentHttpUnauthorizedError" ||
    status === 401
  ) {
    return new PeerError({
      kind: "unauthorized",
      detail: "The linked machine rejected the token.",
    });
  }
  if (
    tag === "EnvironmentScopeRequiredError" ||
    tag === "EnvironmentOperationForbiddenError" ||
    tag === "EnvironmentHttpForbiddenError" ||
    status === 403
  ) {
    return new PeerError({
      kind: "unauthorized",
      detail: "The linked machine refused the token's access.",
    });
  }
  if (tag === "TimeoutError") {
    return new PeerError({
      kind: "unreachable",
      detail: "The linked machine did not answer in time.",
    });
  }
  if (tag.startsWith("Environment")) {
    return new PeerError({ kind: "rejected", detail: "The linked machine rejected the request." });
  }
  return new PeerError({ kind: "unreachable", detail: "Could not reach the linked machine." });
}

const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout(PEER_REQUEST_TIMEOUT),
    noRedirects,
    Effect.mapError(classifyPeerFailure),
  );

const makeClient = (baseUrl: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl });

/** The peer's own descriptor. Its environment id is checked before any token is sent. */
export const fetchPeerDescriptor = (
  baseUrl: string,
): Effect.Effect<ExecutionEnvironmentDescriptor, PeerError, HttpClient.HttpClient> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      const descriptor = yield* client.metadata.descriptor();
      const version = descriptor.orchestrationProtocolVersion ?? 1;
      if (version !== AGENT_MACHINE_PROTOCOL_VERSION) {
        return yield* new PeerError({
          kind: "incompatible",
          detail: `The linked machine speaks protocol ${version}; this machine speaks ${AGENT_MACHINE_PROTOCOL_VERSION}. Update the older one.`,
        });
      }
      return descriptor;
    }),
  );

/** Confirms the server at `baseUrl` is still the machine that was linked. */
export const requirePeerIdentity = (baseUrl: string, environmentId: string) =>
  fetchPeerDescriptor(baseUrl).pipe(
    Effect.flatMap((descriptor) =>
      descriptor.environmentId === environmentId
        ? Effect.succeed(descriptor)
        : Effect.fail(
            new PeerError({
              kind: "wrong-environment",
              detail: "A different server answers at this address. Link the machine again.",
            }),
          ),
    ),
  );

/** Trades a pairing credential for a bearer session limited to read and operate. */
export const exchangePairingCredential = (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly clientLabel: string;
}) =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(input.baseUrl);
      const result = yield* client.auth.token({
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: input.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: AGENT_MACHINE_SCOPE,
          client_label: input.clientLabel,
        },
        headers: {},
      } as Parameters<typeof client.auth.token>[0]);
      if (result.token_type !== "Bearer") {
        return yield* new PeerError({
          kind: "rejected",
          detail: "The linked machine issued a token this machine cannot use.",
        });
      }
      return {
        token: result.access_token,
        expiresInSeconds: result.expires_in,
      };
    }),
  );

export const fetchPeerShell = (
  baseUrl: string,
  token: string,
): Effect.Effect<OrchestrationShellSnapshot, PeerError, HttpClient.HttpClient> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration.shellSnapshot({ headers: bearer(token) });
    }),
  );

/** None when the peer has no such thread. */
export const fetchPeerThread = (
  baseUrl: string,
  token: string,
  threadId: string,
  turnLimit: number,
): Effect.Effect<
  Option.Option<OrchestrationThreadDetailSnapshot>,
  PeerError,
  HttpClient.HttpClient
> =>
  call(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.orchestration
        .threadSnapshot({
          headers: bearer(token),
          params: { threadId },
          payload: { turnLimit },
        } as Parameters<typeof client.orchestration.threadSnapshot>[0])
        .pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) =>
              (error as { readonly _tag?: string })._tag === "EnvironmentResourceNotFoundError",
            () => Effect.succeed(Option.none<OrchestrationThreadDetailSnapshot>()),
          ),
        );
    }),
  ) as Effect.Effect<
    Option.Option<OrchestrationThreadDetailSnapshot>,
    PeerError,
    HttpClient.HttpClient
  >;

/**
 * Sends one allowlisted command. The peer answers every failure with an opaque
 * 500, so a failure here means "unknown": read the thread to learn what
 * happened, and retry with the same command id.
 */
export const dispatchPeerCommand = (baseUrl: string, token: string, command: PeerCommand) =>
  isPeerCommand(command)
    ? call(
        Effect.gen(function* () {
          const client = yield* makeClient(baseUrl);
          yield* client.orchestration.dispatch({
            headers: bearer(token),
            payload: command,
          } as Parameters<typeof client.orchestration.dispatch>[0]);
        }),
      )
    : Effect.fail(
        new PeerError({
          kind: "rejected",
          detail: `Command ${(command as { type: string }).type} is not allowed on a linked machine.`,
        }),
      );
