import type { MenuAction } from "@react-native-menu/menu";
import { isRunningAgent } from "@t3tools/contracts";

import { buildThreadTitleRegenerationMenuItems } from "../threads/thread-title-regeneration-menu";

// Fork-owned. The long-press menus and the agent swipe of the Projects
// section (design A4), and the coordinator header's Project menu. Item ids
// reuse the thread row's ids where the row already handles them.

/** Every action a Project's menus offer, on the Home row and in the coordinator header. */
export type ProjectMenuAction =
  | "new-agent"
  | "rename"
  | "settings"
  | "schedules"
  | "archive"
  | "unarchive"
  | "move-to-tasks"
  | "delete";

/** Home lists only active Projects, so the row never offers Unarchive. */
export type ProjectRowMenuAction = Exclude<ProjectMenuAction, "unarchive">;

export interface ProjectMenuItem {
  readonly id: ProjectMenuAction;
  readonly title: string;
  readonly icon:
    | "plus"
    | "square.and.pencil"
    | "gearshape"
    | "clock"
    | "archivebox"
    | "arrow.uturn.backward"
    | "folder"
    | "trash";
  readonly destructive?: boolean;
}

const PROJECT_ROW_MENU_ACTIONS: ReadonlySet<string> = new Set<ProjectRowMenuAction>([
  "new-agent",
  "rename",
  "settings",
  "schedules",
  "archive",
  "move-to-tasks",
  "delete",
]);

export function isProjectRowMenuAction(value: string): value is ProjectRowMenuAction {
  return PROJECT_ROW_MENU_ACTIONS.has(value);
}

/**
 * A Project's menu. Mobile omits Open folder (spec §5). The Home row adds New
 * agent, and Schedules where its server stores them; the coordinator header
 * has its own Schedules button. The header names the Project in each title
 * and offers Unarchive for an archived Project, whose coordinator stays
 * reachable while the Project is hidden from Home.
 */
export function buildProjectMenuItems(input: {
  readonly surface: "row" | "header";
  readonly archived: boolean;
  readonly canSchedule?: boolean;
}): ReadonlyArray<ProjectMenuItem> {
  const header = input.surface === "header";
  const title = (row: string) => (header ? `${row} Project` : row);
  return [
    ...(header ? [] : [{ id: "new-agent", title: "New agent", icon: "plus" } as const]),
    { id: "rename", title: title("Rename"), icon: "square.and.pencil" },
    { id: "settings", title: header ? "Project settings" : "Settings", icon: "gearshape" },
    ...(!header && input.canSchedule === true
      ? [{ id: "schedules", title: "Schedules", icon: "clock" } as const]
      : []),
    input.archived
      ? { id: "unarchive", title: title("Unarchive"), icon: "arrow.uturn.backward" }
      : { id: "archive", title: title("Archive"), icon: "archivebox" },
    { id: "move-to-tasks", title: "Move to Tasks", icon: "folder" },
    { id: "delete", title: title("Delete"), icon: "trash", destructive: true },
  ];
}

/** The Project row's long-press menu; `canSchedule` when its server stores schedules. */
export function buildProjectRowMenu(canSchedule: boolean): MenuAction[] {
  return buildProjectMenuItems({ surface: "row", archived: false, canSchedule }).map((item) => ({
    id: item.id,
    title: item.title,
    image: item.icon,
    ...(item.destructive ? { attributes: { destructive: true } } : {}),
  }));
}

/**
 * An active agent card's long-press menu, in A4 order. Standing agents offer
 * Unpin and never Settle; one-off agents offer Pin and Settle. Snooze lists
 * the preset subactions and appears only while the thread can snooze.
 */
export function buildAgentRowMenu(input: {
  readonly standing: boolean;
  readonly snoozable: boolean;
  readonly snoozeSubactions: readonly MenuAction[];
  readonly canStop: boolean;
  readonly canBeCoordinator: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly isRegenerating: boolean;
}): MenuAction[] {
  return [
    input.standing
      ? { id: "unpin", title: "Unpin", image: "pin.slash" }
      : { id: "pin", title: "Pin", image: "pin" },
    ...(input.snoozable
      ? [
          {
            id: "snooze",
            title: "Snooze",
            image: "clock",
            subactions: [...input.snoozeSubactions],
          },
        ]
      : []),
    ...(input.standing ? [] : [{ id: "settle", title: "Settle", image: "checkmark" }]),
    {
      id: "stop-agent",
      title: "Stop agent",
      image: "stop.circle",
      ...(input.canStop ? {} : { attributes: { disabled: true } }),
    },
    {
      id: "set-coordinator",
      title: "Set as coordinator",
      image: "crown",
      ...(input.canBeCoordinator ? {} : { attributes: { disabled: true } }),
    },
    { id: "rename", title: "Rename", image: "square.and.pencil" },
    ...buildThreadTitleRegenerationMenuItems({
      supported: input.titleRegenerationSupported,
      isRegenerating: input.isRegenerating,
    }),
    { id: "archive", title: "Archive", image: "archivebox" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

/** What an agent row can do right now, read from its shell. */
export function resolveAgentRowState(thread: {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
  readonly worktreePath: string | null;
}): { readonly running: boolean; readonly canStop: boolean; readonly canBeCoordinator: boolean } {
  return {
    running: isRunningAgent(thread),
    canStop: thread.session !== null && thread.session.status !== "stopped",
    // Only a Local thread can coordinate (M2 invariant).
    canBeCoordinator: thread.worktreePath === null,
  };
}

/**
 * An active agent card's trailing swipe. The full swipe commits the primary
 * action, Pin or Unpin, which is reversible; Stop is a tap-only button so a
 * full swipe never interrupts a turn.
 */
export function resolveAgentSwipeActions(input: {
  readonly standing: boolean;
  readonly running: boolean;
  readonly canStop: boolean;
}): { readonly primary: "pin" | "unpin"; readonly secondary: "stop" | null } {
  return {
    primary: input.standing ? "unpin" : "pin",
    // A thread waiting on the user can have no session left to stop.
    secondary: input.running && input.canStop ? "stop" : null,
  };
}

// One emoji: a flag, a keycap, or a pictograph with its variation selector,
// skin tone, tag sequence and ZWJ joins. Hermes has no Intl.Segmenter.
const LEADING_EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/u;

/**
 * The first emoji of a Project icon answer, or null when it does not start
 * with one. Mirrors web `firstEmoji`, so "Sales" never becomes an icon.
 */
export function leadingEmoji(input: string): string | null {
  return LEADING_EMOJI.exec(input.trim())?.[0] ?? null;
}

/** One checkout in a Tasks folder; grouped folders hold several. */
export interface TaskFolderMenuMember {
  /** Unique within the folder, e.g. the scoped project key. */
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
}

export type TaskFolderMenuSelection<M> =
  | { readonly kind: "new-thread" }
  | { readonly kind: "convert"; readonly member: M };

function taskFolderMemberLabel(member: TaskFolderMenuMember, memberCount: number): string {
  if (memberCount <= 1) return member.title;
  return member.environmentLabel
    ? `${member.environmentLabel}: ${member.workspaceRoot}`
    : member.workspaceRoot;
}

/**
 * A Tasks folder's long-press menu: New thread, then Convert to Project…
 * for checkouts `canConvert` accepts (their environment supports Projects).
 * Convert moves one checkout, so a grouped folder lists them, as on desktop.
 */
export function buildTaskFolderMenu<M extends TaskFolderMenuMember>(input: {
  readonly members: readonly M[];
  readonly canConvert: (member: M) => boolean;
}): MenuAction[] {
  const actions: MenuAction[] = [
    { id: "new-thread", title: "New thread", image: "square.and.pencil" },
  ];
  const convertible = input.members.filter(input.canConvert);
  if (convertible.length === 0) return actions;
  actions.push(
    input.members.length === 1
      ? { id: "convert", title: "Convert to Project…", image: "folder.badge.plus" }
      : {
          id: "convert",
          title: "Convert to Project…",
          image: "folder.badge.plus",
          subactions: convertible.map((member) => ({
            id: `convert:${member.key}`,
            title: taskFolderMemberLabel(member, input.members.length),
          })),
        },
  );
  return actions;
}

export function resolveTaskFolderMenuAction<M extends TaskFolderMenuMember>(
  members: readonly M[],
  actionId: string,
): TaskFolderMenuSelection<M> | null {
  if (actionId === "new-thread") return { kind: "new-thread" };
  const member =
    actionId === "convert"
      ? members.length === 1
        ? members[0]
        : undefined
      : actionId.startsWith("convert:")
        ? members.find((candidate) => candidate.key === actionId.slice("convert:".length))
        : undefined;
  return member === undefined ? null : { kind: "convert", member };
}

/** Delete confirmation: the exact Project name, ignoring surrounding spaces. */
export function matchesProjectName(input: string, title: string): boolean {
  const typed = input.trim();
  return typed.length > 0 && typed === title.trim();
}
