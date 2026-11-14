import {
  IsoDateTime,
  McpCapabilityUnavailableError,
  PROJECT_STATUS_ANSWER_MAX,
  PROJECT_STATUS_DETAIL_MAX,
  PROJECT_STATUS_LINE_MAX,
  PROJECT_STATUS_QUESTION_MAX,
  PROJECT_STATUS_SUMMARY_MAX,
  PROJECT_STATUS_TITLE_MAX,
  PROJECT_STATUS_WHY_MAX,
  ProjectStatus,
  ProjectStatusId,
  Task,
  TaskId,
  ProjectStatusState,
  PROJECT_SCHEDULE_NAME_MAX,
  PROJECT_SCHEDULE_PROMPT_MAX,
  ProjectScheduleActor,
  ProjectScheduleRun,
  ProjectScheduleTarget,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { AgentPhase } from "../../../agentMachines/agentPhase.ts";
import * as RemoteAgents from "../../../agentMachines/RemoteAgents.ts";

// Fork-owned. Parameters stay flat primitives: OpenCode stringifies nested unions.

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
  RemoteAgents.RemoteAgents,
];

export class AgentsUnavailableError extends Schema.TaggedError<AgentsUnavailableError>()(
  "AgentsUnavailableError",
  {},
) {
  override get message(): string {
    return "Only an active Project's coordinator and its standing agents can manage agents.";
  }
}

export class StandingAgentNotAllowedError extends Schema.TaggedError<StandingAgentNotAllowedError>()(
  "StandingAgentNotAllowedError",
  {},
) {
  override get message(): string {
    return "A standing agent can start only one-off agents. Ask the coordinator for a standing one.";
  }
}

export class ConcurrencyLimitError extends Schema.TaggedError<ConcurrencyLimitError>()(
  "ConcurrencyLimitError",
  { limit: Schema.Int, running: Schema.Int },
) {
  override get message(): string {
    return `${this.running} agents are already running in this Project (limit ${this.limit}). Wait for one to finish, or stop one with cp_agent_stop.`;
  }
}

export class UnknownModelError extends Schema.TaggedError<UnknownModelError>()(
  "UnknownModelError",
  { model: Schema.String, available: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.available.length === 0
      ? `Model '${this.model}' is not available. Omit model to use the Project's default.`
      : `Model '${this.model}' is not available. Try one of: ${this.available.join(", ")}.`;
  }
}

export class ClientRequestIdConflictError extends Schema.TaggedError<ClientRequestIdConflictError>()(
  "ClientRequestIdConflictError",
  { clientRequestId: Schema.String, threadId: ThreadId },
) {
  override get message(): string {
    return `clientRequestId '${this.clientRequestId}' already started agent ${this.threadId} with a different title.`;
  }
}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFoundError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `No agent in this Project matched '${this.agent}'.`;
  }
}

export class AgentAmbiguousError extends Schema.TaggedError<AgentAmbiguousError>()(
  "AgentAmbiguousError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `Several agents are titled '${this.agent}'. Pass threadId instead.`;
  }
}

export class NotYourAgentError extends Schema.TaggedError<NotYourAgentError>()(
  "NotYourAgentError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `'${this.agent}' is not an agent you manage.`;
  }
}

export class SettleCoordinatorOnlyError extends Schema.TaggedError<SettleCoordinatorOnlyError>()(
  "SettleCoordinatorOnlyError",
  {},
) {
  override get message(): string {
    return "Only the Project's coordinator can settle agents.";
  }
}

export class AgentBusyError extends Schema.TaggedError<AgentBusyError>()("AgentBusyError", {
  agent: Schema.String,
  phase: Schema.String,
}) {
  override get message(): string {
    return `'${this.agent}' is ${this.phase} and cannot be settled while it has work in flight. Wait for its report, or stop it with cp_agent_stop.`;
  }
}

export class AgentToolFailedError extends Schema.TaggedError<AgentToolFailedError>()(
  "AgentToolFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export const AgentToolError = Schema.Union([
  McpCapabilityUnavailableError,
  AgentsUnavailableError,
  StandingAgentNotAllowedError,
  ConcurrencyLimitError,
  UnknownModelError,
  ClientRequestIdConflictError,
  AgentNotFoundError,
  AgentAmbiguousError,
  NotYourAgentError,
  SettleCoordinatorOnlyError,
  AgentBusyError,
  AgentToolFailedError,
]);
export type AgentToolError = typeof AgentToolError.Type;

export class SchedulesCoordinatorOnlyError extends Schema.TaggedError<SchedulesCoordinatorOnlyError>()(
  "SchedulesCoordinatorOnlyError",
  {},
) {
  override get message(): string {
    return "Only the Project's coordinator can manage schedules.";
  }
}

export class ScheduleNotFoundError extends Schema.TaggedError<ScheduleNotFoundError>()(
  "ScheduleNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `This Project has no schedule '${this.id}'. Use cp_schedule_list for ids.`;
  }
}

export class ScheduleTurnOnNotRequestedError extends Schema.TaggedError<ScheduleTurnOnNotRequestedError>()(
  "ScheduleTurnOnNotRequestedError",
  {},
) {
  override get message(): string {
    return "A schedule turns on only in a turn the user's own message started, and this turn was not clearly started by one: an agent or a schedule started it, or one of their messages arrived just before it. Ask the user, or they can turn it on in the Schedules panel.";
  }
}

export const ScheduleToolError = Schema.Union([
  McpCapabilityUnavailableError,
  SchedulesCoordinatorOnlyError,
  ScheduleNotFoundError,
  ScheduleTurnOnNotRequestedError,
  AgentNotFoundError,
  AgentAmbiguousError,
  AgentToolFailedError,
]);
export type ScheduleToolError = typeof ScheduleToolError.Type;

export class StatusCoordinatorOnlyError extends Schema.TaggedError<StatusCoordinatorOnlyError>()(
  "StatusCoordinatorOnlyError",
  {},
) {
  override get message(): string {
    return "Only the Project's coordinator can read or write Status.";
  }
}

export const StatusToolError = Schema.Union([
  McpCapabilityUnavailableError,
  StatusCoordinatorOnlyError,
  AgentToolFailedError,
]);
export type StatusToolError = typeof StatusToolError.Type;

/** The user's Assistant settings keep the caller from this task action. */
export class TaskAccessDeniedError extends Schema.TaggedError<TaskAccessDeniedError>()(
  "TaskAccessDeniedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const TaskToolError = Schema.Union([
  McpCapabilityUnavailableError,
  StatusCoordinatorOnlyError,
  TaskAccessDeniedError,
  AgentToolFailedError,
]);
export type TaskToolError = typeof TaskToolError.Type;

const AgentRef = TrimmedNonEmptyString.annotate({
  description: "The agent's threadId (preferred) or its exact title.",
});

export { AgentPhase };

export const AgentCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({ description: "A short name for the agent." }),
  message: TrimmedNonEmptyString.annotate({ description: "The agent's first message: its task." }),
  standing: Schema.optional(
    Schema.Boolean.annotate({
      description: "Keep the agent as a reusable role instead of settling it after it reports.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model slug or name. Defaults to the Project's model.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description: "Defaults to the coordinator's. Never looser than yours.",
    }),
  ),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Makes a retried call return the agent it already started.",
    }),
  ),
  machine: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        'Run the agent on a linked machine (its name), or "local" for this one. Omit to follow the user\'s Agent machines setting, which also limits what you may choose. One-off agents only.',
    }),
  ),
});
export type AgentCreateInput = typeof AgentCreateInput.Type;

export const AgentCreateResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  created: Schema.Boolean.annotate({
    description: "False when clientRequestId matched an agent started earlier.",
  }),
  machineLabel: Schema.NullOr(Schema.String).annotate({
    description: "The machine the agent runs on, or null for this one.",
  }),
  placement: Schema.optional(
    Schema.String.annotate({
      description: "Present when the agent did not start where the settings asked, and why.",
    }),
  ),
});
export type AgentCreateResult = typeof AgentCreateResult.Type;

export const AgentListInput = Schema.Struct({
  includeSettled: Schema.optional(
    Schema.Boolean.annotate({ description: "Also list agents that have been settled." }),
  ),
});
export type AgentListInput = typeof AgentListInput.Type;

export const AgentListEntry = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  standing: Schema.Boolean,
  phase: AgentPhase,
  settled: Schema.Boolean,
  lastActivityAt: Schema.String,
  machine: Schema.NullOr(Schema.String).annotate({
    description: "The machine the agent runs on, or null for this one.",
  }),
});
export type AgentListEntry = typeof AgentListEntry.Type;

export const AgentListResult = Schema.Struct({ agents: Schema.Array(AgentListEntry) });
export type AgentListResult = typeof AgentListResult.Type;

export const AgentReadInput = Schema.Struct({
  agent: AgentRef,
  turns: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).annotate({
      description: "How many recent requests to read, 1 to 5. Defaults to 1.",
    }),
  ),
});
export type AgentReadInput = typeof AgentReadInput.Type;

export const AgentReadResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  phase: AgentPhase,
  turns: Schema.Array(
    Schema.Struct({
      state: Schema.Literals(["queued", "running", "completed", "failed", "interrupted"]),
      request: Schema.String,
      result: Schema.NullOr(Schema.String).annotate({
        description: "The agent's final message for this request, or null if it has none yet.",
      }),
    }),
  ),
});
export type AgentReadResult = typeof AgentReadResult.Type;

export const AgentStopInput = Schema.Struct({
  agent: AgentRef,
  archive: Schema.optional(
    Schema.Boolean.annotate({ description: "Also archive the agent's thread." }),
  ),
});
export type AgentStopInput = typeof AgentStopInput.Type;

export const AgentStopResult = Schema.Struct({
  threadId: ThreadId,
  stopped: Schema.Boolean.annotate({
    description:
      "True when the agent was working, or had messages from you waiting, and was stopped. Those messages are dropped.",
  }),
  archived: Schema.Boolean,
});
export type AgentStopResult = typeof AgentStopResult.Type;

export const AgentSettleInput = Schema.Struct({
  agent: AgentRef,
  archive: Schema.optional(
    Schema.Boolean.annotate({ description: "Also archive the agent's thread." }),
  ),
});
export type AgentSettleInput = typeof AgentSettleInput.Type;

export const AgentSettleResult = Schema.Struct({
  threadId: ThreadId,
  settled: Schema.Literal(true),
  archived: Schema.Boolean,
});
export type AgentSettleResult = typeof AgentSettleResult.Type;

const ScheduleRef = TrimmedNonEmptyString.annotate({
  description: "The schedule's id, from cp_schedule_list.",
});
const ScheduleName = TrimmedNonEmptyString.annotate({
  description: `A short name, at most ${PROJECT_SCHEDULE_NAME_MAX} characters.`,
});
const SchedulePrompt = TrimmedNonEmptyString.annotate({
  description: `The message each run sends, at most ${PROJECT_SCHEDULE_PROMPT_MAX} characters.`,
});
const ScheduleCron = TrimmedNonEmptyString.annotate({
  description: `Five-field cron in the host's local time, at most every 15 minutes. "0 9 * * 1-5" is weekdays at 9:00.`,
});
const ScheduleEnabled = Schema.Boolean.annotate({
  description:
    "true turns the schedule on. Only when the user's own message explicitly asks to turn it on, and only in a turn that message started; it first runs at its next run time. false pauses it.",
});
const ScheduleNextRun = Schema.NullOr(IsoDateTime).annotate({
  description: "When it next runs. Null while paused.",
});
const ScheduleTargetRef = TrimmedNonEmptyString.annotate({
  description: `"coordinator" (you, the default), or a standing agent's threadId or exact title. A standing agent's result comes back to you.`,
});

export const ScheduleListEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cron: Schema.String,
  cadence: Schema.String.annotate({ description: "The cron in words." }),
  target: ProjectScheduleTarget,
  enabled: Schema.Boolean,
  nextRun: ScheduleNextRun,
  createdBy: ProjectScheduleActor,
  updatedBy: ProjectScheduleActor,
  lastRun: Schema.NullOr(ProjectScheduleRun),
});
export type ScheduleListEntry = typeof ScheduleListEntry.Type;

export const ScheduleListResult = Schema.Struct({ schedules: Schema.Array(ScheduleListEntry) });
export type ScheduleListResult = typeof ScheduleListResult.Type;

export const ScheduleCreateInput = Schema.Struct({
  name: ScheduleName,
  prompt: SchedulePrompt,
  cron: ScheduleCron,
  target: Schema.optional(ScheduleTargetRef),
  enabled: Schema.optional(ScheduleEnabled),
});
export type ScheduleCreateInput = typeof ScheduleCreateInput.Type;

export const ScheduleCreateResult = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  nextRun: ScheduleNextRun,
  note: Schema.String,
});
export type ScheduleCreateResult = typeof ScheduleCreateResult.Type;

export const ScheduleUpdateInput = Schema.Struct({
  id: ScheduleRef,
  name: Schema.optional(ScheduleName),
  prompt: Schema.optional(SchedulePrompt),
  cron: Schema.optional(ScheduleCron),
  target: Schema.optional(ScheduleTargetRef),
  enabled: Schema.optional(ScheduleEnabled),
  pause: Schema.optional(
    Schema.Boolean.annotate({ description: "Deprecated: use enabled. true pauses the schedule." }),
  ),
});
export type ScheduleUpdateInput = typeof ScheduleUpdateInput.Type;

export const ScheduleUpdateResult = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  nextRun: ScheduleNextRun,
});
export type ScheduleUpdateResult = typeof ScheduleUpdateResult.Type;

export const ScheduleDeleteInput = Schema.Struct({ id: ScheduleRef });
export type ScheduleDeleteInput = typeof ScheduleDeleteInput.Type;

export const ScheduleDeleteResult = Schema.Struct({
  id: Schema.String,
  deleted: Schema.Literal(true),
});
export type ScheduleDeleteResult = typeof ScheduleDeleteResult.Type;

export const StatusSetInput = Schema.Struct({
  id: ProjectStatusId.annotate({
    description:
      'The workstream\'s stable id: 1-40 lowercase letters, digits or hyphens, such as "payouts". Reuse it for every update.',
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `A short name, at most ${PROJECT_STATUS_TITLE_MAX} characters, unique in the Project. Required for a new workstream.`,
    }),
  ),
  state: Schema.optional(
    ProjectStatusState.annotate({
      description:
        "working, done, queued, or needs-you. A question always makes it needs-you; clearing one returns it to working unless you pass a state.",
    }),
  ),
  summary: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `One line on where it stands, always visible. Required for a new workstream. At most ${PROJECT_STATUS_SUMMARY_MAX} characters: compress, and put the rest in detail.`,
    }),
  ),
  detail: Schema.optional(
    Schema.String.annotate({
      description: `Shown only when the user expands the row: what is moving, what is not. At most ${PROJECT_STATUS_DETAIL_MAX} characters. Empty removes it.`,
    }),
  ),
  agents: Schema.optional(
    Schema.Array(ThreadId).annotate({
      description:
        "threadIds of the agents on this workstream (at most 8). The panel shows their live state. An empty list removes them.",
    }),
  ),
  question: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `A decision only the user can make, as one plain question. At most ${PROJECT_STATUS_QUESTION_MAX} characters. Needs a recommendation and an answer label.`,
    }),
  ),
  recommendation: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `The full action you recommend, which is what you receive if the user goes with it. At most ${PROJECT_STATUS_LINE_MAX} characters.`,
    }),
  ),
  answer: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `Your recommended answer written as its button label, such as "Amend first". At most ${PROJECT_STATUS_ANSWER_MAX} characters. Required whenever you ask or change a question.`,
    }),
  ),
  why: Schema.optional(
    Schema.String.annotate({
      description: `One or two sentences on why you recommend it, shown when the row is expanded. At most ${PROJECT_STATUS_WHY_MAX} characters. Empty removes it.`,
    }),
  ),
  deadline: Schema.optional(
    Schema.String.annotate({
      description:
        "ISO date-time by which you need the answer, in the future. Empty removes it. When it passes without a reply you get one reminder and the question stays open, unless the user opted in to your recommendation for this decision, in which case it is sent to you as their answer. Changing the question, recommendation, answer or deadline cancels that opt-in.",
    }),
  ),
  clearDecision: Schema.optional(
    Schema.Boolean.annotate({
      description: "true once the user has answered: removes the question.",
    }),
  ),
  remove: Schema.optional(
    Schema.Boolean.annotate({ description: "true removes the workstream from the board." }),
  ),
});
export type StatusSetInput = typeof StatusSetInput.Type;

export const StatusSetResult = Schema.Struct({
  id: Schema.String,
  status: Schema.NullOr(ProjectStatus).annotate({
    description: "The saved record, or null once removed.",
  }),
  needsYou: Schema.Int.annotate({ description: "Workstreams now waiting on the user." }),
});
export type StatusSetResult = typeof StatusSetResult.Type;

export const StatusListResult = Schema.Struct({ statuses: Schema.Array(ProjectStatus) });
export type StatusListResult = typeof StatusListResult.Type;

/** Relative homes, counted from the server's local today. */
export const TaskWhen = Schema.Literals([
  "today",
  "tomorrow",
  "this-week",
  "next-week",
  "this-month",
  "next-month",
  "this-year",
  "next-year",
  "backlog",
  "week-backlog",
  "month-backlog",
  "year-backlog",
]);
export type TaskWhen = typeof TaskWhen.Type;

const TASK_HOME_HELP =
  "Where the task lives: give either `when` or `date` (with optional `period`), not both. Resolve words like 'Monday' or 'the 3rd' to a YYYY-MM-DD date yourself, in the user's time zone, before calling.";

/** The flat home fields both task tools take. */
const taskHomeFields = {
  when: TaskWhen.annotate({
    description:
      "A relative home: today, tomorrow; this-week / next-week, this-month / next-month, this-year / next-year (a commitment for that whole period); week-backlog, month-backlog, year-backlog (that horizon's backlog); or backlog (the general backlog).",
  }).pipe(Schema.optional),
  date: Schema.String.annotate({
    description:
      "A specific calendar day, YYYY-MM-DD (for example 2026-11-16 for Monday the 16th). Alone, the task is due that day. With `period`, the task is a commitment for the week, month or year containing that day.",
  }).pipe(Schema.optional),
  period: Schema.Literals(["week", "month", "year"])
    .annotate({
      description:
        "With `date`: commit to the whole week (weeks start on the user's week-start day), month or year containing it instead of the single day.",
    })
    .pipe(Schema.optional),
};

export const TaskProposeInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({
    description:
      "A short imperative title, such as 'Confirm Stripe retry email copy'. At most 200 characters.",
  }),
  ...taskHomeFields,
  reminderTime: Schema.String.annotate({
    description:
      "Optional reminder, 24h local HH:MM (for example 09:30). Only for a task on a single day (`date` alone, today or tomorrow).",
  }).pipe(Schema.optional),
  notes: Schema.optional(
    Schema.String.annotate({
      description: "Optional context the user sees when opening the task.",
    }),
  ),
  statusId: Schema.optional(
    ProjectStatusId.annotate({
      description: "The Status workstream this task belongs to, if any.",
    }),
  ),
}).annotate({ description: `${TASK_HOME_HELP} Defaults to this-week.` });
export type TaskProposeInput = typeof TaskProposeInput.Type;

export const TaskProposeResult = Schema.Struct({
  task: Task,
  added: Schema.Boolean.annotate({
    description:
      "True when the task went straight onto the user's list (the Assistant with 'Add directly' on); false when it waits as a proposal.",
  }),
  proposed: Schema.Int.annotate({
    description: "Proposals from this Project now waiting on the user.",
  }),
});
export type TaskProposeResult = typeof TaskProposeResult.Type;

export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(Task).annotate({
    description:
      "Open tasks: for a coordinator, those linked to this Project plus its proposals still waiting; for the Assistant, every open task. A task with a proposal and no acceptedAt is not on the user's list yet.",
  }),
});
export type TaskListResult = typeof TaskListResult.Type;

export const TaskUpdateInput = Schema.Struct({
  taskId: TaskId.annotate({ description: "The task's id, from cp_task_list or cp_task_propose." }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "A new title. At most 200 characters." }),
  ),
  notes: Schema.optional(
    Schema.String.annotate({
      description: "New notes, replacing the old. An empty string clears.",
    }),
  ),
  ...taskHomeFields,
  reminderTime: Schema.NullOr(Schema.String)
    .annotate({
      description:
        "Reminder, 24h local HH:MM, for a task on a single day; null clears it. Without a new home it applies to the task's current day.",
    })
    .pipe(Schema.optional),
  status: Schema.Literals(["todo", "completed"])
    .annotate({
      description:
        "completed marks it done, todo reopens it. The Assistant only, and never for a proposal still waiting on the user.",
    })
    .pipe(Schema.optional),
}).annotate({ description: `Omitted fields keep their value. ${TASK_HOME_HELP}` });
export type TaskUpdateInput = typeof TaskUpdateInput.Type;

export const TaskUpdateResult = Schema.Struct({ task: Task });
export type TaskUpdateResult = typeof TaskUpdateResult.Type;

const AgentCreateTool = Tool.make("cp_agent_create", {
  description:
    "Start an agent in this Project with a first message. Its final message comes back to you, and it stays available for follow-ups. Only the coordinator settles a one-off agent with cp_agent_settle once its work is complete and no follow-ups remain. It may run on another linked machine, per the user's settings.",
  parameters: AgentCreateInput,
  success: AgentCreateResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start an agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const AgentListTool = Tool.make("cp_agent_list", {
  description: "List the agents you manage in this Project.",
  parameters: AgentListInput,
  success: AgentListResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AgentReadTool = Tool.make("cp_agent_read", {
  description: "Read an agent's recent requests and results.",
  parameters: AgentReadInput,
  success: AgentReadResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read an agent")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AgentStopTool = Tool.make("cp_agent_stop", {
  description: "Stop an agent. Its unfinished result is not sent to you.",
  parameters: AgentStopInput,
  success: AgentStopResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop an agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AgentSettleTool = Tool.make("cp_agent_settle", {
  description:
    "Settle an idle agent you manage once its work is done, as the Settle button does. Fails while the agent is working. A settled agent stays readable, and a new message wakes it.",
  parameters: AgentSettleInput,
  success: AgentSettleResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Settle an agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ScheduleListTool = Tool.make("cp_schedule_list", {
  description:
    "List this Project's schedules with their prompts, cadence, state, next and last run.",
  success: ScheduleListResult,
  failure: ScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "List schedules")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ScheduleCreateTool = Tool.make("cp_schedule_create", {
  description:
    "Create a schedule that sends a prompt on a cadence, only when the user asks. It is saved paused unless the user asked to turn it on.",
  parameters: ScheduleCreateInput,
  success: ScheduleCreateResult,
  failure: ScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create a schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ScheduleUpdateTool = Tool.make("cp_schedule_update", {
  description:
    "Change, pause or turn on a schedule. A new prompt, cron or target pauses it unless the same call passes enabled: true.",
  parameters: ScheduleUpdateInput,
  success: ScheduleUpdateResult,
  failure: ScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update a schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ScheduleDeleteTool = Tool.make("cp_schedule_delete", {
  description: "Delete a schedule from this Project, only when the user asks.",
  parameters: ScheduleDeleteInput,
  success: ScheduleDeleteResult,
  failure: ScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete a schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StatusListTool = Tool.make("cp_status_list", {
  description: "List this Project's Status board: one record per workstream.",
  success: StatusListResult,
  failure: StatusToolError,
  dependencies,
})
  .annotate(Tool.Title, "List status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StatusSetTool = Tool.make("cp_status_set", {
  description:
    "Create, update or remove one workstream on the Project's Status board, which the user reads to see where everything stands and what needs them. Omitted fields keep their value; every call marks the record fresh. Put a decision only the user can make on the workstream it blocks, with your recommendation; clear it once they answer.",
  parameters: StatusSetInput,
  success: StatusSetResult,
  failure: StatusToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TaskListTool = Tool.make("cp_task_list", {
  description:
    "List the user's open tasks. A coordinator sees the tasks linked to its Project and its proposals still waiting; the Assistant sees every open task (unless the user turned its task access off).",
  success: TaskListResult,
  failure: TaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TaskProposeTool = Tool.make("cp_task_propose", {
  description:
    "Put a task on the user's own list: something only they should do. Home: `when` (today, tomorrow, this-week, next-week, this-month, next-month, this-year, next-year, week-backlog, month-backlog, year-backlog, backlog) or `date` YYYY-MM-DD (optionally `reminderTime` HH:MM, or `period` week/month/year to commit to the period containing that day). Resolve 'Monday' and similar to a date yourself. From a coordinator it is a proposal until the user adds or dismisses it. From the Assistant it is added directly when the user's Assistant settings say 'Add directly' (and allow editing tasks), else proposed; `added` in the result says which.",
  parameters: TaskProposeInput,
  success: TaskProposeResult,
  failure: TaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const TaskUpdateTool = Tool.make("cp_task_update", {
  description:
    "Edit or move one of the user's tasks: title, notes, home (`when`, or `date` YYYY-MM-DD with optional `period`), reminder (HH:MM, null clears), or status (completed / todo). Omitted fields keep their value. The Assistant may edit any task when its task access is 'Read and edit'; a coordinator may edit only tasks its Project proposed, and never completes or reopens them. Nobody but the user adds or dismisses a waiting proposal.",
  parameters: TaskUpdateInput,
  success: TaskUpdateResult,
  failure: TaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Edit a task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsToolkit = Toolkit.make(
  AgentCreateTool,
  AgentListTool,
  AgentReadTool,
  AgentStopTool,
  AgentSettleTool,
  ScheduleListTool,
  ScheduleCreateTool,
  ScheduleUpdateTool,
  ScheduleDeleteTool,
  StatusListTool,
  StatusSetTool,
  TaskListTool,
  TaskProposeTool,
  TaskUpdateTool,
);
