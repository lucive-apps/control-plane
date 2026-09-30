import {
  CommandId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { isProjectReorderOnlyPayload } from "./projectOrderEvents.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");

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

function makeReadModel(overrides: Partial<OrchestrationProject> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [makeProject(overrides)],
    threads: [],
    updatedAt: NOW,
  };
}

const reorder = (
  orderKey: string,
  extra: { readonly ifKeyless?: true } = {},
): Extract<OrchestrationCommand, { type: "project.reorder" }> => ({
  type: "project.reorder",
  commandId: CommandId.make(`cmd-reorder-${orderKey}`),
  projectId: PROJECT_ID,
  orderKey,
  ...extra,
});

it.layer(NodeServices.layer)("project ordering", (it) => {
  it.effect("stores the key without changing the project's updatedAt", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({ updatedAt: "2025-06-01T00:00:00.000Z" });
      for (const orderKey of ["m", "m", "g"]) {
        const decided = yield* decideOrchestrationCommand({
          command: reorder(orderKey),
          readModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "project.meta-updated",
          payload: { projectId: PROJECT_ID, orderKey, updatedAt: "2025-06-01T00:00:00.000Z" },
        });
        expect(isProjectReorderOnlyPayload(events[0]!.payload)).toBe(true);
        for (const event of events) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        expect(readModel.projects[0]).toMatchObject({
          orderKey,
          updatedAt: "2025-06-01T00:00:00.000Z",
        });
      }
    }),
  );

  it.effect("ifKeyless refuses to overwrite an existing key but seeds a keyless project", () =>
    Effect.gen(function* () {
      const keyed = yield* decideOrchestrationCommand({
        command: reorder("m", { ifKeyless: true }),
        readModel: makeReadModel({ orderKey: "g" }),
      }).pipe(Effect.flip);
      expect(keyed._tag).toBe("OrchestrationCommandInvariantError");

      const decided = yield* decideOrchestrationCommand({
        command: reorder("m", { ifKeyless: true }),
        readModel: makeReadModel({ orderKey: null }),
      });
      expect(Array.isArray(decided) ? decided[0] : decided).toMatchObject({
        payload: { orderKey: "m" },
      });
    }),
  );

  it.effect("rejects a missing or deleted project", () =>
    Effect.gen(function* () {
      const missing = yield* decideOrchestrationCommand({
        command: { ...reorder("m"), projectId: ProjectId.make("nope") },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("OrchestrationCommandInvariantError");
      const deleted = yield* decideOrchestrationCommand({
        command: reorder("m"),
        readModel: makeReadModel({ deletedAt: NOW }),
      }).pipe(Effect.flip);
      expect(deleted._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("a rename after a reorder keeps the key and only then bumps updatedAt", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({ orderKey: "m" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-rename"),
          projectId: PROJECT_ID,
          title: "Renamed",
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(isProjectReorderOnlyPayload(events[0]!.payload)).toBe(false);
      for (const event of events) {
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      }
      expect(readModel.projects[0]).toMatchObject({ title: "Renamed", orderKey: "m" });
    }),
  );

  it.effect("clears the key when a Project converts back to a workspace", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        orderKey: "m",
        assistant: { coordinatorThreadId: "thread-1" as never },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-convert"),
          projectId: PROJECT_ID,
          assistant: null,
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.at(-1)).toMatchObject({ payload: { assistant: null, orderKey: null } });
    }),
  );
});
