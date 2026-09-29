import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProjectAssistant,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-personal");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const COORDINATOR = ThreadId.make("thread-coordinator");
const AGENT = ThreadId.make("thread-agent");
const PINNED_AGENT = ThreadId.make("thread-pinned-agent");

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Title ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<OrchestrationProject> = {}): OrchestrationProject {
  return {
    id: PROJECT_ID,
    title: "Personal",
    workspaceRoot: "/tmp/personal",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(input: {
  readonly assistant?: ProjectAssistant | null;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly projects?: ReadonlyArray<OrchestrationProject>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      makeProject(input.assistant === undefined ? {} : { assistant: input.assistant }),
      makeProject({ id: OTHER_PROJECT_ID, title: "Other", workspaceRoot: "/tmp/other" }),
      ...(input.projects ?? []),
    ],
    threads: input.threads ?? [
      makeThread(COORDINATOR, { title: "Personal" }),
      makeThread(AGENT),
      makeThread(PINNED_AGENT, { pinnedAt: NOW }),
    ],
    updatedAt: NOW,
  };
}

const coordinatorProject = { assistant: { coordinatorThreadId: COORDINATOR } } as const;

const completedTurn: NonNullable<OrchestrationThread["latestTurn"]> = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};

// The decider clock is the Effect test clock pinned to the epoch, so a user
// message 30s before it with no adopting turn is a queued send.
const queuedMessage = {
  id: MessageId.make("message-queued"),
  role: "user",
  text: "Continue",
  turnId: null,
  streaming: false,
  createdAt: "1969-12-31T23:59:30.000Z",
  updatedAt: "1969-12-31T23:59:30.000Z",
} as OrchestrationThread["messages"][number];

function session(threadId: ThreadId, status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((result): ReadonlyArray<PlannedEvent> => ("eventId" in result ? [result] : result)),
  );

const rejection = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decide(readModel, command).pipe(Effect.flip);

const apply = Effect.fn("apply")(function* (
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<PlannedEvent>,
) {
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, {
      ...event,
      sequence: next.snapshotSequence + 1,
    } as OrchestrationEvent);
  }
  return next;
});

const setAssistant = (
  commandId: string,
  assistant: Extract<OrchestrationCommand, { type: "project.meta.update" }>["assistant"],
  extra: Partial<Extract<OrchestrationCommand, { type: "project.meta.update" }>> = {},
): OrchestrationCommand => ({
  type: "project.meta.update",
  commandId: CommandId.make(commandId),
  projectId: PROJECT_ID,
  ...extra,
  ...(assistant !== undefined ? { assistant } : {}),
});

type EventPayload<T extends OrchestrationEvent["type"]> = Extract<
  OrchestrationEvent,
  { type: T }
>["payload"];

function payloadOf<T extends OrchestrationEvent["type"]>(
  event: PlannedEvent | undefined,
  type: T,
): EventPayload<T> {
  expect(event?.type).toBe(type);
  return (event as unknown as { readonly payload: EventPayload<T> }).payload;
}

const summarize = (events: ReadonlyArray<PlannedEvent>) =>
  events.map((event) => `${event.type}:${event.aggregateId}`);

it.layer(NodeServices.layer)("assistant decider", (it) => {
  describe("coordinator validation", () => {
    const cases: ReadonlyArray<readonly [string, OrchestrationThread | undefined]> = [
      ["another project", makeThread(COORDINATOR, { projectId: OTHER_PROJECT_ID })],
      ["archived", makeThread(COORDINATOR, { archivedAt: NOW })],
      ["deleted", makeThread(COORDINATOR, { deletedAt: NOW })],
      ["missing", undefined],
      ["worktree", makeThread(COORDINATOR, { worktreePath: "/tmp/personal-wt" })],
    ];
    for (const [label, thread] of cases) {
      it.effect(`rejects a coordinator thread that is ${label}`, () =>
        Effect.gen(function* () {
          const error = yield* rejection(
            makeReadModel({ threads: thread === undefined ? [] : [thread] }),
            setAssistant("cmd-set", { coordinatorThreadId: COORDINATOR }),
          );
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
        }),
      );
    }

    it.effect("rejects a patch without any coordinator", () =>
      Effect.gen(function* () {
        const error = yield* rejection(makeReadModel({}), setAssistant("cmd-set", {}));
        expect(error.message).toContain("coordinator");
      }),
    );
  });

  it.effect("first set titles the coordinator manually even when the title already matches", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        makeReadModel({}),
        setAssistant("cmd-set", { coordinatorThreadId: COORDINATOR }),
      );
      expect(summarize(events)).toEqual([
        `thread.meta-updated:${COORDINATOR}`,
        `project.meta-updated:${PROJECT_ID}`,
      ]);
      expect(payloadOf(events[0], "thread.meta-updated")).toMatchObject({
        title: "Personal",
        titleState: { source: "manual", version: "cmd-set", needsRefinement: false },
      });
      // The promoted title matched the Project name, so there is nothing to restore.
      expect(payloadOf(events[1], "project.meta-updated").assistant).toEqual({
        coordinatorThreadId: COORDINATOR,
      });
    }),
  );

  it.effect("promoting a differently titled thread saves its title and unparks it", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        makeReadModel({
          threads: [
            makeThread(AGENT, {
              title: "Inbox triage",
              settledOverride: "settled",
              settledAt: NOW,
              snoozedUntil: "2026-02-01T00:00:00.000Z",
              snoozedAt: NOW,
            }),
          ],
        }),
        setAssistant("cmd-set", { coordinatorThreadId: AGENT }, { title: "Life" }),
      );
      expect(summarize(events)).toEqual([
        `thread.meta-updated:${AGENT}`,
        `thread.unsettled:${AGENT}`,
        `thread.unsnoozed:${AGENT}`,
        `project.meta-updated:${PROJECT_ID}`,
      ]);
      expect(payloadOf(events[0], "thread.meta-updated").title).toBe("Life");
      expect(payloadOf(events[3], "project.meta-updated")).toMatchObject({
        title: "Life",
        assistant: { coordinatorThreadId: AGENT, formerTitle: "Inbox triage" },
      });
    }),
  );

  it.effect("clears an in-flight title regeneration so its completion keeps the Project name", () =>
    Effect.gen(function* () {
      const requestId = CommandId.make("cmd-regenerate");
      const readModel = makeReadModel({
        threads: [
          makeThread(COORDINATOR, {
            title: "Draft",
            titleState: { source: "generated", version: requestId, needsRefinement: false },
            titleRegeneration: { requestId, startedAt: NOW },
          }),
        ],
      });
      const events = yield* decide(
        readModel,
        setAssistant("cmd-set", { coordinatorThreadId: COORDINATOR }),
      );
      expect(payloadOf(events[0], "thread.meta-updated").titleRegeneration).toBeNull();

      const promoted = yield* apply(readModel, events);
      const completion = yield* decide(promoted, {
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-regenerate-done"),
        threadId: COORDINATOR,
        requestId,
        title: "Generated title",
      });
      const settled = yield* apply(promoted, completion);
      expect(settled.threads.find((thread) => thread.id === COORDINATOR)?.title).toBe("Personal");
    }),
  );

  it.effect("renaming a Project renames its coordinator", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        makeReadModel(coordinatorProject),
        setAssistant("cmd-rename", undefined, { title: "Home" }),
      );
      expect(summarize(events)).toEqual([
        `thread.meta-updated:${COORDINATOR}`,
        `project.meta-updated:${PROJECT_ID}`,
      ]);
      expect(payloadOf(events[0], "thread.meta-updated")).toMatchObject({
        title: "Home",
        titleState: { source: "manual" },
      });
      // The marker is unchanged, so it stays off the event.
      expect(payloadOf(events[1], "project.meta-updated").assistant).toBeUndefined();
    }),
  );

  it.effect("a title-only update on a workspace emits no companions", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        makeReadModel({}),
        setAssistant("cmd-rename", undefined, { title: "Home" }),
      );
      expect(summarize(events)).toEqual([`project.meta-updated:${PROJECT_ID}`]);
    }),
  );

  it.effect(
    "swapping coordinators keeps the old one as a pinned agent, and swapping back restores titles",
    () =>
      Effect.gen(function* () {
        const initial = makeReadModel({
          ...coordinatorProject,
          threads: [
            makeThread(COORDINATOR, { title: "Personal" }),
            makeThread(AGENT, { title: "Sales" }),
          ],
        });
        const swap = yield* decide(
          initial,
          setAssistant("cmd-swap", { coordinatorThreadId: AGENT }),
        );
        expect(summarize(swap)).toEqual([
          `thread.meta-updated:${COORDINATOR}`,
          `thread.pinned:${COORDINATOR}`,
          `thread.meta-updated:${AGENT}`,
          `project.meta-updated:${PROJECT_ID}`,
        ]);
        expect(payloadOf(swap[0], "thread.meta-updated")).toMatchObject({
          title: "Personal (previous)",
          titleState: { source: "manual" },
        });
        expect(payloadOf(swap[3], "project.meta-updated").assistant).toEqual({
          coordinatorThreadId: AGENT,
          formerTitle: "Sales",
        });

        const swapped = yield* apply(initial, swap);
        const titles = (model: OrchestrationReadModel) =>
          Object.fromEntries(model.threads.map((thread) => [thread.id, thread.title]));
        expect(titles(swapped)).toEqual({
          [COORDINATOR]: "Personal (previous)",
          [AGENT]: "Personal",
        });

        const back = yield* decide(
          swapped,
          setAssistant("cmd-back", { coordinatorThreadId: COORDINATOR }),
        );
        expect(summarize(back)).toEqual([
          `thread.meta-updated:${AGENT}`,
          `thread.pinned:${AGENT}`,
          `thread.meta-updated:${COORDINATOR}`,
          `thread.unpinned:${COORDINATOR}`,
          `project.meta-updated:${PROJECT_ID}`,
        ]);
        const restored = yield* apply(swapped, back);
        expect(titles(restored)).toEqual({ [COORDINATOR]: "Personal", [AGENT]: "Sales" });
        // Only the demoted thread stays pinned; a coordinator never is.
        const pins = Object.fromEntries(
          restored.threads.map((thread) => [thread.id, thread.pinnedAt !== null]),
        );
        expect(pins).toEqual({ [COORDINATOR]: false, [AGENT]: true });
        expect(restored.projects.find((project) => project.id === PROJECT_ID)?.assistant).toEqual({
          coordinatorThreadId: COORDINATOR,
          formerTitle: "Personal (previous)",
        });
      }),
  );

  it.effect(
    "archiving stops live and queued work, keeps archivedAt on re-archive, and unarchive clears it",
    () =>
      Effect.gen(function* () {
        const queued = ThreadId.make("thread-queued");
        const deleted = ThreadId.make("thread-deleted");
        const initial = makeReadModel({
          ...coordinatorProject,
          threads: [
            makeThread(COORDINATOR, { title: "Personal", session: session(COORDINATOR, "ready") }),
            makeThread(AGENT, { session: session(AGENT, "running") }),
            makeThread(PINNED_AGENT, { session: session(PINNED_AGENT, "stopped") }),
            makeThread(ThreadId.make("thread-idle")),
            // Sent, but no session has picked it up yet.
            makeThread(queued, { messages: [queuedMessage] }),
            makeThread(deleted, { deletedAt: NOW, session: session(deleted, "running") }),
            makeThread(ThreadId.make("thread-elsewhere"), {
              projectId: OTHER_PROJECT_ID,
              session: session(ThreadId.make("thread-elsewhere"), "running"),
            }),
          ],
        });
        const archive = yield* decide(initial, setAssistant("cmd-archive", { archived: true }));
        expect(summarize(archive)).toEqual([
          `thread.session-stop-requested:${COORDINATOR}`,
          `thread.session-stop-requested:${AGENT}`,
          `thread.session-stop-requested:${queued}`,
          `project.meta-updated:${PROJECT_ID}`,
        ]);
        const archivedAt = payloadOf(archive[3], "project.meta-updated").assistant?.archivedAt;
        expect(archivedAt).toEqual(expect.any(String));

        const archived = yield* apply(initial, archive);
        const again = yield* decide(
          archived,
          setAssistant("cmd-archive-again", { archived: true }),
        );
        expect(summarize(again)).toEqual([`project.meta-updated:${PROJECT_ID}`]);
        expect(payloadOf(again[0], "project.meta-updated").assistant?.archivedAt).toBe(archivedAt);

        const unarchive = yield* decide(
          archived,
          setAssistant("cmd-unarchive", { archived: false }),
        );
        expect(payloadOf(unarchive[0], "project.meta-updated").assistant).toEqual({
          coordinatorThreadId: COORDINATOR,
          archivedAt: null,
        });
      }),
  );

  it.effect("assistant: null clears the marker without touching threads", () =>
    Effect.gen(function* () {
      const initial = makeReadModel(coordinatorProject);
      const events = yield* decide(initial, setAssistant("cmd-clear", null));
      expect(summarize(events)).toEqual([`project.meta-updated:${PROJECT_ID}`]);
      const cleared = yield* apply(initial, events);
      expect(cleared.projects.find((project) => project.id === PROJECT_ID)?.assistant).toBeNull();
    }),
  );

  describe("thread guards", () => {
    const guarded = (threadId: ThreadId): ReadonlyArray<OrchestrationCommand> => [
      { type: "thread.delete", commandId: CommandId.make("cmd-delete"), threadId },
      { type: "thread.archive", commandId: CommandId.make("cmd-archive"), threadId },
      { type: "thread.settle", commandId: CommandId.make("cmd-settle"), threadId },
      {
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto-settle"),
        threadId,
        snapshotSequence: 0,
        settledAt: NOW,
      },
      { type: "thread.pin", commandId: CommandId.make("cmd-pin"), threadId },
      {
        type: "thread.snooze",
        commandId: CommandId.make("cmd-snooze"),
        threadId,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      },
    ];

    it.effect(
      "rejects delete, archive, settle, auto-settle, pin and snooze on the coordinator",
      () =>
        Effect.gen(function* () {
          for (const command of guarded(COORDINATOR)) {
            const error = yield* rejection(makeReadModel(coordinatorProject), command);
            expect(error._tag, command.type).toBe("OrchestrationCommandInvariantError");
          }
        }),
    );

    it.effect("allows the same actions on a one-off agent", () =>
      Effect.gen(function* () {
        for (const command of guarded(AGENT)) {
          const events = yield* decide(makeReadModel(coordinatorProject), command);
          expect(events.length, command.type).toBeGreaterThan(0);
        }
      }),
    );

    it.effect("rejects settling a standing agent but settles a pinned workspace thread", () =>
      Effect.gen(function* () {
        const settle: OrchestrationCommand = {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: PINNED_AGENT,
        };
        const autoSettle: OrchestrationCommand = {
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle"),
          threadId: PINNED_AGENT,
          snapshotSequence: 0,
          settledAt: NOW,
        };
        for (const command of [settle, autoSettle]) {
          const error = yield* rejection(makeReadModel(coordinatorProject), command);
          expect(error.message).toContain("Unpin to settle");
          const events = yield* decide(makeReadModel({}), command);
          expect(events[0]?.type).toBe("thread.settled");
        }
      }),
    );

    it.effect("rejects coordinator title changes, title regeneration and worktrees", () =>
      Effect.gen(function* () {
        const meta = (
          extra: Partial<Extract<OrchestrationCommand, { type: "thread.meta.update" }>>,
        ): OrchestrationCommand => ({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta"),
          threadId: COORDINATOR,
          ...extra,
        });
        const readModel = makeReadModel({
          ...coordinatorProject,
          threads: [
            makeThread(COORDINATOR, { title: "Personal", latestTurn: completedTurn }),
            makeThread(AGENT),
          ],
        });
        for (const command of [
          meta({ regenerateTitle: true }),
          meta({ title: "Something else" }),
          meta({ worktreePath: "/tmp/personal-wt", branch: "feature" }),
        ]) {
          const error = yield* rejection(readModel, command);
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
        }
        // The Project name itself and branch-only updates still pass.
        yield* decide(readModel, meta({ title: "Personal" }));
        yield* decide(readModel, meta({ branch: "main" }));
        yield* decide(readModel, meta({ title: "Anything", threadId: AGENT }));
      }),
    );

    it.effect(
      "drops a first-message auto-title on a new coordinator instead of failing the send",
      () =>
        Effect.gen(function* () {
          // Clients title a thread from its first message before starting the turn.
          const readModel = makeReadModel(coordinatorProject);
          const events = yield* decide(readModel, {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-auto-title"),
            threadId: COORDINATOR,
            title: "Fix the kitchen sink",
          });
          expect(summarize(events)).toEqual([`thread.meta-updated:${COORDINATOR}`]);
          expect(payloadOf(events[0], "thread.meta-updated")).not.toHaveProperty("title");
          const next = yield* apply(readModel, events);
          expect(next.threads.find((thread) => thread.id === COORDINATOR)?.title).toBe("Personal");
        }),
    );
  });

  it.effect("a Project's folder cannot move unless the marker is cleared in the same command", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(coordinatorProject);
      const error = yield* rejection(
        readModel,
        setAssistant("cmd-move", undefined, { workspaceRoot: "/tmp/elsewhere" }),
      );
      expect(error.message).toContain("folder");
      const events = yield* decide(
        readModel,
        setAssistant("cmd-move", null, { workspaceRoot: "/tmp/elsewhere" }),
      );
      expect(payloadOf(events[0], "project.meta-updated")).toMatchObject({
        workspaceRoot: "/tmp/elsewhere",
        assistant: null,
      });
    }),
  );

  it.effect("force-deleting a Project clears the marker first, atomically", () =>
    Effect.gen(function* () {
      const events = yield* decide(makeReadModel(coordinatorProject), {
        type: "project.delete",
        commandId: CommandId.make("cmd-delete-project"),
        projectId: PROJECT_ID,
        force: true,
      });
      expect(summarize(events)).toEqual([
        `project.meta-updated:${PROJECT_ID}`,
        `thread.deleted:${COORDINATOR}`,
        `thread.deleted:${AGENT}`,
        `thread.deleted:${PINNED_AGENT}`,
        `project.deleted:${PROJECT_ID}`,
      ]);
      expect(payloadOf(events[0], "project.meta-updated").assistant).toBeNull();
    }),
  );

  it.effect("replaying the events puts the marker on the read model", () =>
    Effect.gen(function* () {
      const initial = makeReadModel({});
      const events = yield* decide(
        initial,
        setAssistant("cmd-set", { coordinatorThreadId: COORDINATOR }),
      );
      const next = yield* apply(initial, events);
      expect(next.projects.find((project) => project.id === PROJECT_ID)?.assistant).toEqual({
        coordinatorThreadId: COORDINATOR,
      });
      const updated = yield* apply(
        next,
        yield* decide(next, setAssistant("cmd-icon", undefined, { projectIcon: null })),
      );
      // Unrelated metadata updates keep the marker.
      expect(updated.projects.find((project) => project.id === PROJECT_ID)?.assistant).toEqual({
        coordinatorThreadId: COORDINATOR,
      });
    }),
  );
});
