/**
 * Project (assistant marker) invariants for the decider. Fork-owned and pure,
 * so each decider.ts hunk stays a single call.
 */
import {
  assistantThreadRole,
  isAgentPushMessageId,
  isStandingAgent,
  type MessageId,
  type OrchestrationAgentMessageSource,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type ThreadCreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;
type ProjectMetaUpdateCommand = Extract<OrchestrationCommand, { type: "project.meta.update" }>;
type ThreadMetaUpdateCommand = Extract<OrchestrationCommand, { type: "thread.meta.update" }>;

function invariant(commandType: string, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType, detail });
}

function findThread(readModel: OrchestrationReadModel, threadId: ThreadId) {
  return readModel.threads.find((thread) => thread.id === threadId);
}

function findThreadProject(readModel: OrchestrationReadModel, thread: OrchestrationThread) {
  return readModel.projects.find((project) => project.id === thread.projectId);
}

function isCoordinator(readModel: OrchestrationReadModel, threadId: ThreadId): boolean {
  const thread = findThread(readModel, threadId);
  return (
    thread !== undefined &&
    assistantThreadRole(findThreadProject(readModel, thread), threadId) === "coordinator"
  );
}

/** Delete, archive, pin and snooze would orphan or hide a Project's coordinator. */
export function requireNotCoordinator(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  commandType: OrchestrationCommand["type"],
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  return isCoordinator(readModel, threadId)
    ? Effect.fail(
        invariant(
          commandType,
          "This thread is its Project's coordinator. Set another coordinator or move the Project to Tasks first.",
        ),
      )
    : Effect.void;
}

/** Settling would hide the coordinator and silently unpin a standing agent. */
export function requireSettleable(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  commandType: OrchestrationCommand["type"],
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const thread = findThread(readModel, threadId);
  if (thread === undefined) return Effect.void;
  const project = findThreadProject(readModel, thread);
  if (assistantThreadRole(project, threadId) === "coordinator") {
    return Effect.fail(invariant(commandType, "Coordinators do not settle."));
  }
  if (isStandingAgent(project, thread)) {
    return Effect.fail(invariant(commandType, "Standing agents do not settle. Unpin to settle."));
  }
  return Effect.void;
}

/** An agent's creator is a live thread of the same Project. */
export function requireAgentCreator(
  readModel: OrchestrationReadModel,
  command: ThreadCreateCommand,
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const creatorId = command.createdByThreadId;
  if (creatorId === undefined) return Effect.void;
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  if (project?.assistant == null) {
    return Effect.fail(invariant(command.type, "Only a Project's threads can create agents."));
  }
  const creator = findThread(readModel, creatorId);
  if (
    creator === undefined ||
    creator.projectId !== command.projectId ||
    creator.deletedAt !== null ||
    creator.archivedAt !== null
  ) {
    return Effect.fail(
      invariant(
        command.type,
        `An agent's creator must be a live thread in its Project; '${creatorId}' is not.`,
      ),
    );
  }
  return Effect.void;
}

/**
 * A request names the thread its result goes to: another live thread of the
 * target's Project. A coordinator never owes a result, so it takes no requests,
 * and a pushed result is never a request, so a pushed turn never pushes onward.
 * Pass `null` when the command reuses a stored message: it was checked when it
 * was appended.
 */
export function requireReplyTo(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  message: {
    readonly messageId: MessageId;
    readonly source?: OrchestrationAgentMessageSource | undefined;
  } | null,
  commandType: OrchestrationCommand["type"],
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const replyTo = message?.source?.replyTo;
  if (message === null || replyTo === undefined) return Effect.void;
  if (isAgentPushMessageId(message.messageId)) {
    return Effect.fail(invariant(commandType, "A pushed result cannot be a request."));
  }
  const target = findThread(readModel, threadId);
  const project = target === undefined ? undefined : findThreadProject(readModel, target);
  if (target === undefined || project?.assistant == null) {
    return Effect.fail(invariant(commandType, "Only a Project's agents take requests."));
  }
  if (assistantThreadRole(project, threadId) === "coordinator") {
    return Effect.fail(invariant(commandType, "The coordinator does not take requests."));
  }
  const recipient = findThread(readModel, replyTo);
  if (
    recipient === undefined ||
    recipient.deletedAt !== null ||
    recipient.projectId !== target.projectId ||
    recipient.id === threadId
  ) {
    return Effect.fail(
      invariant(
        commandType,
        `A request's result must go to another live thread in its Project; '${replyTo}' is not.`,
      ),
    );
  }
  return Effect.void;
}

/**
 * The coordinator is titled with the Project name and always works in the
 * Project folder. Returns the command to decide: before the first turn a
 * mismatched title is dropped rather than rejected, because clients auto-title
 * a thread from its first message and a rejection would skip that send.
 */
export function resolveCoordinatorMetaUpdate(
  readModel: OrchestrationReadModel,
  command: ThreadMetaUpdateCommand,
): Effect.Effect<ThreadMetaUpdateCommand, OrchestrationCommandInvariantError> {
  const thread = findThread(readModel, command.threadId);
  if (thread === undefined) return Effect.succeed(command);
  const project = findThreadProject(readModel, thread);
  if (project === undefined || assistantThreadRole(project, thread.id) !== "coordinator") {
    return Effect.succeed(command);
  }
  if (command.worktreePath != null) {
    return Effect.fail(invariant(command.type, "The coordinator must be a Local thread."));
  }
  const titleMismatch = command.title !== undefined && command.title !== project.title;
  if (command.regenerateTitle === true || (titleMismatch && thread.latestTurn !== null)) {
    return Effect.fail(
      invariant(
        command.type,
        "The coordinator is titled with the Project name. Rename the Project instead.",
      ),
    );
  }
  if (titleMismatch) {
    const { title: _autoTitle, ...rest } = command;
    return Effect.succeed(rest);
  }
  return Effect.succeed(command);
}

/**
 * Resolves `project.meta.update`'s assistant patch into the full marker and
 * the thread events that keep titles, pins and sessions consistent with it.
 * `assistant` is undefined when the command leaves the marker unchanged.
 */
export const decideAssistantMetaUpdate = Effect.fn("decideAssistantMetaUpdate")(function* ({
  readModel,
  project,
  command,
  occurredAt,
  hasQueuedTurnStart,
}: {
  readonly readModel: OrchestrationReadModel;
  readonly project: OrchestrationProject;
  readonly command: ProjectMetaUpdateCommand;
  readonly occurredAt: string;
  /** The decider's rule for a sent message no session has picked up yet. */
  readonly hasQueuedTurnStart: (thread: OrchestrationThread, now: string) => boolean;
}): Effect.fn.Return<
  {
    readonly assistant: ProjectAssistant | null | undefined;
    readonly companions: ReadonlyArray<PlannedOrchestrationEvent>;
  },
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const current = project.assistant ?? null;
  if (command.workspaceRoot !== undefined && current !== null && command.assistant !== null) {
    return yield* invariant(
      command.type,
      "A Project's folder cannot change. Move it to Tasks first.",
    );
  }
  if (command.assistant === null) {
    return { assistant: null, companions: [] };
  }

  const patch = command.assistant;
  let next: ProjectAssistant;
  let coordinator: OrchestrationThread | undefined;
  const effectiveTitle = command.title ?? project.title;
  if (patch === undefined) {
    if (current === null || command.title === undefined) {
      return { assistant: undefined, companions: [] };
    }
    next = current;
    coordinator = findThread(readModel, current.coordinatorThreadId);
  } else {
    const coordinatorThreadId = patch.coordinatorThreadId ?? current?.coordinatorThreadId;
    if (coordinatorThreadId === undefined) {
      return yield* invariant(command.type, "A Project needs a coordinator thread.");
    }
    coordinator = findThread(readModel, coordinatorThreadId);
    if (
      coordinator === undefined ||
      coordinator.projectId !== command.projectId ||
      coordinator.deletedAt !== null ||
      coordinator.archivedAt !== null
    ) {
      return yield* invariant(
        command.type,
        `The coordinator must be a live thread in the Project; '${coordinatorThreadId}' is not.`,
      );
    }
    if (coordinator.worktreePath !== null) {
      return yield* invariant(command.type, "The coordinator must be a Local thread.");
    }
    const coordinatorChanged = current?.coordinatorThreadId !== coordinatorThreadId;
    // The promoted thread's own title comes back if it is ever replaced.
    const formerTitle = coordinatorChanged
      ? coordinator.title !== effectiveTitle
        ? coordinator.title
        : undefined
      : current?.formerTitle;
    const archivedAt =
      patch.archived === undefined
        ? current?.archivedAt
        : patch.archived
          ? (current?.archivedAt ?? occurredAt)
          : null;
    next = {
      coordinatorThreadId,
      ...(formerTitle !== undefined ? { formerTitle } : {}),
      ...(archivedAt !== undefined ? { archivedAt } : {}),
    };
  }

  const threadBase = (threadId: ThreadId) =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
      commandId: command.commandId,
    });
  // Manual state blocks automatic titling, and clearing an in-flight
  // regeneration makes its completion stale, so the name sticks.
  const manualTitle = (thread: OrchestrationThread, title: string) =>
    threadBase(thread.id).pipe(
      Effect.map((base): PlannedOrchestrationEvent => ({
        ...base,
        type: "thread.meta-updated",
        payload: {
          threadId: thread.id,
          title,
          titleState: { source: "manual", version: command.commandId, needsRefinement: false },
          ...(thread.titleRegeneration != null ? { titleRegeneration: null } : {}),
          updatedAt: occurredAt,
        },
      })),
    );

  const companions: PlannedOrchestrationEvent[] = [];
  const liveCoordinator = coordinator?.deletedAt === null ? coordinator : undefined;
  if (current?.coordinatorThreadId !== next.coordinatorThreadId) {
    const previous =
      current === null ? undefined : findThread(readModel, current.coordinatorThreadId);
    if (current !== null && previous !== undefined && previous.deletedAt === null) {
      // The old coordinator stays as a standing agent, so switching back is one step.
      companions.push(
        yield* manualTitle(previous, current.formerTitle ?? `${effectiveTitle} (previous)`),
      );
      if (previous.pinnedAt == null) {
        companions.push({
          ...(yield* threadBase(previous.id)),
          type: "thread.pinned",
          payload: { threadId: previous.id, pinnedAt: occurredAt, updatedAt: occurredAt },
        });
      }
    }
    if (liveCoordinator !== undefined) {
      companions.push(yield* manualTitle(liveCoordinator, effectiveTitle));
      // A coordinator cannot be pinned, and a standing agent promoted here
      // must not come back as a stray pin after Move to Tasks.
      if (liveCoordinator.pinnedAt != null) {
        companions.push({
          ...(yield* threadBase(liveCoordinator.id)),
          type: "thread.unpinned",
          payload: { threadId: liveCoordinator.id, updatedAt: occurredAt },
        });
      }
      // Promotion clears parked states, as pinning does.
      if (liveCoordinator.settledOverride === "settled") {
        companions.push({
          ...(yield* threadBase(liveCoordinator.id)),
          type: "thread.unsettled",
          payload: { threadId: liveCoordinator.id, reason: "user", updatedAt: occurredAt },
        });
      }
      if (liveCoordinator.snoozedUntil != null) {
        companions.push({
          ...(yield* threadBase(liveCoordinator.id)),
          type: "thread.unsnoozed",
          payload: { threadId: liveCoordinator.id, reason: "user", updatedAt: occurredAt },
        });
      }
    }
  } else if (command.title !== undefined && liveCoordinator !== undefined) {
    companions.push(yield* manualTitle(liveCoordinator, effectiveTitle));
  }

  if ((current?.archivedAt ?? null) === null && next.archivedAt != null) {
    for (const thread of readModel.threads) {
      if (thread.projectId !== command.projectId || thread.deletedAt !== null) continue;
      const live = thread.session !== null && thread.session.status !== "stopped";
      // A queued send has no session yet; the reactor handles its start
      // first, so this stop still lands after it.
      if (!live && !hasQueuedTurnStart(thread, occurredAt)) continue;
      companions.push({
        ...(yield* threadBase(thread.id)),
        type: "thread.session-stop-requested",
        payload: { threadId: thread.id, createdAt: occurredAt },
      });
    }
  }

  return { assistant: patch === undefined ? undefined : next, companions };
});
