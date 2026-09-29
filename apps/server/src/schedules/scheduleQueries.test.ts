import { CommandId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { makeScheduleQueries } from "./scheduleQueries.ts";
import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
  type ScheduleEngineServices,
} from "./schedules.testFixtures.ts";

const PROJECT = ProjectId.make("project-personal");
const COORDINATOR = ThreadId.make("coordinator");
const MESSAGE = MessageId.make(`cp-schedule:${PROJECT}:daily:2026-09-28T13:00:00.000Z`);
const AT = "2026-09-28T13:00:05.000Z";

/** A scheduled prompt appended at AT, then started the way M3's reactor starts it. */
const setup = (options: { readonly start?: "accepted" | "rejected" } = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(AT));
    const f = yield* makeScheduleFixture;
    yield* f.createProject(PROJECT, COORDINATOR, "Personal");
    yield* f.dispatch({
      type: "thread.message.user.append",
      commandId: CommandId.make(MESSAGE),
      threadId: COORDINATOR,
      message: {
        messageId: MESSAGE,
        text: "Brief me.",
        attachments: [],
        source: { kind: "agent", threadTitle: "Daily", scheduleId: "daily" },
      },
      createdAt: AT,
    });
    if (options.start !== undefined) {
      yield* f.engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cp-start:${MESSAGE}`),
          threadId: COORDINATOR,
          message: { messageId: MESSAGE, role: "user", text: "Brief me.", attachments: [] },
          runtimeMode: "full-access",
          interactionMode: "default",
          // A plan that does not exist makes the decider refuse the start.
          ...(options.start === "rejected"
            ? { sourceProposedPlan: { threadId: COORDINATOR, planId: "missing-plan" } }
            : {}),
          createdAt: AT,
        })
        .pipe(Effect.ignore);
    }
    const queries = makeScheduleQueries(yield* SqlClient.SqlClient);
    const outcome = queries.runOutcome({ threadId: COORDINATOR, messageId: MESSAGE });
    return { f, queries, outcome };
  });

const test = <A, E>(name: string, body: Effect.Effect<A, E, ScheduleEngineServices>) =>
  it.effect(name, () => body.pipe(Effect.provide(makeScheduleEngineLayer("t3-schedule-queries-"))));

describe("scheduleQueries.runOutcome", () => {
  test(
    "reads an errored turn of the scheduled message as failed, with its turn",
    Effect.gen(function* () {
      const { f, outcome } = yield* setup({ start: "accepted" });
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-1"));
      assert.isNull(yield* outcome);
      yield* f.setSession(COORDINATOR, "error", null, "Model overloaded");
      assert.deepStrictEqual(yield* outcome, { kind: "failed", turnId: TurnId.make("turn-1") });
    }),
  );

  test(
    "reads a provider start failure for the message as rejected",
    Effect.gen(function* () {
      const { f, outcome } = yield* setup({ start: "accepted" });
      yield* f.appendActivity(COORDINATOR, "provider.turn.start.failed", {
        requestId: MESSAGE,
        detail: "Provider unavailable",
      });
      assert.deepStrictEqual(yield* outcome, { kind: "rejected" });
    }),
  );

  test(
    "reads a refused turn start as rejected",
    Effect.gen(function* () {
      const { f, outcome } = yield* setup({ start: "rejected" });
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`rejected cp-start:${MESSAGE}`]);
      assert.deepStrictEqual(yield* outcome, { kind: "rejected" });
    }),
  );

  test(
    "reads nothing for a turn that finished well",
    Effect.gen(function* () {
      const { f, outcome } = yield* setup({ start: "accepted" });
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-1"));
      yield* f.setSession(COORDINATOR, "ready");
      assert.isNull(yield* outcome);
    }),
  );

  test(
    "finds a Run now's message by its schedule and time, not a cron run's",
    Effect.gen(function* () {
      const { f, queries } = yield* setup();
      const lookup = (scheduleId: string, at: string) =>
        queries.manualRunMessageId({ threadId: COORDINATOR, projectId: PROJECT, scheduleId, at });
      // Only the cron run's message was appended at AT so far.
      assert.isNull(yield* lookup("daily", AT));
      const manual = MessageId.make(`cp-schedule:${PROJECT}:daily:manual:0b6e1c1e`);
      yield* f.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(manual),
        threadId: COORDINATOR,
        message: { messageId: manual, text: "Brief me.", attachments: [] },
        createdAt: AT,
      });

      assert.strictEqual(yield* lookup("daily", AT), manual);
      assert.isNull(yield* lookup("daily", "2026-09-28T13:00:06.000Z"));
      assert.isNull(yield* lookup("weekly", AT));
    }),
  );
});
