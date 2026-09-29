import {
  rollupAssistantsStatus,
  type SidebarRollupStatus,
} from "@t3tools/client-runtime/state/assistant-lists";
import { resolveAssistantThreadChrome } from "@t3tools/client-runtime/state/assistant-thread-view";
import {
  countRunningAgents,
  sectionAssistantAgents,
  type AssistantEntry,
} from "@t3tools/client-runtime/state/assistants";
import { hasScheduleAttention } from "@t3tools/client-runtime/state/schedules";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  assistantThreadRole,
  type EnvironmentId,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";

export interface CommandPaletteItem {
  readonly key: string;
  /** Projects lead the root list; workspaces show only while searching. */
  readonly kind: "action" | "assistant" | "project" | "thread";
  readonly title: string;
  readonly detail?: string;
  /** A Project row's icon and rolled-up dot. */
  readonly assistant?: {
    readonly project: EnvironmentProject;
    readonly rollup: SidebarRollupStatus;
  };
  readonly searchTerms: ReadonlyArray<string>;
  readonly run: () => void;
}

/**
 * One row per Project, opening its coordinator, with "N running" and the
 * same rolled-up dot as its Home row.
 */
export function buildCommandPaletteAssistantRows(input: {
  readonly assistants: ReadonlyArray<AssistantEntry<EnvironmentProject, EnvironmentThreadShell>>;
  readonly lastVisitedAtById: Readonly<Record<string, string>>;
  readonly now: string;
}) {
  return input.assistants.flatMap((entry) => {
    const { project } = entry;
    const coordinatorThreadId = project.assistant?.coordinatorThreadId;
    if (coordinatorThreadId === undefined) return [];
    const running = countRunningAgents(entry.agents);
    const sections = sectionAssistantAgents(entry.agents, {
      now: input.now,
      supportsSnooze: true,
      supportsSettlement: true,
    });
    return [
      {
        key: `assistant:${scopedProjectKey(project.environmentId, project.id)}`,
        title: project.title,
        ...(running > 0 ? { detail: `${running} running` } : {}),
        rollup: rollupAssistantsStatus(
          [
            {
              coordinator: entry.coordinator,
              sections,
              scheduleAttention: hasScheduleAttention(project.assistant),
            },
          ],
          input.lastVisitedAtById,
        ),
        searchTerms: [project.title, project.workspaceRoot, "project", "coordinator"],
        project,
        coordinator: entry.coordinator,
        coordinatorThreadId,
      },
    ];
  });
}

/**
 * Whether a thread shows pull request and review controls: the shared thread
 * chrome for the thread's role in its Project, as on desktop.
 */
export function resolvePaletteThreadChrome(input: {
  readonly project: { readonly assistant?: ProjectAssistant | null | undefined } | null;
  readonly threadId: ThreadId | null;
  readonly worktreePath: string | null;
}): { readonly showPullRequestControls: boolean } {
  const { showPullRequestControls } = resolveAssistantThreadChrome({
    role: assistantThreadRole(input.project, input.threadId),
    // Neither is read by the pull request rule.
    isStanding: false,
    isGitRepo: true,
    worktreePath: input.worktreePath,
  });
  return { showPullRequestControls };
}

export type ContextualPaletteActionKey =
  | "newThread"
  | "projectSettings"
  | "projectSchedules"
  | "convertToProject"
  | "files"
  | "terminal"
  | "review"
  | "copyThreadReference";

export interface ContextualPaletteAction {
  readonly key: ContextualPaletteActionKey;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
}

const THREAD_ACTIONS: ReadonlyArray<ContextualPaletteAction> = [
  { key: "files", title: "Go to file", searchTerms: ["open", "files", "browse", "search"] },
  { key: "terminal", title: "Open terminal", searchTerms: ["shell", "console"] },
  { key: "review", title: "Review changes", searchTerms: ["diff", "git", "pull request"] },
  {
    key: "copyThreadReference",
    title: "Copy PR link or thread ID",
    searchTerms: ["reference", "clipboard"],
  },
];

/**
 * The palette's actions for the open thread. Inside a Project they target
 * the Project (a new agent, its settings and, where its server stores them,
 * its schedules); inside a workspace they offer a new thread and, where the
 * environment supports Projects, Convert. Review follows the thread's pull
 * request controls.
 */
export function resolveContextualPaletteActions(input: {
  /** The open thread's workspace or Project, once its shell is known. */
  readonly activeProject: {
    readonly title: string;
    readonly assistant?: ProjectAssistant | null | undefined;
  } | null;
  /** A thread route is open, even while its shell loads. */
  readonly hasActiveThread: boolean;
  readonly chrome: { readonly showPullRequestControls: boolean };
  /** The active workspace's environment supports Projects. */
  readonly assistantsCapability: boolean;
  /** The active workspace's environment stores Project schedules. */
  readonly schedulesCapability: boolean;
}): {
  readonly leading: ReadonlyArray<ContextualPaletteAction>;
  readonly thread: ReadonlyArray<ContextualPaletteAction>;
} {
  const project = input.activeProject;
  const leading: ContextualPaletteAction[] =
    project === null
      ? []
      : project.assistant != null
        ? [
            {
              key: "newThread",
              title: `New agent in ${project.title}`,
              searchTerms: ["new agent", "new thread", "chat", "create"],
            },
            {
              key: "projectSettings",
              title: "Project settings",
              detail: project.title,
              searchTerms: ["project", "settings", "name", "icon", "model", "instructions"],
            },
            ...(input.schedulesCapability
              ? [
                  {
                    key: "projectSchedules" as const,
                    title: "Project schedules",
                    detail: project.title,
                    searchTerms: [
                      "project",
                      "schedules",
                      "schedule",
                      "cron",
                      "recurring",
                      "run now",
                    ],
                  },
                ]
              : []),
          ]
        : [
            {
              key: "newThread",
              title: `New thread in ${project.title}`,
              searchTerms: ["new task", "chat", "create"],
            },
            ...(input.assistantsCapability
              ? [
                  {
                    key: "convertToProject" as const,
                    title: "Convert to Project…",
                    detail: project.title,
                    searchTerms: ["convert", "project", "coordinator", "agents", "workspace"],
                  },
                ]
              : []),
          ];
  const thread = input.hasActiveThread
    ? THREAD_ACTIONS.filter(
        (action) => action.key !== "review" || input.chrome.showPullRequestControls,
      )
    : [];
  return { leading, thread };
}

export interface CommandPaletteProjectScope<
  TProject extends {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  },
> {
  readonly key: string;
  readonly title: string;
  readonly representative: TProject;
  readonly projects: ReadonlyArray<TProject>;
}

// One row per logical repo. Detail is the current-machine checkout path;
// machine names stay in searchTerms only.
export function buildCommandPaletteProjectRows<
  TProject extends {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  },
>(input: {
  readonly scopes: ReadonlyArray<CommandPaletteProjectScope<TProject>>;
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}) {
  return input.scopes.map((scope) => {
    const target =
      scope.projects.find((project) => project.environmentId === input.preferredEnvironmentId) ??
      scope.representative;
    return {
      key: `project:${scope.key}`,
      title: scope.title,
      detail: target.workspaceRoot,
      searchTerms: [
        ...scope.projects.flatMap((project) => [
          project.title,
          project.workspaceRoot,
          input.environmentLabelById.get(project.environmentId) ?? "",
        ]),
        "new thread",
        "workspace",
        "project",
      ],
      target,
    };
  });
}

/** `>` narrows to actions, matching the desktop palette. Stable ties retain recent-thread order. */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  matchedThreadKeys: ReadonlySet<string>,
) {
  const actionsOnly = query.startsWith(">");
  const normalized = (actionsOnly ? query.slice(1) : query).trim().toLocaleLowerCase();
  const tokens = normalized.split(/\s+/);
  return items
    .flatMap((item, index) => {
      if (actionsOnly && item.kind !== "action") return [];
      if (!normalized) return item.kind === "project" ? [] : [{ item, rank: 0, index }];
      const title = item.title.toLocaleLowerCase();
      const haystack = [title, ...item.searchTerms].join(" ").toLocaleLowerCase();
      if (
        !tokens.every((token) => haystack.includes(token)) &&
        !(item.kind === "thread" && matchedThreadKeys.has(item.key))
      )
        return [];
      const rank =
        title === normalized
          ? 3
          : title.startsWith(normalized)
            ? 2
            : title.includes(normalized)
              ? 1
              : 0;
      return [{ item, rank, index }];
    })
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map(({ item }) => item);
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}
