import * as Schema from "effect/Schema";

import { ProjectScheduleId, ProjectScheduleMissReason } from "./assistants.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

// Fork-owned. Project schedules: host status and the two schedule RPCs.

/** The OS scheduler an environment's host would install its entry into. */
export const ProjectScheduler = Schema.Literals(["launchd", "systemd", "task-scheduler", "none"]);
export type ProjectScheduler = typeof ProjectScheduler.Type;

export const ScheduleHostProblem = Schema.Literals([
  "no-gui-session",
  "no-user-manager",
  "no-linger",
  "entry-disabled",
  "zone-mismatch",
  "ephemeral-path",
  "install-failed",
  "unsupported-platform",
  "backend-off",
]);
export type ScheduleHostProblem = typeof ScheduleHostProblem.Type;

export const ScheduleHostStatus = Schema.Struct({
  scheduler: ProjectScheduler,
  /** `dry-run` writes the would-be entry to disk and never installs it. */
  backend: Schema.Literals(["os", "dry-run", "none"]),
  timeZone: TrimmedNonEmptyString,
  entry: Schema.Struct({
    state: Schema.Literals(["installed", "not-needed", "dry-run", "failed", "unsupported"]),
    path: Schema.optional(Schema.String),
    /** Dry-run only: the command the OS entry would run. */
    fireCommand: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }),
  problems: ForwardCompatibleArray(ScheduleHostProblem),
  /** The zone `/etc/localtime` names, when it differs from `timeZone`. */
  hostZone: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduleHostStatus = typeof ScheduleHostStatus.Type;

export const SchedulesStatusInput = Schema.Struct({
  projectId: ProjectId,
});
export type SchedulesStatusInput = typeof SchedulesStatusInput.Type;

export const SchedulesStatusResult = Schema.Struct({
  host: ScheduleHostStatus,
  /** Prompt per schedule id. The shell never carries them. */
  prompts: Schema.Record(Schema.String, Schema.String),
  /** Runs waiting for a busy target, per schedule id. */
  held: Schema.Record(Schema.String, Schema.Struct({ since: IsoDateTime })),
});
export type SchedulesStatusResult = typeof SchedulesStatusResult.Type;

export const SchedulesRunInput = Schema.Struct({
  projectId: ProjectId,
  scheduleId: ProjectScheduleId,
});
export type SchedulesRunInput = typeof SchedulesRunInput.Type;

export const SchedulesRunResult = Schema.Struct({
  outcome: Schema.Literals(["sent", "held", "missed"]),
  reason: Schema.optional(ProjectScheduleMissReason),
});
export type SchedulesRunResult = typeof SchedulesRunResult.Type;

export class ScheduleUnavailableError extends Schema.TaggedError<ScheduleUnavailableError>()(
  "ScheduleUnavailableError",
  { reason: Schema.Literals(["archived", "unknown-schedule", "backend-off"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "archived":
        return "This Project is archived. Unarchive it to run its schedules.";
      case "unknown-schedule":
        return "That schedule no longer exists.";
      case "backend-off":
        return "Schedules are not running on this host.";
    }
  }
}
