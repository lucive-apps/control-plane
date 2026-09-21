import { McpCapabilityUnavailableError, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
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

export const ThreadSendToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadSendTargetMissingError,
  ThreadSendTargetNotFoundError,
  ThreadSendTargetAmbiguousError,
  ThreadSendSelfError,
  ThreadSendFailedError,
]);
export type ThreadSendToolError = typeof ThreadSendToolError.Type;

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
});
export type ThreadSendResult = typeof ThreadSendResult.Type;

const SendThreadMessageTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to another Control Plane thread. The receiving thread sees this as a tool call named after this thread, not as a user prompt. Pass threadId or the exact thread title.",
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

export const ThreadsToolkit = Toolkit.make(SendThreadMessageTool);
