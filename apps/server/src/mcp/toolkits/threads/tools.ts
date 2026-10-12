import { McpCapabilityUnavailableError, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentPhase } from "../../../agentMachines/agentPhase.ts";
import * as RemoteAgents from "../../../agentMachines/RemoteAgents.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  RemoteAgents.RemoteAgents,
];

export class ThreadSendTargetMissingError extends Schema.TaggedError<ThreadSendTargetMissingError>()(
  "ThreadSendTargetMissingError",
  {},
) {
  override get message(): string {
    return "Pass threadId or threadTitle of the thread to message.";
  }
}

export class ThreadSendTargetNotFoundError extends Schema.TaggedError<ThreadSendTargetNotFoundError>()(
  "ThreadSendTargetNotFoundError",
  { query: Schema.String },
) {
  override get message(): string {
    return `No thread matched ${this.query}.`;
  }
}

export class ThreadSendTargetAmbiguousError extends Schema.TaggedError<ThreadSendTargetAmbiguousError>()(
  "ThreadSendTargetAmbiguousError",
  { title: Schema.String },
) {
  override get message(): string {
    return `Several threads are titled '${this.title}'. Pass threadId instead.`;
  }
}

export class ThreadSendSelfError extends Schema.TaggedError<ThreadSendSelfError>()(
  "ThreadSendSelfError",
  {},
) {
  override get message(): string {
    return "A thread cannot message itself.";
  }
}

export class ThreadSendFailedError extends Schema.TaggedError<ThreadSendFailedError>()(
  "ThreadSendFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not send the message.";
  }
}

export const ThreadSendInput = Schema.Struct({
  message: TrimmedNonEmptyString.annotate({
    description: "The text to send to the other thread. It is delivered as an agent message.",
  }),
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Exact thread id. Preferred when you have it.",
    }),
  ),
  threadTitle: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Exact thread title. Used when threadId is omitted.",
    }),
  ),
});
export type ThreadSendInput = typeof ThreadSendInput.Type;

export const ThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  threadTitle: TrimmedNonEmptyString,
  /** The target was busy, so the message waits for its turn to end. */
  queued: Schema.Boolean,
});
export type ThreadSendResult = typeof ThreadSendResult.Type;

export class PeerMessagingUnavailableError extends Schema.TaggedError<PeerMessagingUnavailableError>()(
  "PeerMessagingUnavailableError",
  {},
) {
  override get message(): string {
    return "Only threads in a Control Plane Project can message its agents.";
  }
}

export class PeerNotFoundError extends Schema.TaggedError<PeerNotFoundError>()(
  "PeerNotFoundError",
  { to: Schema.String },
) {
  override get message(): string {
    return `No active agent in this Project matched ${this.to}. Call cp_agent_peers for the list.`;
  }
}

export class PeerAmbiguousError extends Schema.TaggedError<PeerAmbiguousError>()(
  "PeerAmbiguousError",
  { to: Schema.String },
) {
  override get message(): string {
    return `Several agents in this Project are titled '${this.to}'. Pass its threadId instead.`;
  }
}

export class PeerBudgetExhaustedError extends Schema.TaggedError<PeerBudgetExhaustedError>()(
  "PeerBudgetExhaustedError",
  { to: Schema.String, limit: Schema.Number, perSender: Schema.Boolean },
) {
  override get message(): string {
    return this.perSender
      ? `You already sent ${this.to} ${this.limit} messages since the user or coordinator last gave it work. Wait for it, or ask the coordinator.`
      : `${this.to} already has ${this.limit} messages from other agents since the user or coordinator last gave it work. Ask the coordinator instead.`;
  }
}

export const ThreadSendToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadSendTargetMissingError,
  ThreadSendTargetNotFoundError,
  ThreadSendTargetAmbiguousError,
  ThreadSendSelfError,
  ThreadSendFailedError,
  PeerBudgetExhaustedError,
]);
export type ThreadSendToolError = typeof ThreadSendToolError.Type;

export const AgentMessageToolError = Schema.Union([
  McpCapabilityUnavailableError,
  PeerMessagingUnavailableError,
  PeerNotFoundError,
  PeerAmbiguousError,
  PeerBudgetExhaustedError,
  ThreadSendSelfError,
  ThreadSendFailedError,
]);
export type AgentMessageToolError = typeof AgentMessageToolError.Type;

export const AgentMessageInput = Schema.Struct({
  to: TrimmedNonEmptyString.annotate({
    description:
      "The agent's threadId, or its exact title within this Project. cp_agent_peers lists them.",
  }),
  message: TrimmedNonEmptyString.annotate({
    description: "The text to send. The recipient sees which agent and thread sent it.",
  }),
  notifyCoordinator: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Default true: the coordinator gets a short heads-up it reads on its next turn, without being woken. Set false only for trivial chatter such as acknowledgements.",
    }),
  ),
});
export type AgentMessageInput = typeof AgentMessageInput.Type;

export const AgentMessageResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  /** The recipient was busy, so the message waits for its turn to end. */
  queued: Schema.Boolean,
  /** The same text was already waiting for or read by the recipient, so nothing was sent. */
  duplicate: Schema.Boolean,
  coordinatorNotified: Schema.Boolean,
  machine: Schema.NullOr(Schema.String),
});
export type AgentMessageResult = typeof AgentMessageResult.Type;

const SendThreadMessageTool = Tool.make("cp_thread_send", {
  description:
    "Send a message to another Control Plane thread. The receiving thread sees this as a tool call named after this thread, not as a user prompt. Pass threadId or the exact thread title. To message another agent in your Project, prefer cp_agent_message.",
  parameters: ThreadSendInput,
  success: ThreadSendResult,
  failure: ThreadSendToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message another thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const AgentMessageTool = Tool.make("cp_agent_message", {
  description:
    "Message another agent in your Control Plane Project directly, including the coordinator. Not a request: no result comes back automatically, the recipient replies with its own cp_agent_message. A busy recipient gets it when its turn ends. By default the coordinator gets a heads-up.",
  parameters: AgentMessageInput,
  success: AgentMessageResult,
  failure: AgentMessageToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message an agent in this Project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AgentPeerRole = Schema.Literals(["coordinator", "standing", "agent"]);
export type AgentPeerRole = typeof AgentPeerRole.Type;

export const AgentPeer = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  role: AgentPeerRole,
  phase: AgentPhase,
  machine: Schema.NullOr(Schema.String).annotate({
    description: "The linked machine the agent runs on, or null for this one.",
  }),
});
export type AgentPeer = typeof AgentPeer.Type;

export const AgentPeersResult = Schema.Struct({
  self: Schema.Struct({ threadId: ThreadId, title: Schema.String, role: AgentPeerRole }),
  peers: Schema.Array(AgentPeer),
});
export type AgentPeersResult = typeof AgentPeersResult.Type;

const AgentPeersTool = Tool.make("cp_agent_peers", {
  description:
    "List the active agents in your Control Plane Project (title, threadId, role, phase) so you can message them with cp_agent_message.",
  // No parameters: an empty struct serializes as `anyOf [object, array]`, which MCP rejects.
  success: AgentPeersResult,
  failure: Schema.Union([
    McpCapabilityUnavailableError,
    PeerMessagingUnavailableError,
    ThreadSendFailedError,
  ]),
  dependencies,
})
  .annotate(Tool.Title, "List agents in this Project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(SendThreadMessageTool, AgentMessageTool, AgentPeersTool);
