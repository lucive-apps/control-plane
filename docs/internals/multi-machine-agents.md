# Multi-machine agents

A coordinator (or a standing agent) can start one-off agents on another machine linked to its own
server, such as a Mac Mini on the same tailnet. Where a new agent runs follows a server-owned
setting. Code: `apps/server/src/agentMachines/` and `apps/server/src/mcp/toolkits/agents/`.

## What exists today

- **One server, one event log.** A Project and its threads belong to one environment
  ([remote](./remote.md)). Servers never call each other; only clients hold connections to several.
  So `cp_agent_create` can only dispatch to the local engine (`handlers.ts`).
- **Client load balancing is invisible to the server.** `loadBalancingEnabled` and
  `loadBalancingWeights` are client settings that pick an environment for a composer draft
  (`ChatView.tsx`, `load-balancing.ts`). An MCP call has no client, so agent placement needs
  server-owned settings.
- **Every server already exposes an authenticated HTTP surface:** `GET /api/orchestration/shell`,
  `GET /api/orchestration/threads/:id`, `POST /api/orchestration/dispatch`
  (`orchestration/http.ts`), scoped `orchestration:read` and `orchestration:operate`. The `t3
project` CLI already drives a server this way.
- **Results are a local ledger.** `AgentCompletionReactor` reads finished requests from the local
  projection, appends `cp-push:<agent>:<request>` into the recipient, and starts it when idle. The
  per-Project cap (`AGENT_RUNNING_CAP`, 10) counts local threads only.
- **T3 Connect is off** (`forkFeatures.ts`); machines reach each other over Tailscale and pairing
  links.

## Model

The coordinator's server (the **home**) is an HTTP client of a **peer** server. A remote agent is
a normal thread in a matching Project on the peer, so it runs and shows in that machine's UI like
any thread. The home keeps a **remote agent registry** so it can list, read, stop, message and
collect results. Nothing is added to the peer, so any peer that serves the three routes works.

## Settings

Server-owned, on `ServerSettings.agentPlacement` (schema in a fork-owned contracts module so the
upstream settings file gains one line). Defaults keep today's behaviour.

```ts
agentPlacement: {
  mode: "local" | "single" | "balanced"; // default "local"
  singleMachineId: string | null; // "single": a machine id, or "local"
  localPreference: 0 | 25 | 50 | 100; // this machine's weight in "balanced"
  allowLocalFallback: boolean; // default true
  machines: Record<
    string,
    {
      // keyed by the peer's environmentId
      label: string;
      baseUrl: string; // https, or http to a loopback/private/tailnet host
      enabled: boolean;
      preference: 0 | 25 | 50 | 100;
    }
  >;
}
```

- **`machines` is a per-entry map in the patch,** like `usageLimitSources`: `null` removes an
  entry. A whole array would be replaced by a patch and race with link and unlink. The token is
  bound to the machine id, and it is sent only after the peer's descriptor proves that id, so a
  patched `baseUrl` cannot redirect it to another server.
- **Preferences reuse the existing vocabulary:** Prefer 100, Normal 50, Less often 25, Manual only 0. Manual only excludes a machine from automatic choice; it can still be named explicitly.
- **The bearer token is never in settings.** It lives in `ServerSecretStore` under
  `agent-machine-token-<base64url(id)>` (the id comes from the peer, so it is encoded like
  `usageLimitSourceSecretName`) and is never returned over RPC. Unlink and failed link delete it.
- **`agentMachines` RPC** (`link`, `unlink`, `check`; scope `orchestration:operate`). `enabled`
  and `preference` are ordinary settings patches.
  `link` takes a pairing link and an optional `baseUrl` override (the link's address may not be
  reachable from the home). It exchanges the credential at `/oauth/token` with
  `scope=orchestration:read orchestration:operate` and a `client_label` naming the home, reads
  `/.well-known/t3/environment` for the id, label and versions, refuses a peer whose
  `orchestrationProtocolVersion` differs, stores the token and adds the entry (keeping an existing
  entry's `enabled`, `preference` and name). `unlink` removes the entry and token and marks that
  machine's agents lost. `check` probes each machine and returns status, token expiry and, per
  local Project, whether the peer has a matching Project.
- **The client Load balancing section is untouched.** It still governs composer drafts.

**UI.** A folded **Agent machines** section under Settings > Connections, built from
`FoldedSettingsSection`, `EnvironmentRow` and the preference `Select` used by Load balancing.
"Where new agents run" (This machine, One machine, Balance across machines), a machine picker for
One machine, a row per machine (this machine plus linked ones) with status, enabled switch and
preference, a fallback switch, and "Add machine" (pairing link). It edits the environment being
viewed, like Device hosts.

## Placement

Pure `placeAgent` in `agentMachines/placement.ts`. Inputs: settings, optional explicit `machine`,
per-candidate `{ reachable, load, projectMatch }`.

1. **Candidates:** this machine plus enabled linked machines.
2. **Eligible:** reachable, matching Project present (this machine always), and in `balanced`
   preference above 0 unless named explicitly.
3. **`local`:** this machine. **`single`:** the chosen machine if eligible.
4. **`balanced`:** minimize `(load + 1) / weight`. Ties: lower load, higher weight, this machine,
   then id. The order is total, so placement is deterministic.
5. **Nothing eligible:** fall back to this machine when `allowLocalFallback` and no explicit
   `machine` was given (the result carries a `placement` note); otherwise fail with each machine's
   reason. An explicit `machine` never falls back.

**Load** is running agents on the whole machine (`isAgentCountedRunning` over every non-archived
thread in the peer's shell snapshot) plus this home's placements from the last 2 minutes that the
snapshot does not yet show running, which spreads a burst of creates. Peer timestamps are
compared against the peer's own `snapshot` time, never the home clock, so skew does not matter.
Shell snapshots are cached 5 seconds per machine. **Cap:** one Project cap across machines: local
running agents in the Project plus remote agents whose polled phase is busy (or in the 2-minute
start window) stay under `AGENT_RUNNING_CAP`. **Offline:** probes time out at 3 seconds; a failed
probe makes the machine ineligible for 30 seconds and shows offline in settings.

Probing and placement run **outside** `createLock`, so a slow peer never blocks local creates.
Only the cap check and the registry write are inside it.

## The remote agent's Project, folder and context

The peer must already have the Project. Match by the same `repositoryIdentity.canonicalKey` when
the home Project has one, else the same title and folder basename. Zero or several matches make
the machine ineligible for that Project, with the reason in `check`. Nothing is created remotely.

The agent runs in the peer's folder and reads that machine's `AGENTS.md` and `CLAUDE.md`. Copies
can drift; the first message says which machine it is on and that edits stay there. Not built:
creating the Project on the peer and copying `AGENTS.md`, pushing a branch, a shared filesystem.

The peer thread starts Local with the peer Project's default model, else the home's selection; an
explicit `model` passes through. The home cannot list a peer's providers over HTTP, so an
unavailable model surfaces as a failed remote turn (see results). Because the peer's own
assistant rules apply, the create sends **no `createdByThreadId` and no `replyTo`** (both are
rejected on the peer for a thread the peer does not know), and the peer Project's coordinator, if
any, will see the thread as one of its agents and count it toward the peer's cap. Message ids sent
to the peer use a `cp-remote:` prefix, never `cp-send:`, `cp-push:` or `cp-schedule:`, so the
peer's own reactor never mistakes them for deliveries.

## Tool API

- `cp_agent_create` gains `machine?: string` (id, label or `"local"`). Bounded by settings:
  rejected when mode is `local`; in `single` only the chosen machine or `"local"`; in `balanced`
  any enabled, reachable, matched machine including Manual only ones.
- Result gains `machineLabel` (null for this machine) and `placement` (a note only when a fallback
  happened).
- `standing: true` stays on this machine; asking for a remote standing agent is an error.
- `cp_agent_list` entries gain `machine` (label or null).
- `cp_agent_read`, `cp_agent_stop`, `cp_thread_send` resolve a threadId or exact title across
  local and remote agents the caller manages; their parameters do not change.
- **Ownership** of a remote agent comes from the registry, as a managed-agent shape
  `{ id, projectId: home Project, pinnedAt: null, createdByThreadId: registry creator }` fed to the
  existing `canManageAgent`, because `lineage.creatorOf` reads the local event log.
- **Runtime mode** is `stricterRuntimeMode(...)` exactly as today, computed before anything leaves
  the home.

## Results, read, stop, send

**Client allowlist.** The home's peer client can dispatch only `thread.create`,
`thread.turn.start`, `thread.turn.interrupt`, `thread.session.stop`, `thread.archive` and
`thread.settle`. Peer dispatch errors are opaque (every failure is a 500), so any non-2xx or
timeout is treated as unknown and resolved by reading the thread; retries reuse the same command
ids, which the peer dedupes.

**RemoteAgentBridge.** One poll per machine with open records (every 3 seconds, jittered), reading
the shell snapshot, which carries each thread's `latestTurn`, `session`, pending flags and
`latestUserMessageAt`. Thread detail is fetched only when a record's state changes or for a read.

- **A request is done** (`judgeRequest`) when the session is not busy and either
  (a) the peer's `latestTurn` differs from the `baselineTurnId` recorded before the send and is
  terminal (the peer stores its own message times and does not say which message started a turn,
  so the turn is matched by identity, not by time); or
  (c) the session is `error`, or `stopped` for more than 15 seconds, with no newer turn. Case (c)
  reads the peer thread for its `provider.turn.start.failed` activity (matched on the request id)
  to report why, so a start failure such as an unavailable model comes back as a failed result.
- **Delivery.** The bridge appends `cp-push:<agentThreadId>:<requestId>` into the recipient with
  `formatAgentResult` and no `replyTo`; the command id is the message id, so receipts make it
  idempotent across restarts. Routing copies the reactor: the recipient if it is live in the same
  Project and may manage the agent, else the coordinator, and it holds while the Project's
  assistant is archived or unmarked or the recipient is archived. Then the bridge calls
  `AgentCompletionReactor.enqueue(projectId)`; without it an idle recipient would never start,
  because the reactor enqueues only for `cp-send:` and schedule appends. The peer thread is settled
  only when it is a one-off and the request is still its latest.
- **Read.** Maps the peer's messages and `latestTurn` to `AgentReadResult` with the same caps.
  Older turns have no state over HTTP, so their state is approximated as `completed`.
- **Stop.** Dispatches interrupt, session stop and optionally archive on the peer and marks the
  request suppressed so its result is not pushed.
- **Send.** An idle remote agent gets `thread.turn.start`; a busy one queues in the registry and
  the bridge starts it when the peer goes idle (`queued: true`, same meaning as today).
- **Registry** `remote-agents.json` in the state dir, atomic writes: machine id, peer thread and
  Project ids, creator, title, state (`pending`, `open`, `settled`, `lost`), request in flight,
  queued sends, last phase. Create order: look up the registry by the derived thread id first
  (before the local thread check and before placement, so a retry cannot land on another machine),
  place, write `pending`, dispatch, then `open`. A failed peer create removes the `pending` record.
  Records are pruned 7 days after settling.

## Failure modes

| Failure                                      | Behaviour                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Peer offline at create                       | Ineligible; fall back or fail per setting. No record left.                                                                          |
| Peer offline mid-run                         | Agent keeps running there; phase `stale`; polling backs off; results arrive on return.                                              |
| Peer gone 24 hours                           | Record `lost`; one failed result pushed under its own id, so a real result that arrives later is still delivered.                   |
| Home restarts                                | Registry and push receipts recompute what is owed.                                                                                  |
| 401 or 403 (tokens last 30 days, no refresh) | Machine marked needs re-link and ineligible; the bridge holds and pushes nothing; resumes after re-link. Settings shows the expiry. |
| Create partly applied                        | Retry with the same `clientRequestId` finishes it via the registry.                                                                 |
| Peer thread deleted or archived              | Record `lost`; failed result pushed once.                                                                                           |
| Model unavailable on the peer                | Case (b) or (c) delivers a failed result; the coordinator can retry with `machine: "local"`.                                        |
| Peer protocol version differs                | Link refused; a later mismatch marks the machine ineligible.                                                                        |
| Unlink with agents running                   | Allowed; those records become `lost` and are reported.                                                                              |

## Security

- **Linking is trust.** `orchestration:operate` lets the home run any client command on the peer,
  including code execution in `full-access`. Link only machines you would let the coordinator's
  machine act on. The runtime-mode rule constrains the MCP path only.
- **Allowlist.** The peer client refuses any command outside the six above, so a bug or a
  prompt-injected tool call cannot reach `project.delete` or `thread.delete`.
- **Least privilege token.** Read and operate only; never `access:write` or relay scopes. A
  session cannot revoke itself, so unlink deletes the local token and tells you to revoke it from
  the peer's client list (the exchange sets `client_label` so it is recognizable).
- **Endpoint validation.** https, or http to a loopback, private-range or tailnet host
  (`isPrivateNetworkHost` covers `100.64/10` and `.ts.net`). Redirects are not followed, responses
  are size-bounded, and the descriptor's environment id must match on every probe.
- **Trust in results** matches a local agent's: a labelled agent message, never a user instruction.

## Test plan

- `placement.test.ts`: modes, weights, ties, Manual only, explicit override bounds, fallback,
  offline, missing or ambiguous Project, in-flight load term, skew.
- `projectMatch.test.ts`, `RemoteAgentStore.test.ts` (atomic write, prune, pending cleanup,
  retry finds record), `AgentMachineClient.test.ts` (exchange, scope, id pinning, 401, timeout,
  redirects, endpoint validation, allowlist, secret name encoding).
- `RemoteAgentBridge.test.ts`: done rules (a) to (c), idempotence across restart, routing and
  archived hold, reactor enqueue, suppress on stop, queued send, 401 hold, lost peer.
- `handlers.test.ts`: local and remote create, registry-first retry, cap across machines,
  standing stays local, runtime mode never looser, list, read, stop and send on remote agents.
- Settings schema and patch tests; web logic tests for the section; visual check of the UI.

## Decisions for Nick

1. **This machine is a candidate in Balance** with its own preference. Manual only makes it
   coordination-only.
2. **One shared cap** of 10 per Project across machines, not per machine.
3. **Fallback to this machine** is on by default when the chosen machine is unavailable, but never
   for an explicit `machine`. Turn it off to fail instead.
4. **Projects are not auto-created on the peer.** A machine without a matching Project is skipped.
5. **Standing agents stay local.** Remote agents are one-off only.
6. **Remote agents show in the peer's sidebar, not the coordinator's Project.** They appear in
   `cp_agent_list` and in your client through the peer environment. A local mirror row is a
   follow-up.
7. **Load is running agents on the machine,** not CPU or memory. The host-resource sampler is
   RPC-only and would need a WebSocket peer client.
8. **Server-owned settings, separate from the client Load balancing switch.** They do not sync.
9. **Older servers show a failed check** in the Agent machines section instead of hiding it: the
   client fills in the settings default, so it cannot tell the server lacks the feature. Hiding it
   needs a capability flag on the environment descriptor (follow-up).
10. **Linking grants operate scope,** not read-only, and tokens expire after 30 days and need
    re-linking. Refresh is a follow-up.

## Review changes

A reviewer checked this spec against the code. Changes made: the bridge now enqueues the reactor
(an appended push never started an idle recipient); result readiness handles start failures and
matches requests by peer timestamps; opaque peer errors are resolved by reading; 401 holds instead
of failing agents; unlink no longer claims to revoke the peer session; the trust statement and a
command allowlist replace "least privilege"; secret names are encoded; `machines` moved out of the
settings patch; create order is registry first, placement outside the lock, explicit machine never
falls back; ownership and routing use the registry and the reactor's rules; polling is per machine;
peer version is checked; the peer create omits `createdByThreadId` and `replyTo` and avoids
`cp-` message ids.

Built differently from the review's suggestions: a request is matched to its turn by
`baselineTurnId` (simpler than comparing peer timestamps and equivalent for one request in flight
per agent); `machines` is a per-entry map rather than an array kept out of the patch; the reactor
gets an `enqueueProject` method rather than a new event trigger, so local behaviour is unchanged.
