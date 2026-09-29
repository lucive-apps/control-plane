import {
  McpCapabilityUnavailableError,
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

// Fork-owned. Parameters stay flat primitives: OpenCode stringifies nested unions.

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
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
  AgentToolFailedError,
]);
export type AgentToolError = typeof AgentToolError.Type;

const AgentRef = TrimmedNonEmptyString.annotate({
  description: "The agent's threadId (preferred) or its exact title.",
});

export const AgentPhase = Schema.Literals([
  "idle",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type AgentPhase = typeof AgentPhase.Type;

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
});
export type AgentCreateInput = typeof AgentCreateInput.Type;

export const AgentCreateResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  created: Schema.Boolean.annotate({
    description: "False when clientRequestId matched an agent started earlier.",
  }),
});
export type AgentCreateResult = typeof AgentCreateResult.Type;

export const AgentListInput = Schema.Struct({
  includeSettled: Schema.optional(
    Schema.Boolean.annotate({ description: "Also list agents that settled after reporting." }),
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

const AgentCreateTool = Tool.make("cp_agent_create", {
  description:
    "Start an agent in this Project with a first message. Its final message comes back to you.",
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

export const AgentsToolkit = Toolkit.make(
  AgentCreateTool,
  AgentListTool,
  AgentReadTool,
  AgentStopTool,
);
