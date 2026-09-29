import type {
  CreateProjectInput,
  CreateThreadInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/operations";
import { planAssistantScaffold } from "@t3tools/client-runtime/state/assistants";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectIconOverride,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import type { AsyncResult } from "effect/unstable/reactivity";

export type NewProjectCommand =
  | { readonly type: "project.create"; readonly input: CreateProjectInput }
  | { readonly type: "thread.create"; readonly input: CreateThreadInput }
  | { readonly type: "project.meta.update"; readonly input: UpdateProjectInput };

export interface NewProjectPlanInput {
  /** Used only when the folder is not a workspace yet. */
  readonly newProjectId: ProjectId;
  /** Used only when the coordinator is a new thread. */
  readonly newThreadId: ThreadId;
  readonly name: string;
  /** Absolute, `~` already expanded on the host. */
  readonly resolvedPath: string;
  readonly projectIcon: ProjectIconOverride | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The live workspace already at `resolvedPath`, which Convert keeps. */
  readonly existingWorkspace: {
    readonly id: ProjectId;
    readonly title: string;
    readonly projectIcon?: ProjectIconOverride | null | undefined;
  } | null;
  /** An existing Local thread of `existingWorkspace` to promote; null creates one. */
  readonly existingCoordinatorThreadId: ThreadId | null;
}

export interface NewProjectPlan {
  readonly projectId: ProjectId;
  readonly coordinatorThreadId: ThreadId;
  readonly commands: readonly NewProjectCommand[];
}

/**
 * The ordered dispatches for New Project and Convert. The server does the
 * title, pin and session bookkeeping from the final `project.meta.update`,
 * so every flow ends with exactly that one command.
 */
export function planNewProjectCommands(input: NewProjectPlanInput): NewProjectPlan {
  const name = input.name.trim();
  const workspace = input.existingWorkspace;
  const projectId = workspace?.id ?? input.newProjectId;
  const existingCoordinator = workspace === null ? null : input.existingCoordinatorThreadId;
  const coordinatorThreadId = existingCoordinator ?? input.newThreadId;
  const commands: NewProjectCommand[] = [];

  if (workspace === null) {
    commands.push({
      type: "project.create",
      input: {
        projectId,
        title: name,
        workspaceRoot: input.resolvedPath,
        createWorkspaceRootIfMissing: true,
      },
    });
  }
  if (existingCoordinator === null) {
    commands.push({
      type: "thread.create",
      input: {
        threadId: coordinatorThreadId,
        projectId,
        title: name,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
      },
    });
  }
  const iconChanged =
    JSON.stringify(input.projectIcon) !== JSON.stringify(workspace?.projectIcon ?? null);
  commands.push({
    type: "project.meta.update",
    input: {
      projectId,
      ...(workspace !== null && workspace.title !== name ? { title: name } : {}),
      ...(iconChanged ? { projectIcon: input.projectIcon } : {}),
      defaultModelSelection: input.modelSelection,
      assistant: { coordinatorThreadId },
    },
  });

  return { projectId, coordinatorThreadId, commands };
}

/**
 * The same default model as a project settings override. Servers that have
 * folded legacy project fields into `projectSettingsOverrides` read only the
 * override, so without it "Default model for new agents" would not apply.
 */
export function planDefaultModelOverridePatch(input: {
  readonly overrides: ServerSettings["projectSettingsOverrides"];
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}): ServerSettingsPatch {
  return {
    projectSettingsOverrides: {
      [input.projectId]: {
        ...input.overrides[input.projectId],
        defaultModelSelection: input.modelSelection,
      },
    },
  };
}

/** Folder inputs must be absolute or start at the host's home (`~`). */
export function isAbsoluteOrHomePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    isWindowsAbsolutePath(trimmed)
  );
}

/** Expands a leading `~` with the host's home directory, as the host itself would. */
export function expandHomePath(value: string, home: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (!trimmed.startsWith("~/")) return trimmed;
  const separator = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const rest = trimmed.slice(2).replaceAll("/", separator);
  return `${home.replace(/[\\/]+$/, "")}${separator}${rest}`;
}

/**
 * Whether a failed `projects.readFile` proves the file is absent. Anything
 * else (a symlink out of the folder, an unreadable or binary file) counts as
 * present. The file listing omits symlinks, and a write follows them, so the
 * scaffold probes each file before writing it.
 */
export function readFailureMeansMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    error.failure === "operation_failed" &&
    "operation" in error &&
    error.operation === "realpath-target"
  );
}

/** Present unless the read proves it absent: symlinks are missing from listings. */
export function readShowsFilePresent(read: AtomCommandResult<unknown, unknown>): boolean {
  return read._tag === "Success" || !readFailureMeansMissing(squashAtomCommandFailure(read));
}

/**
 * Writes each scaffold file the folder lacks. `read` goes through the file
 * view's cache, so the probe leaves a "missing" failure there; each written
 * file is read again to replace it, or an open MEMORY.md or AGENTS.md tab
 * keeps showing the failure.
 */
export async function writeMissingScaffoldFiles<F>(input: {
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly contents: string }>;
  readonly read: (relativePath: string) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly write: (
    relativePath: string,
    contents: string,
  ) => Promise<AtomCommandResult<unknown, F>>;
}) {
  const written: string[] = [];
  const failed: Array<{ relativePath: string; result: AsyncResult.Failure<unknown, F> }> = [];
  for (const file of input.files) {
    if (readShowsFilePresent(await input.read(file.relativePath))) continue;
    const result = await input.write(file.relativePath, file.contents);
    if (result._tag === "Failure") {
      failed.push({ relativePath: file.relativePath, result });
      continue;
    }
    written.push(file.relativePath);
    await input.read(file.relativePath);
  }
  return { written, failed };
}

// ----- New Project and Convert, shared by the desktop dialog and the mobile sheet -----

/** Where a new Project folder goes when the host has no Add workspace base directory. */
export const DEFAULT_PROJECTS_DIRECTORY = "~/Projects";

/** A Project folder as the host resolves it. Nothing is written to a path until it is "ok". */
export type FolderResolution =
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      /** Absolute on the host. */
      readonly path: string;
      readonly hasAgentsFile: boolean;
    };

/** The folder a new Project goes under, with the names already taken there. */
export type NewFolderBase =
  | {
      readonly kind: "ok";
      readonly environmentId: EnvironmentId;
      readonly parentPath: string;
      readonly existingNames: readonly string[];
    }
  | { readonly kind: "error"; readonly environmentId: EnvironmentId };

/** `filesystem.browse`, called the way the clients' query runners call it. */
export type BrowseFolder = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly partialPath: string };
}) => Promise<
  AtomCommandResult<
    { readonly parentPath: string; readonly entries: ReadonlyArray<{ readonly name: string }> },
    unknown
  >
>;

/** Drops trailing separators, keeping a lone root such as "/". */
export function trimTrailingPathSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? path.slice(0, 1) : trimmed;
}

async function resolveHostHome(
  environmentId: EnvironmentId,
  browse: BrowseFolder,
): Promise<string | null> {
  const result = await browse({ environmentId, input: { partialPath: "~/" } });
  return result._tag === "Success" ? result.value.parentPath : null;
}

/**
 * The parent of a new Project folder: the host's Add workspace base
 * directory, else `~/Projects`, as an absolute host path. A base that does
 * not exist yet still resolves, because `project.create` makes it along with
 * the Project folder.
 */
export async function resolveNewProjectFolderBase(input: {
  readonly environmentId: EnvironmentId;
  /** The host's `addProjectBaseDirectory`; blank uses DEFAULT_PROJECTS_DIRECTORY. */
  readonly addProjectBaseDirectory: string;
  readonly browse: BrowseFolder;
}): Promise<NewFolderBase> {
  const { environmentId, browse } = input;
  const directory = input.addProjectBaseDirectory.trim() || DEFAULT_PROJECTS_DIRECTORY;
  const listed = await browse({
    environmentId,
    input: { partialPath: ensureBrowseDirectoryPath(directory) },
  });
  if (listed._tag === "Success") {
    return {
      kind: "ok",
      environmentId,
      parentPath: listed.value.parentPath,
      existingNames: listed.value.entries.map((entry) => entry.name),
    };
  }
  if (isAbsoluteOrHomePath(directory)) {
    const home = directory.startsWith("~") ? await resolveHostHome(environmentId, browse) : "";
    if (home !== null) {
      return {
        kind: "ok",
        environmentId,
        parentPath: trimTrailingPathSeparators(expandHomePath(directory, home)),
        existingNames: [],
      };
    }
  }
  // Without a resolvable parent the user has to type a folder.
  return { kind: "error", environmentId };
}

/** Why a typed folder cannot be resolved, checked before asking the host. */
export function typedProjectFolderError(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "Choose a folder.";
  return isAbsoluteOrHomePath(trimmed) ? null : "Enter an absolute path or one starting with ~/.";
}

/**
 * A typed folder resolved on the host. Existing must be a folder that is
 * there; New must not exist yet (a `~` path expands to the host's home).
 */
export async function resolveTypedProjectFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly mode: "new" | "existing";
  readonly input: string;
  readonly browse: BrowseFolder;
  readonly fileExists: (
    environmentId: EnvironmentId,
    cwd: string,
    relativePath: string,
  ) => Promise<boolean>;
}): Promise<Exclude<FolderResolution, { readonly kind: "pending" }>> {
  const { environmentId, browse } = input;
  const typed = input.input.trim();
  const invalid = typedProjectFolderError(typed);
  if (invalid !== null) return { kind: "error", message: invalid };
  const listed = await browse({
    environmentId,
    input: { partialPath: ensureBrowseDirectoryPath(typed) },
  });
  if (input.mode === "existing") {
    if (listed._tag !== "Success") return { kind: "error", message: "Folder not found." };
    const path = listed.value.parentPath;
    return {
      kind: "ok",
      path,
      hasAgentsFile: await input.fileExists(environmentId, path, "AGENTS.md"),
    };
  }
  if (listed._tag === "Success") {
    return { kind: "error", message: "Folder exists. Choose Existing folder." };
  }
  const home = typed.startsWith("~") ? await resolveHostHome(environmentId, browse) : "";
  if (home === null) return { kind: "error", message: "Could not resolve ~ on this host." };
  return {
    kind: "ok",
    path: trimTrailingPathSeparators(expandHomePath(typed, home)),
    hasAgentsFile: false,
  };
}

type EnvironmentIo<Input, A = unknown> = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<A, unknown>>;

/** The commands and queries New Project runs, as each client's atom runners call them. */
export interface NewProjectPlanRunner {
  readonly createProject: EnvironmentIo<CreateProjectInput>;
  readonly createThread: EnvironmentIo<CreateThreadInput>;
  readonly updateProject: EnvironmentIo<UpdateProjectInput>;
  readonly updateSettings: EnvironmentIo<{ readonly patch: ServerSettingsPatch }>;
  readonly listEntries: EnvironmentIo<
    { readonly cwd: string; readonly directoryPath: string },
    { readonly entries: ReadonlyArray<{ readonly path: string }> }
  >;
  readonly readFile: EnvironmentIo<{ readonly cwd: string; readonly relativePath: string }>;
  readonly writeFile: EnvironmentIo<{
    readonly cwd: string;
    readonly relativePath: string;
    readonly contents: string;
  }>;
}

export interface NewProjectRunIssue {
  readonly title: string;
  readonly failure: AsyncResult.Failure<unknown, unknown>;
}

export type NewProjectRunResult =
  | ({ readonly ok: false } & NewProjectRunIssue)
  | { readonly ok: true; readonly warnings: readonly NewProjectRunIssue[] };

/**
 * Runs a New Project or Convert plan: its commands in order (stopping at the
 * first failure), then the default-model override where the host resolves
 * overrides, then the Project files the folder lacks. The Project exists once
 * the commands succeed, so later failures are warnings.
 */
export async function runNewProjectPlan(input: {
  readonly environmentId: EnvironmentId;
  readonly plan: NewProjectPlan;
  /** Absolute on the host: the plan's resolved path. */
  readonly folderPath: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly supportsOverrides: boolean;
  readonly overrides: ServerSettings["projectSettingsOverrides"];
  readonly run: NewProjectPlanRunner;
}): Promise<NewProjectRunResult> {
  const { environmentId, plan, run } = input;
  const title = plan.commands.some((command) => command.type === "project.create")
    ? "Failed to create Project"
    : "Failed to convert to a Project";
  for (const command of plan.commands) {
    const result =
      command.type === "project.create"
        ? await run.createProject({ environmentId, input: command.input })
        : command.type === "thread.create"
          ? await run.createThread({ environmentId, input: command.input })
          : await run.updateProject({ environmentId, input: command.input });
    if (result._tag === "Failure") return { ok: false, title, failure: result };
  }

  const warnings: NewProjectRunIssue[] = [];
  if (input.supportsOverrides) {
    const saved = await run.updateSettings({
      environmentId,
      input: {
        patch: planDefaultModelOverridePatch({
          overrides: input.overrides,
          projectId: plan.projectId,
          modelSelection: input.modelSelection,
        }),
      },
    });
    if (saved._tag === "Failure") {
      warnings.push({ title: "Default model for new agents not saved", failure: saved });
    }
  }

  // Re-list right before writing so a file created since the form opened is kept.
  const cwd = input.folderPath;
  const listed = await run.listEntries({ environmentId, input: { cwd, directoryPath: "" } });
  if (listed._tag === "Failure") {
    warnings.push({ title: "Project files not added", failure: listed });
    return { ok: true, warnings };
  }
  const scaffold = await writeMissingScaffoldFiles({
    files: planAssistantScaffold({
      existingNames: listed.value.entries.map(
        (entry) => entry.path.split(/[\\/]/).pop() ?? entry.path,
      ),
      instructions: input.instructions,
    }),
    read: (relativePath) => run.readFile({ environmentId, input: { cwd, relativePath } }),
    write: (relativePath, contents) =>
      run.writeFile({ environmentId, input: { cwd, relativePath, contents } }),
  });
  for (const { relativePath, result } of scaffold.failed) {
    warnings.push({ title: `${relativePath} not written`, failure: result });
  }
  // The listing above is cached too, and the file view's root crumb reads it.
  if (scaffold.written.length > 0) {
    await run.listEntries({ environmentId, input: { cwd, directoryPath: "" } });
  }
  return { ok: true, warnings };
}
