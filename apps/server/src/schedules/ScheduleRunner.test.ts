import {
  CommandId,
  MessageId,
  OrchestrationAgentMessageSource,
  ProjectId,
  ScheduleUnavailableError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import { HostTimeZoneSource } from "./hostZone.ts";
import * as ScheduleRunner from "./ScheduleRunner.ts";
import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
  type ScheduleEngineServices,
} from "./schedules.testFixtures.ts";

const PROJECT = ProjectId.make("project-personal");
const OTHER = ProjectId.make("project-work");
const COORDINATOR = ThreadId.make("coordinator");
const OTHER_COORDINATOR = ThreadId.make("work-coordinator");
const SALES = ThreadId.make("standing-sales");
// Schedules are written at 12:00 and `0 13 * * *` is due at 13:00 (UTC unless noted).
const WRITTEN_AT = "2026-09-28T12:00:00.000Z";
const SLOT = "2026-09-28T13:00:00.000Z";
const DAILY = "0 13 * * *";

const dateAt = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const decodeSource = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationAgentMessageSource),
);

/** The test clock with timers that never fire, as on a sleeping Mac: the wall clock moves on, timers wait. */
const withTimersAsleep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.testClockWith((clock) =>
    Effect.provideService(effect, Clock.Clock, { ...clock, sleep: () => Effect.never }),
  );

const test = <A, E>(name: string, body: Effect.Effect<A, E, ScheduleEngineServices>) =>
  it.effect(name, () => body.pipe(Effect.provide(makeScheduleEngineLayer("t3-schedule-runner-"))));

const makeRunnerFixture = (zone = "UTC") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(WRITTEN_AT));
    const f = yield* makeScheduleFixture;
    yield* f.createProject(PROJECT, COORDINATOR, "Personal");

    /** Runs `body` with a started runner reading crons in `zone`, then stops it. */
    const withRunner = <A, E, R>(
      body: (runner: ScheduleRunner.ScheduleRunner["Service"]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const runner = yield* ScheduleRunner.ScheduleRunner;
        yield* runner.start();
        yield* runner.drain;
        return yield* body(runner);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ScheduleRunner.layer.pipe(
            Layer.provide(Layer.succeed(HostTimeZoneSource, () => ({ zone, processZone: zone }))),
          ),
        ),
      );

    /** A fire from the OS entry at `iso`. */
    const fireAt = (runner: ScheduleRunner.ScheduleRunner["Service"], iso: string) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(iso));
        yield* runner.requestFire(dateAt(iso));
        yield* runner.drain;
      });

    const messageIds = (threadId: ThreadId) =>
      f.userMessages(threadId).pipe(Effect.map((rows) => rows.map((row) => row.id)));

    return { ...f, withRunner, fireAt, messageIds };
  });

const cronMessage = (projectId: ProjectId, scheduleId: string, slot = SLOT) =>
  `cp-schedule:${projectId}:${scheduleId}:${slot}`;

describe("ScheduleRunner fires", () => {
  test(
    "appends a due run once, with ids built from the Project, schedule and slot",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [
        { id: "daily", name: "Morning brief", cron: DAILY, prompt: "Brief me." },
      ]);

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          // The OS may fire again for the same slot; it already ran.
          yield* f.fireAt(runner, "2026-09-28T13:05:00.000Z");
        }),
      );

      const messageId = cronMessage(PROJECT, "daily");
      const messages = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(
        messages.map(({ id, text, createdAt }) => ({ id, text, createdAt })),
        [{ id: messageId, text: "Brief me.", createdAt: "2026-09-28T13:00:30.000Z" }],
      );
      assert.deepStrictEqual(decodeSource(messages[0]!.source), {
        kind: "agent",
        threadTitle: "Morning brief",
        scheduleId: "daily",
      });
      assert.deepStrictEqual(yield* f.receipts("cp-schedule"), [
        `accepted cp-schedule-run:${PROJECT}:daily:${SLOT}`,
        `accepted ${messageId}`,
      ]);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:00:30.000Z",
        trigger: "cron",
        outcome: "sent",
        threadId: COORDINATOR,
      });
    }),
  );

  test(
    "skips a slot from before the schedule was armed",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* TestClock.setTime(Date.parse("2026-09-28T13:10:00.000Z"));
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:10:30.000Z"));

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
    }),
  );

  test(
    "records a slot over 2 hours late as late, and a gone target as target-missing",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.createThread(PROJECT, SALES, "Sales", { pinned: true });
      yield* f.setSchedules(PROJECT, [
        { id: "daily", cron: DAILY },
        { id: "pipeline", cron: "0 15 * * *", target: SALES },
      ]);
      yield* f.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(f.nextId("archive-sales")),
        threadId: SALES,
      });

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T15:00:01.000Z"));

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {
        daily: {
          slot: SLOT,
          at: "2026-09-28T15:00:01.000Z",
          trigger: "cron",
          outcome: "missed",
          reason: "late",
        },
        pipeline: {
          slot: "2026-09-28T15:00:00.000Z",
          at: "2026-09-28T15:00:01.000Z",
          trigger: "cron",
          outcome: "missed",
          reason: "target-missing",
        },
      });
      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
    }),
  );

  test(
    "records a refused append as rejected",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      // A foreign message already holds the id the run would append.
      const messageId = MessageId.make(cronMessage(PROJECT, "daily"));
      yield* f.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("foreign-append"),
        threadId: COORDINATOR,
        message: { messageId, text: "Imposter", attachments: [] },
        createdAt: WRITTEN_AT,
      });

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:00:30.000Z"));

      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:00:30.000Z",
        trigger: "cron",
        outcome: "missed",
        reason: "rejected",
        threadId: COORDINATOR,
      });
    }),
  );

  test(
    "keeps runs of the same schedule id apart across Projects",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.createProject(OTHER, OTHER_COORDINATOR, "Work");
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSchedules(OTHER, [{ id: "daily", cron: DAILY }]);

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:00:30.000Z"));

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [cronMessage(PROJECT, "daily")]);
      assert.deepStrictEqual(yield* f.messageIds(OTHER_COORDINATOR), [cronMessage(OTHER, "daily")]);
    }),
  );

  test(
    "asks a standing agent to reply to the coordinator, and the coordinator to reply to no one",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.createThread(PROJECT, SALES, "Sales", { pinned: true });
      yield* f.setSchedules(PROJECT, [
        { id: "daily", cron: DAILY },
        { id: "pipeline", name: "Pipeline check", cron: DAILY, target: SALES },
      ]);

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:00:30.000Z"));

      const [toSales] = yield* f.userMessages(SALES);
      assert.deepStrictEqual(decodeSource(toSales!.source), {
        kind: "agent",
        threadTitle: "Pipeline check",
        scheduleId: "pipeline",
        replyTo: COORDINATOR,
      });
      const [toCoordinator] = yield* f.userMessages(COORDINATOR);
      assert.notProperty(decodeSource(toCoordinator!.source), "replyTo");
    }),
  );

  test(
    "reads crons in the host zone, not the process zone",
    Effect.gen(function* () {
      vi.stubEnv("TZ", "UTC");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const f = yield* makeRunnerFixture("America/Boise");
      yield* f.setSchedules(PROJECT, [{ id: "morning", cron: "0 7 * * *" }]);

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:00:30.000Z"));

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [
        cronMessage(PROJECT, "morning", "2026-09-28T13:00:00.000Z"),
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("ScheduleRunner holds", () => {
  test(
    "holds a run while the target works and appends it once when it goes idle",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {
            daily: { since: "2026-09-28T13:00:30.000Z" },
          });

          yield* TestClock.setTime(Date.parse("2026-09-28T13:04:00.000Z"));
          yield* runner.drain;
          assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {});
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [cronMessage(PROJECT, "daily")]);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:04:00.000Z",
        trigger: "cron",
        outcome: "sent",
        reason: "busy",
        threadId: COORDINATOR,
      });
    }),
  );

  test(
    "releases a run held by a start no session took, on the 30-second re-check",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-09-28T13:00:00.000Z"));
          yield* f.sendUserMessage(COORDINATOR, MessageId.make("user-message"));
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          yield* TestClock.adjust("90 seconds");
          yield* runner.drain;
          // The start is two minutes old at 13:02:00 and treated as lost after that.
          assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), ["user-message"]);
          yield* TestClock.adjust("30 seconds");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [
        "user-message",
        cronMessage(PROJECT, "daily"),
      ]);
    }),
  );

  test(
    "records a run held 15 minutes as busy and never appends it",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          yield* TestClock.adjust("14 minutes");
          yield* runner.drain;
          assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
          yield* TestClock.adjust("1 minute");
          yield* runner.drain;
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {});
          // Idle again: nothing is left to send.
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:15:30.000Z",
        trigger: "cron",
        outcome: "missed",
        reason: "busy",
        threadId: COORDINATOR,
      });
    }),
  );

  test(
    "records a held run as busy when its target goes idle after the host slept past 15 minutes",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* withTimersAsleep(
        f.withRunner((runner) =>
          Effect.gen(function* () {
            yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
            // The lid opens at 21:00 and the user's turn ends before any re-check runs.
            yield* TestClock.setTime(Date.parse("2026-09-28T21:00:00.000Z"));
            yield* f.setSession(COORDINATOR, "ready");
            yield* runner.drain;
          }),
        ),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T21:00:00.000Z",
        trigger: "cron",
        outcome: "missed",
        reason: "busy",
        threadId: COORDINATOR,
      });
    }),
  );

  test(
    "drops a held slot that the host recorded as missed in the meantime",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          // At startup the host turns a fire the CLI logged as server-down into a miss.
          yield* ScheduleRunner.recordScheduleRun(f.engine, {
            projectId: PROJECT,
            scheduleId: "daily",
            runKey: ScheduleRunner.cronRunKey(PROJECT, "daily", SLOT),
            run: {
              slot: SLOT,
              at: "2026-09-28T13:00:30.000Z",
              trigger: "cron",
              outcome: "missed",
              reason: "not-running",
            },
          });
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {});
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
      assert.strictEqual((yield* f.runsOf(PROJECT)).daily?.reason, "not-running");
    }),
  );

  test(
    "keeps a held Run now when a later fire finds the schedule's older slot unrun",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          yield* TestClock.setTime(Date.parse("2026-09-28T13:05:00.000Z"));
          assert.deepStrictEqual(yield* runner.runNow(PROJECT, "daily"), { outcome: "held" });
          // Another schedule's fire: the Run now replaced this schedule's 13:00 hold, so 13:00 is unrun.
          yield* f.fireAt(runner, "2026-09-28T13:10:00.000Z");
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {
            daily: { since: "2026-09-28T13:05:00.000Z" },
          });
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
        }),
      );

      const ids = yield* f.messageIds(COORDINATOR);
      assert.lengthOf(ids, 1);
      assert.match(ids[0]!, new RegExp(`^cp-schedule:${PROJECT}:daily:manual:`));
      assert.strictEqual((yield* f.runsOf(PROJECT)).daily?.trigger, "manual");
    }),
  );

  test(
    "keeps one hold per schedule when Run now is pressed twice on a busy target",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* runner.runNow(PROJECT, "daily"), { outcome: "held" });
          yield* TestClock.adjust("10 seconds");
          assert.deepStrictEqual(yield* runner.runNow(PROJECT, "daily"), { outcome: "held" });
          assert.deepStrictEqual(Object.keys(yield* runner.holds(PROJECT)), ["daily"]);
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
        }),
      );

      const ids = yield* f.messageIds(COORDINATOR);
      assert.lengthOf(ids, 1);
      assert.match(ids[0]!, new RegExp(`^cp-schedule:${PROJECT}:daily:manual:`));
      assert.strictEqual((yield* f.runsOf(PROJECT)).daily?.slot, "2026-09-28T12:00:10.000Z");
    }),
  );

  test(
    "appends one run per target per pass, oldest first",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [
        { id: "first", cron: DAILY },
        { id: "second", cron: DAILY },
      ]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
          assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [cronMessage(PROJECT, "first")]);
          yield* TestClock.adjust("30 seconds");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [
        cronMessage(PROJECT, "first"),
        cronMessage(PROJECT, "second"),
      ]);
    }),
  );

  test(
    "drops a held run when its schedule is paused",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-user"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY, enabled: false }]);
          yield* runner.drain;
          assert.deepStrictEqual(yield* runner.holds(PROJECT), {});
          yield* f.setSession(COORDINATOR, "ready");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
    }),
  );
});

describe("ScheduleRunner scope and Run now", () => {
  test(
    "skips archived Projects, and refuses Run now on them",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* f.archiveProject(PROJECT, true);

      const refused = yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          return yield* runner.runNow(PROJECT, "daily").pipe(Effect.flip);
        }),
      );

      assert.instanceOf(refused, ScheduleUnavailableError);
      assert.strictEqual(refused.reason, "archived");
      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), []);
    }),
  );

  test(
    "sends a paused schedule on Run now, with a new id each time",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY, enabled: false }]);

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* runner.runNow(PROJECT, "daily"), { outcome: "sent" });
          yield* TestClock.adjust("1 second");
          assert.deepStrictEqual(yield* runner.runNow(PROJECT, "daily"), { outcome: "sent" });
          const unknown = yield* runner.runNow(PROJECT, "nope").pipe(Effect.flip);
          assert.strictEqual(unknown.reason, "unknown-schedule");
        }),
      );

      const ids = yield* f.messageIds(COORDINATOR);
      assert.lengthOf(ids, 2);
      assert.notStrictEqual(ids[0], ids[1]);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: "2026-09-28T12:00:01.000Z",
        at: "2026-09-28T12:00:01.000Z",
        trigger: "manual",
        outcome: "sent",
        threadId: COORDINATOR,
      });
    }),
  );
});

describe("ScheduleRunner outcomes", () => {
  test(
    "re-records a sent run whose turn errors as failed, with the turn",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      const messageId = MessageId.make(cronMessage(PROJECT, "daily"));

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          yield* f.fireAt(runner, "2026-09-28T13:00:30.000Z");
          // As M3's reactor starts it.
          yield* f.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cp-start:${messageId}`),
            threadId: COORDINATOR,
            message: { messageId, role: "user", text: "Run daily.", attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: yield* f.now,
          });
          yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-daily"));
          yield* f.setSession(COORDINATOR, "error", null, "Model overloaded");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:00:30.000Z",
        trigger: "cron",
        outcome: "failed",
        threadId: COORDINATOR,
        turnId: TurnId.make("turn-daily"),
      });
      assert.include(
        yield* f.receipts("cp-schedule-run:"),
        `accepted cp-schedule-run:${PROJECT}:daily:${SLOT}:final`,
      );
    }),
  );

  test(
    "records a failed turn for a run whose append landed before a crash and whose record came after",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      const messageId = MessageId.make(cronMessage(PROJECT, "daily"));
      // A server appended the 13:00 run, then stopped before recording it.
      yield* f.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId: COORDINATOR,
        message: {
          messageId,
          text: "Run daily.",
          attachments: [],
          source: { kind: "agent", threadTitle: "daily", scheduleId: "daily" },
        },
        createdAt: "2026-09-28T13:00:30.000Z",
      });

      yield* f.withRunner((runner) =>
        Effect.gen(function* () {
          // The CLI's retry reaches the restarted server; the append is already on file.
          yield* f.fireAt(runner, "2026-09-28T13:02:00.000Z");
          yield* f.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cp-start:${messageId}`),
            threadId: COORDINATOR,
            message: { messageId, role: "user", text: "Run daily.", attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: yield* f.now,
          });
          yield* f.setSession(COORDINATOR, "running", TurnId.make("turn-daily"));
          yield* f.setSession(COORDINATOR, "error", null, "Model overloaded");
          yield* runner.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.messageIds(COORDINATOR), [messageId]);
      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:02:00.000Z",
        trigger: "cron",
        outcome: "failed",
        threadId: COORDINATOR,
        turnId: TurnId.make("turn-daily"),
      });
    }),
  );

  test(
    "re-records a sent run whose start was refused as rejected, after a restart",
    Effect.gen(function* () {
      const f = yield* makeRunnerFixture();
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      const messageId = MessageId.make(cronMessage(PROJECT, "daily"));

      yield* f.withRunner((runner) => f.fireAt(runner, "2026-09-28T13:00:30.000Z"));
      yield* f.engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cp-start:${messageId}`),
          threadId: COORDINATOR,
          message: { messageId, role: "user", text: "Run daily.", attachments: [] },
          runtimeMode: "full-access",
          interactionMode: "default",
          sourceProposedPlan: { threadId: COORDINATOR, planId: "missing-plan" },
          createdAt: yield* f.now,
        })
        .pipe(Effect.ignore);
      yield* f.withRunner(() => Effect.void);

      assert.deepStrictEqual((yield* f.runsOf(PROJECT)).daily, {
        slot: SLOT,
        at: "2026-09-28T13:00:30.000Z",
        trigger: "cron",
        outcome: "missed",
        reason: "rejected",
        threadId: COORDINATOR,
      });
    }),
  );
});
