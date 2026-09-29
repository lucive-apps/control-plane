import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  expandHomePath,
  isAbsoluteOrHomePath,
  planDefaultModelOverridePatch,
  planNewProjectCommands,
  readFailureMeansMissing,
  writeMissingScaffoldFiles,
  type NewProjectPlanInput,
} from "./newProject.logic";

const model = { instanceId: "claude", model: "sonnet-4.5" } as unknown as ModelSelection;
const newProjectId = ProjectId.make("new-project");
const newThreadId = ThreadId.make("new-thread");

function plan(overrides: Partial<NewProjectPlanInput> = {}) {
  return planNewProjectCommands({
    newProjectId,
    newThreadId,
    name: " Personal ",
    resolvedPath: "/Users/n/Projects/personal",
    projectIcon: null,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    existingWorkspace: null,
    existingCoordinatorThreadId: null,
    ...overrides,
  });
}

describe("planNewProjectCommands", () => {
  it("creates the workspace and coordinator for a new or plain folder", () => {
    const result = plan();
    expect(result).toMatchObject({ projectId: newProjectId, coordinatorThreadId: newThreadId });
    expect(result.commands).toEqual([
      {
        type: "project.create",
        input: {
          projectId: newProjectId,
          title: "Personal",
          workspaceRoot: "/Users/n/Projects/personal",
          createWorkspaceRootIfMissing: true,
        },
      },
      {
        type: "thread.create",
        input: {
          threadId: newThreadId,
          projectId: newProjectId,
          title: "Personal",
          modelSelection: model,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      },
      {
        type: "project.meta.update",
        input: {
          projectId: newProjectId,
          defaultModelSelection: model,
          assistant: { coordinatorThreadId: newThreadId },
        },
      },
    ]);
  });

  it("converts an existing workspace with a new coordinator, renaming it", () => {
    const workspaceId = ProjectId.make("website");
    const result = plan({ existingWorkspace: { id: workspaceId, title: "website" } });
    expect(result.projectId).toBe(workspaceId);
    expect(result.commands.map((command) => command.type)).toEqual([
      "thread.create",
      "project.meta.update",
    ]);
    expect(result.commands[0]?.input).toMatchObject({
      projectId: workspaceId,
      modelSelection: model,
    });
    expect(result.commands[1]?.input).toEqual({
      projectId: workspaceId,
      title: "Personal",
      defaultModelSelection: model,
      assistant: { coordinatorThreadId: newThreadId },
    });
  });

  it("promotes an existing thread without creating one", () => {
    const workspaceId = ProjectId.make("website");
    const existing = ThreadId.make("fix-hero");
    const icon = { kind: "emoji", emoji: "🌐" } as const;
    const result = plan({
      name: "website",
      existingWorkspace: { id: workspaceId, title: "website", projectIcon: icon },
      existingCoordinatorThreadId: existing,
      projectIcon: icon,
    });
    expect(result.coordinatorThreadId).toBe(existing);
    expect(result.commands).toEqual([
      {
        type: "project.meta.update",
        input: {
          projectId: workspaceId,
          defaultModelSelection: model,
          assistant: { coordinatorThreadId: existing },
        },
      },
    ]);
  });

  it("sends the icon only when it changes", () => {
    const icon = { kind: "monogram", text: "P", color: "blue" } as never;
    expect(plan({ projectIcon: icon }).commands.at(-1)?.input).toMatchObject({
      projectIcon: icon,
    });
    const cleared = plan({
      existingWorkspace: { id: ProjectId.make("w"), title: "Personal", projectIcon: icon },
    });
    expect(cleared.commands.at(-1)?.input).toMatchObject({ projectIcon: null });
  });
});

describe("planDefaultModelOverridePatch", () => {
  it("replaces the Project's override entry, keeping its other keys", () => {
    const projectId = ProjectId.make("p");
    expect(
      planDefaultModelOverridePatch({
        overrides: { [projectId]: { defaultAutoPull: true } },
        projectId,
        modelSelection: model,
      }),
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, defaultModelSelection: model },
      },
    });
  });
});

describe("folder paths", () => {
  it("accepts only absolute and home-relative inputs", () => {
    expect(isAbsoluteOrHomePath("~/Projects/x")).toBe(true);
    expect(isAbsoluteOrHomePath("/srv/x")).toBe(true);
    expect(isAbsoluteOrHomePath("C:\\work")).toBe(true);
    expect(isAbsoluteOrHomePath("Projects/x")).toBe(false);
    expect(isAbsoluteOrHomePath("./x")).toBe(false);
  });

  it("expands ~ with the host's home", () => {
    expect(expandHomePath("~/Projects/x", "/Users/n")).toBe("/Users/n/Projects/x");
    expect(expandHomePath("~", "/Users/n")).toBe("/Users/n");
    expect(expandHomePath("/srv/x", "/Users/n")).toBe("/srv/x");
    expect(expandHomePath("~/a/b", "C:\\Users\\n")).toBe("C:\\Users\\n\\a\\b");
  });
});

describe("readFailureMeansMissing", () => {
  it("treats only an unresolvable target as a missing file", () => {
    expect(
      readFailureMeansMissing({ failure: "operation_failed", operation: "realpath-target" }),
    ).toBe(true);
    // CLAUDE.md -> ../shared/AGENTS.md resolves outside the folder: present, never written.
    expect(readFailureMeansMissing({ failure: "resolved_path_outside_root" })).toBe(false);
    expect(readFailureMeansMissing({ failure: "operation_failed", operation: "open" })).toBe(false);
    expect(readFailureMeansMissing({ failure: "binary_file" })).toBe(false);
    expect(readFailureMeansMissing(new Error("interrupted"))).toBe(false);
  });
});

describe("writeMissingScaffoldFiles", () => {
  it("leaves the file view's read cache holding the files it wrote", async () => {
    const disk = new Map([["AGENTS.md", "mine"]]);
    const missing = { failure: "operation_failed", operation: "realpath-target" };
    // Shaped like projects.readFile: SWR over a node that outlives its readers.
    const readAtom = Atom.family((relativePath: string) =>
      Atom.make(
        Effect.suspend(() => {
          const contents = disk.get(relativePath);
          return contents === undefined ? Effect.fail(missing) : Effect.succeed(contents);
        }),
      ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000)),
    );
    const registry = AtomRegistry.make();
    try {
      const result = await writeMissingScaffoldFiles({
        files: [
          { relativePath: "AGENTS.md", contents: "template" },
          { relativePath: "MEMORY.md", contents: "# Memory" },
        ],
        read: (relativePath) =>
          executeAtomQuery(registry, readAtom(relativePath), {
            refresh: true,
            reportFailure: false,
          }),
        write: async (relativePath, contents) => {
          disk.set(relativePath, contents);
          return AsyncResult.success(undefined);
        },
      });

      expect(result).toEqual({ written: ["MEMORY.md"], failed: [] });
      expect(disk.get("AGENTS.md")).toBe("mine");
      // Opening the Memory tab mounts the same atom without forcing a read.
      const unmount = registry.mount(readAtom("MEMORY.md"));
      expect(registry.get(readAtom("MEMORY.md"))).toMatchObject({
        _tag: "Success",
        value: "# Memory",
      });
      unmount();
    } finally {
      registry.dispose();
    }
  });
});
