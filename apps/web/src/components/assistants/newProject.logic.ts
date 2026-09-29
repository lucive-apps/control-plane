import type {
  CreateProjectInput,
  CreateThreadInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
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
