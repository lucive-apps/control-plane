/**
 * Linked machines: linking, tokens, health, and the inputs placement needs.
 * The bearer token lives in the secret store, never in settings, and is sent
 * only after the peer's descriptor proves it is still the machine that was
 * linked. Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module AgentMachines
 */
import {
  LOCAL_AGENT_MACHINE,
  AgentMachinesError,
  type AgentMachineConfig,
  type AgentPlacementSettings,
  type AgentMachinesInput,
  type AgentMachinesResult,
  type AgentMachineStatus,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  dispatchPeerCommand,
  exchangePairingCredential,
  fetchPeerDescriptor,
  fetchPeerShell,
  fetchPeerThread,
  PeerError,
  requirePeerIdentity,
  validatePeerBaseUrl,
  type PeerCommand,
} from "./AgentMachineClient.ts";
import { type PlacementCandidate } from "./placement.ts";
import { matchPeerProject, type ProjectMatch } from "./projectMatch.ts";
import { PLACEMENT_GRACE_MS, machineLoad } from "./remoteAgentState.ts";
import { RemoteAgentStore } from "./RemoteAgentStore.ts";
import { isAgentCountedRunning } from "../mcp/toolkits/agents/agentScope.ts";

const SNAPSHOT_TTL_MS = 5_000;
/** A machine that failed a probe is not retried this soon. */
const OFFLINE_TTL_MS = 30_000;
const IDENTITY_TTL_MS = 60_000;

const TokenSecret = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const TokenSecretJson = Schema.fromJsonString(TokenSecret);
const decodeTokenSecret = Schema.decodeUnknownOption(TokenSecretJson);
const encodeTokenSecret = Schema.encodeSync(TokenSecretJson);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encoded like `usageLimitSourceSecretName`: the id comes from the peer and names a file. */
export const agentMachineSecretName = (machineId: string): string =>
  `agent-machine-token-${Buffer.from(machineId, "utf8").toString("base64url")}`;

export interface HomeProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
}

export interface PlacementInputs {
  readonly settings: AgentPlacementSettings;
  /** The settings put every agent on this machine, so no linked machine was probed. */
  readonly localOnly: boolean;
  readonly candidates: ReadonlyArray<PlacementCandidate>;
  /** The matching Project on each reachable linked machine. */
  readonly peerProjectIds: ReadonlyMap<string, string>;
}

export interface AgentMachinesShape {
  readonly manage: (
    input: AgentMachinesInput,
  ) => Effect.Effect<AgentMachinesResult, AgentMachinesError>;
  /** This machine plus every enabled linked machine, with reachability, Project match and load. */
  readonly placementInputs: (
    project: HomeProject,
    options: { readonly requested: string | undefined },
  ) => Effect.Effect<PlacementInputs, AgentMachinesError>;
  /** Cached for a few seconds unless `fresh`; the bridge polls fresh. */
  readonly shell: (
    machineId: string,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<OrchestrationShellSnapshot, PeerError>;
  readonly thread: (
    machineId: string,
    threadId: string,
    turnLimit: number,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, PeerError>;
  readonly dispatch: (machineId: string, command: PeerCommand) => Effect.Effect<void, PeerError>;
  /** Marks a machine as needing a fresh link after the peer refused its token. */
  readonly markNeedsRelink: (machineId: string) => Effect.Effect<void>;
  readonly isReachable: (machineId: string) => Effect.Effect<boolean>;
  /** How this machine is named to a linked one. */
  readonly homeLabel: Effect.Effect<string>;
}

export class AgentMachines extends Context.Service<AgentMachines, AgentMachinesShape>()(
  "t3/agentMachines/AgentMachines",
) {}

interface Health {
  status: AgentMachineStatus["status"];
  detail?: string;
  checkedAtMs: number;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const store = yield* RemoteAgentStore;
  const httpClient = yield* HttpClient.HttpClient;

  const health = new Map<string, Health>();
  const shells = new Map<string, { snapshot: OrchestrationShellSnapshot; atMs: number }>();
  const identities = new Map<string, number>();

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const placementSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.agentPlacement),
    Effect.mapError(() => new AgentMachinesError({ detail: "Could not read settings." })),
  );

  const readToken = (machineId: string) =>
    secrets.get(agentMachineSecretName(machineId)).pipe(
      Effect.map((bytes) =>
        Option.flatMap(bytes, (value) => decodeTokenSecret(textDecoder.decode(value))),
      ),
      Effect.mapError(
        () => new PeerError({ kind: "unauthorized", detail: "Could not read the stored token." }),
      ),
    );

  const machineConfig = (machineId: string) =>
    settingsService.getSettings.pipe(
      Effect.map((settings) => settings.agentPlacement.machines[machineId]),
      Effect.mapError(
        () => new PeerError({ kind: "unreachable", detail: "Could not read settings." }),
      ),
      Effect.flatMap((config) =>
        config === undefined
          ? Effect.fail(new PeerError({ kind: "rejected", detail: "That machine is not linked." }))
          : Effect.succeed(config),
      ),
    );

  const record = (machineId: string, next: Omit<Health, "checkedAtMs">) =>
    nowMs.pipe(
      Effect.tap((at) => Effect.sync(() => health.set(machineId, { ...next, checkedAtMs: at }))),
    );

  /** Runs `use` against a linked machine after its identity is confirmed, keeping health current. */
  const withPeer = <A>(
    machineId: string,
    use: (peer: {
      baseUrl: string;
      token: string;
      config: AgentMachineConfig;
    }) => Effect.Effect<A, PeerError, HttpClient.HttpClient>,
  ): Effect.Effect<A, PeerError> =>
    Effect.gen(function* () {
      const config = yield* machineConfig(machineId);
      const stored = yield* readToken(machineId);
      if (Option.isNone(stored)) {
        yield* record(machineId, { status: "needs-relink", detail: "No stored token." });
        return yield* new PeerError({
          kind: "unauthorized",
          detail: "This machine needs to be linked again.",
        });
      }
      const verifiedAt = identities.get(machineId);
      const now = yield* nowMs;
      if (verifiedAt === undefined || now - verifiedAt > IDENTITY_TTL_MS) {
        yield* requirePeerIdentity(config.baseUrl, machineId);
        identities.set(machineId, now);
      }
      const result = yield* use({ baseUrl: config.baseUrl, token: stored.value.token, config });
      yield* record(machineId, { status: "connected" });
      return result;
    }).pipe(
      withHttp,
      Effect.tapError((error) =>
        record(machineId, {
          status:
            error.kind === "unauthorized"
              ? "needs-relink"
              : error.kind === "incompatible"
                ? "incompatible"
                : error.kind === "wrong-environment"
                  ? "wrong-environment"
                  : "offline",
          detail: error.detail,
        }).pipe(Effect.tap(() => Effect.sync(() => identities.delete(machineId)))),
      ),
    );

  const shell: AgentMachinesShape["shell"] = (machineId, options) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const cached = shells.get(machineId);
      if (options?.fresh !== true && cached !== undefined && now - cached.atMs < SNAPSHOT_TTL_MS) {
        return cached.snapshot;
      }
      const failed = health.get(machineId);
      if (
        options?.fresh !== true &&
        failed !== undefined &&
        failed.status !== "connected" &&
        now - failed.checkedAtMs < OFFLINE_TTL_MS
      ) {
        return yield* new PeerError({
          kind: failed.status === "needs-relink" ? "unauthorized" : "unreachable",
          detail: failed.detail ?? "The linked machine is unavailable.",
        });
      }
      const snapshot = yield* withPeer(machineId, ({ baseUrl, token }) =>
        fetchPeerShell(baseUrl, token),
      );
      shells.set(machineId, { snapshot, atMs: now });
      return snapshot;
    });

  const localLoad = Effect.gen(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    return snapshot.threads.filter(
      (thread) => thread.archivedAt === null && isAgentCountedRunning(thread, now),
    ).length;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

  const ineligibleReason = (match: ProjectMatch, projectTitle: string): string | null => {
    switch (match.kind) {
      case "matched":
        return null;
      case "missing":
        return `no Project named ${projectTitle} on that machine`;
      case "ambiguous":
        return `${match.count} Projects match ${projectTitle} on that machine`;
    }
  };

  const placementInputs: AgentMachinesShape["placementInputs"] = (project, options) =>
    Effect.gen(function* () {
      const settings = yield* placementSettings;
      const localCandidate = Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        return {
          id: LOCAL_AGENT_MACHINE,
          label: descriptor.label,
          ineligibleReason: null,
          load: yield* localLoad,
        } satisfies PlacementCandidate;
      });
      // Every agent stays here unless the caller names a machine: no probes.
      if (settings.mode === "local" && options.requested === undefined) {
        return {
          settings,
          localOnly: true,
          candidates: [yield* localCandidate],
          peerProjectIds: new Map<string, string>(),
        } satisfies PlacementInputs;
      }
      const records = yield* store.list.pipe(
        Effect.mapError(() => new AgentMachinesError({ detail: "Could not read remote agents." })),
      );
      const now = yield* nowMs;
      const wanted = options.requested?.trim().toLowerCase();
      const enabled = Object.entries(settings.machines).filter(
        ([id, config]) =>
          config.enabled &&
          (settings.mode === "balanced" ||
            (options.requested !== undefined
              ? id.toLowerCase() === wanted || config.label.toLowerCase() === wanted
              : id === settings.singleMachineId)),
      );
      const peerProjectIds = new Map<string, string>();
      const remote = yield* Effect.forEach(
        enabled,
        ([id, config]) =>
          shell(id).pipe(
            Effect.map((snapshot): PlacementCandidate => {
              const match = matchPeerProject(project, snapshot.projects);
              if (match.kind === "matched") peerProjectIds.set(id, match.projectId);
              const recent = records.filter(
                (agent) =>
                  agent.machineId === id &&
                  agent.state !== "lost" &&
                  now - DateTime.toEpochMillis(DateTime.makeUnsafe(agent.createdAt)) <
                    PLACEMENT_GRACE_MS,
              );
              return {
                id,
                label: config.label,
                ineligibleReason: ineligibleReason(match, project.title),
                load: machineLoad({ snapshot, recentPlacements: recent }),
              };
            }),
            Effect.catch((error) =>
              Effect.succeed<PlacementCandidate>({
                id,
                label: config.label,
                ineligibleReason:
                  error.kind === "unauthorized" ? "needs to be linked again" : error.detail,
                load: 0,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return {
        settings,
        localOnly: false,
        candidates: [yield* localCandidate, ...remote],
        peerProjectIds,
      } satisfies PlacementInputs;
    });

  const statusOf = (machineId: string, homeProjects: ReadonlyArray<HomeProject>) =>
    Effect.gen(function* () {
      // A check always probes, so a machine that came back shows as connected.
      health.delete(machineId);
      shells.delete(machineId);
      const outcome = yield* Effect.result(shell(machineId));
      const stored = yield* readToken(machineId).pipe(
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      const tokenExpiresAt = Option.match(stored, {
        onNone: () => undefined,
        onSome: (v) => v.expiresAt,
      });
      if (outcome._tag === "Failure") {
        const known = health.get(machineId);
        return {
          id: machineId,
          status: known?.status ?? "offline",
          detail: outcome.failure.detail,
          ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
          matchedProjectCount: 0,
          projectCount: homeProjects.length,
        } satisfies AgentMachineStatus;
      }
      const matched = homeProjects.filter(
        (project) => matchPeerProject(project, outcome.success.projects).kind === "matched",
      ).length;
      return {
        id: machineId,
        status: "connected",
        ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
        matchedProjectCount: matched,
        projectCount: homeProjects.length,
      } satisfies AgentMachineStatus;
    });

  const check = Effect.gen(function* () {
    const settings = yield* placementSettings;
    const local = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError(() => new AgentMachinesError({ detail: "Could not read Projects." })));
    const homeProjects = local.projects.filter(
      (project) => project.assistant?.archivedAt == null && project.assistant != null,
    );
    return yield* Effect.forEach(
      Object.keys(settings.machines),
      (id) => statusOf(id, homeProjects),
      { concurrency: "unbounded" },
    );
  });

  const link = (input: Extract<AgentMachinesInput, { action: "link" }>) =>
    Effect.gen(function* () {
      const fail = (detail: string) => new AgentMachinesError({ detail });
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl: input.pairingUrl }),
        catch: () => fail("That is not a valid pairing link. Create one on the other machine."),
      });
      const asPeerFailure = Effect.mapError((error: PeerError) => fail(error.detail));
      const baseUrl = yield* validatePeerBaseUrl(input.baseUrl ?? target.httpBaseUrl).pipe(
        asPeerFailure,
      );
      const descriptor = yield* withHttp(fetchPeerDescriptor(baseUrl)).pipe(asPeerFailure);
      const selfId = yield* environment.getEnvironmentId;
      if (descriptor.environmentId === selfId) {
        return yield* fail("That link points at this machine.");
      }
      const exchanged = yield* withHttp(
        exchangePairingCredential({
          baseUrl,
          credential: target.credential,
          clientLabel: `Agent placement from ${(yield* environment.getDescriptor).label}`,
        }),
      ).pipe(asPeerFailure);
      const now = yield* DateTime.now;
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { seconds: exchanged.expiresInSeconds }),
      );
      const secretName = agentMachineSecretName(descriptor.environmentId);
      yield* secrets
        .set(
          secretName,
          textEncoder.encode(encodeTokenSecret({ token: exchanged.token, expiresAt })),
        )
        .pipe(Effect.mapError(() => fail("Could not store the machine's token.")));
      const existing = (yield* placementSettings).machines[descriptor.environmentId];
      yield* settingsService
        .updateSettings({
          agentPlacement: {
            machines: {
              [descriptor.environmentId]: {
                label: existing?.label ?? descriptor.label,
                baseUrl,
                enabled: existing?.enabled ?? true,
                preference: existing?.preference ?? 50,
              },
            },
          },
        })
        .pipe(
          Effect.tapError(() => secrets.remove(secretName).pipe(Effect.ignore)),
          Effect.mapError(() => fail("Could not save the machine.")),
        );
      health.delete(descriptor.environmentId);
      shells.delete(descriptor.environmentId);
      identities.delete(descriptor.environmentId);
      return { id: descriptor.environmentId, label: descriptor.label };
    });

  const unlink = (id: string) =>
    Effect.gen(function* () {
      const fail = (detail: string) => new AgentMachinesError({ detail });
      yield* settingsService
        .updateSettings({ agentPlacement: { machines: { [id]: null } } })
        .pipe(Effect.mapError(() => fail("Could not save settings.")));
      yield* secrets.remove(agentMachineSecretName(id)).pipe(Effect.ignore);
      const at = DateTime.formatIso(yield* DateTime.now);
      const records = yield* store.list.pipe(Effect.orElseSucceed(() => []));
      for (const agent of records) {
        if (agent.machineId !== id || agent.state === "lost") continue;
        yield* store
          .update(agent.threadId, (current) => ({ ...current, state: "lost", endedAt: at }))
          .pipe(Effect.ignore);
      }
      health.delete(id);
      shells.delete(id);
      identities.delete(id);
    });

  const manage: AgentMachinesShape["manage"] = (input) =>
    Effect.gen(function* () {
      switch (input.action) {
        case "link": {
          const linked = yield* link(input);
          return { linked, machines: yield* check };
        }
        case "unlink": {
          yield* unlink(input.id);
          return { machines: yield* check };
        }
        case "check":
          return { machines: yield* check };
      }
    });

  return {
    manage,
    placementInputs,
    shell,
    thread: (machineId, threadId, turnLimit) =>
      withPeer(machineId, ({ baseUrl, token }) =>
        fetchPeerThread(baseUrl, token, threadId, turnLimit),
      ),
    dispatch: (machineId, command) =>
      withPeer(machineId, ({ baseUrl, token }) => dispatchPeerCommand(baseUrl, token, command)),
    markNeedsRelink: (machineId) =>
      record(machineId, {
        status: "needs-relink",
        detail: "The linked machine refused the token.",
      }).pipe(Effect.asVoid),
    homeLabel: environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
    isReachable: (machineId) =>
      Effect.sync(() => health.get(machineId)?.status).pipe(
        Effect.map((status) => status === undefined || status === "connected"),
      ),
  } satisfies AgentMachinesShape;
});

export const AgentMachinesLive = Layer.effect(AgentMachines, make);
