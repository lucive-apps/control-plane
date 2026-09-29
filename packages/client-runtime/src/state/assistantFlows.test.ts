import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  expandHomePath,
  isAbsoluteOrHomePath,
  planDefaultModelOverridePatch,
  planNewProjectCommands,
  readFailureMeansMissing,
  resolveNewProjectFolderBase,
  resolveTypedProjectFolder,
  runNewProjectPlan,
  trimTrailingPathSeparators,
  typedProjectFolderError,
  writeMissingScaffoldFiles,
  type BrowseFolder,
  type NewProjectPlanInput,
  type NewProjectPlanRunner,
} from "./assistantFlows.ts";

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

  it("drops trailing separators but keeps a lone root", () => {
    expect(trimTrailingPathSeparators("/Users/n/code/")).toBe("/Users/n/code");
    expect(trimTrailingPathSeparators("~/")).toBe("~");
    expect(trimTrailingPathSeparators("C:\\work\\")).toBe("C:\\work");
    expect(trimTrailingPathSeparators("/")).toBe("/");
    expect(trimTrailingPathSeparators("//")).toBe("/");
    expect(trimTrailingPathSeparators("")).toBe("");
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

const environmentId = EnvironmentId.make("mac");
const MISSING = { failure: "operation_failed", operation: "realpath-target" };
const fail = <A = never>(error: unknown = new Error("boom")) =>
  AsyncResult.failure<A, unknown>(Cause.fail(error));

/** A host filesystem: folder paths (with a trailing slash) to the names inside them. */
function hostBrowse(folders: Record<string, readonly string[]>) {
  const calls: string[] = [];
  const browse: BrowseFolder = async ({ input }) => {
    calls.push(input.partialPath);
    const partialPath = input.partialPath.replace(/^~\//, "/Users/n/");
    const names = folders[partialPath];
    return names === undefined
      ? fail()
      : AsyncResult.success({
          parentPath: partialPath.replace(/(?<=.)\/$/, ""),
          entries: names.map((name) => ({ name })),
        });
  };
  return { browse, calls };
}

describe("resolveNewProjectFolderBase", () => {
  it("lists the base directory with the names already taken there", async () => {
    const { browse, calls } = hostBrowse({ "/srv/projects/": ["personal", "work"] });
    expect(
      await resolveNewProjectFolderBase({
        environmentId,
        addProjectBaseDirectory: " /srv/projects ",
        browse,
      }),
    ).toEqual({
      kind: "ok",
      environmentId,
      parentPath: "/srv/projects",
      existingNames: ["personal", "work"],
    });
    expect(calls).toEqual(["/srv/projects/"]);
  });

  it("falls back to ~/Projects and expands ~ when the base does not exist yet", async () => {
    const { browse, calls } = hostBrowse({ "/Users/n/": [] });
    expect(
      await resolveNewProjectFolderBase({ environmentId, addProjectBaseDirectory: "", browse }),
    ).toEqual({
      kind: "ok",
      environmentId,
      parentPath: "/Users/n/Projects",
      existingNames: [],
    });
    expect(calls).toEqual(["~/Projects/", "~/"]);
  });

  it("has no base when ~ cannot be resolved or the setting is relative", async () => {
    const { browse } = hostBrowse({});
    expect(
      await resolveNewProjectFolderBase({ environmentId, addProjectBaseDirectory: "", browse }),
    ).toEqual({ kind: "error", environmentId });
    expect(
      await resolveNewProjectFolderBase({
        environmentId,
        addProjectBaseDirectory: "projects",
        browse,
      }),
    ).toEqual({ kind: "error", environmentId });
  });
});

describe("resolveTypedProjectFolder", () => {
  const probes: string[] = [];
  const fileExists = async (_: EnvironmentId, cwd: string, relativePath: string) => {
    probes.push(`${cwd}/${relativePath}`);
    return cwd === "/srv/website";
  };
  const resolve = (
    mode: "new" | "existing",
    input: string,
    folders: Record<string, readonly string[]>,
  ) =>
    resolveTypedProjectFolder({
      environmentId,
      mode,
      input,
      browse: hostBrowse(folders).browse,
      fileExists,
    });

  it("resolves an existing folder and reports its AGENTS.md", async () => {
    expect(await resolve("existing", "/srv/website", { "/srv/website/": ["AGENTS.md"] })).toEqual({
      kind: "ok",
      path: "/srv/website",
      hasAgentsFile: true,
    });
    expect(await resolve("existing", "~/code/api/", { "/Users/n/code/api/": [] })).toEqual({
      kind: "ok",
      path: "/Users/n/code/api",
      hasAgentsFile: false,
    });
    expect(probes).toEqual(["/srv/website/AGENTS.md", "/Users/n/code/api/AGENTS.md"]);
  });

  it("refuses an existing folder that is not there", async () => {
    expect(await resolve("existing", "/srv/missing", {})).toEqual({
      kind: "error",
      message: "Folder not found.",
    });
  });

  it("refuses a new folder that already exists", async () => {
    expect(await resolve("new", "/srv/website", { "/srv/website/": [] })).toEqual({
      kind: "error",
      message: "Folder exists. Choose Existing folder.",
    });
  });

  it("expands ~ in a new folder with the host's home", async () => {
    expect(await resolve("new", "~/Projects/personal/", { "/Users/n/": [] })).toEqual({
      kind: "ok",
      path: "/Users/n/Projects/personal",
      hasAgentsFile: false,
    });
    expect(await resolve("new", "~/Projects/personal", {})).toEqual({
      kind: "error",
      message: "Could not resolve ~ on this host.",
    });
    expect(await resolve("new", "/srv/new-project", {})).toEqual({
      kind: "ok",
      path: "/srv/new-project",
      hasAgentsFile: false,
    });
  });

  it("never asks the host about an empty or relative path", async () => {
    const { browse, calls } = hostBrowse({});
    const input = { environmentId, browse, fileExists, mode: "new" as const };
    expect(await resolveTypedProjectFolder({ ...input, input: "  " })).toEqual({
      kind: "error",
      message: "Choose a folder.",
    });
    expect(await resolveTypedProjectFolder({ ...input, input: "Projects/x" })).toEqual({
      kind: "error",
      message: "Enter an absolute path or one starting with ~/.",
    });
    expect(calls).toEqual([]);
    expect(typedProjectFolderError("~/x")).toBeNull();
  });
});

describe("runNewProjectPlan", () => {
  function runner(options: {
    readonly failOn?: string;
    readonly existing?: readonly string[];
    readonly failListing?: boolean;
  }) {
    const log: string[] = [];
    const disk = new Set(options.existing ?? []);
    const step = (name: string) => {
      log.push(name);
      return Promise.resolve(options.failOn === name ? fail() : AsyncResult.success(undefined));
    };
    const run: NewProjectPlanRunner = {
      createProject: () => step("project.create"),
      createThread: () => step("thread.create"),
      updateProject: () => step("project.meta.update"),
      updateSettings: ({ input }) => {
        log.push(`settings:${JSON.stringify(input.patch)}`);
        return Promise.resolve(AsyncResult.success(undefined));
      },
      listEntries: ({ input }) => {
        log.push(`list:${input.cwd}`);
        return Promise.resolve(
          options.failListing
            ? fail()
            : AsyncResult.success({
                entries: [...disk].map((name) => ({ path: `${input.cwd}/${name}` })),
              }),
        );
      },
      readFile: ({ input }) =>
        Promise.resolve(
          disk.has(input.relativePath) ? AsyncResult.success(undefined) : fail(MISSING),
        ),
      writeFile: ({ input }) => {
        log.push(`write:${input.relativePath}`);
        disk.add(input.relativePath);
        return Promise.resolve(AsyncResult.success(undefined));
      },
    };
    return { run, log };
  }

  const baseInput = {
    environmentId,
    folderPath: "/Users/n/Projects/personal",
    instructions: "Write concisely.",
    modelSelection: model,
    overrides: {},
  };

  it("dispatches the plan in order, then writes only the missing Project files", async () => {
    const { run, log } = runner({ existing: ["AGENTS.md"] });
    const result = await runNewProjectPlan({
      ...baseInput,
      plan: plan(),
      supportsOverrides: false,
      run,
    });
    expect(result).toEqual({ ok: true, warnings: [] });
    expect(log).toEqual([
      "project.create",
      "thread.create",
      "project.meta.update",
      "list:/Users/n/Projects/personal",
      "write:CLAUDE.md",
      "write:MEMORY.md",
      // Re-listed so the file view's cached listing shows the new files.
      "list:/Users/n/Projects/personal",
    ]);
  });

  it("stops at the first failed command and names the flow", async () => {
    const { run, log } = runner({ failOn: "thread.create" });
    const result = await runNewProjectPlan({
      ...baseInput,
      plan: plan(),
      supportsOverrides: true,
      run,
    });
    expect(result).toMatchObject({ ok: false, title: "Failed to create Project" });
    expect(log).toEqual(["project.create", "thread.create"]);

    const convert = runner({ failOn: "project.meta.update" });
    expect(
      await runNewProjectPlan({
        ...baseInput,
        plan: plan({ existingWorkspace: { id: ProjectId.make("website"), title: "website" } }),
        supportsOverrides: false,
        run: convert.run,
      }),
    ).toMatchObject({ ok: false, title: "Failed to convert to a Project" });
  });

  it("writes the default-model override only where the host resolves overrides", async () => {
    const withOverrides = runner({ existing: ["AGENTS.md", "CLAUDE.md", "MEMORY.md"] });
    await runNewProjectPlan({
      ...baseInput,
      plan: plan(),
      supportsOverrides: true,
      run: withOverrides.run,
    });
    expect(withOverrides.log).toContain(
      `settings:${JSON.stringify({
        projectSettingsOverrides: { [newProjectId]: { defaultModelSelection: model } },
      })}`,
    );
    // Nothing was missing, so nothing is written or re-listed.
    expect(withOverrides.log.filter((entry) => entry.startsWith("list:"))).toHaveLength(1);

    const without = runner({});
    await runNewProjectPlan({
      ...baseInput,
      plan: plan(),
      supportsOverrides: false,
      run: without.run,
    });
    expect(without.log.some((entry) => entry.startsWith("settings:"))).toBe(false);
  });

  it("keeps the Project when its files cannot be listed", async () => {
    const { run, log } = runner({ failListing: true });
    const result = await runNewProjectPlan({
      ...baseInput,
      plan: plan(),
      supportsOverrides: false,
      run,
    });
    expect(result).toMatchObject({ ok: true, warnings: [{ title: "Project files not added" }] });
    expect(log.some((entry) => entry.startsWith("write:"))).toBe(false);
  });
});
