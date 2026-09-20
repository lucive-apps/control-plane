import type { ContextMenuItem } from "@t3tools/contracts";

export interface ProjectFolderMenuMember {
  readonly physicalProjectKey: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
}

export interface ProjectFolderMenuProject {
  readonly memberProjects: readonly ProjectFolderMenuMember[];
  readonly groupedProjectCount: number;
}

export type ProjectFolderActionMenuId =
  | "project-settings"
  | "copy-path"
  | `copy-path:${string}`
  | "delete"
  | `delete:${string}`;

export type ResolvedProjectFolderMenuAction<TMember extends ProjectFolderMenuMember> =
  | { readonly kind: "project-settings" }
  | { readonly kind: "copy-path"; readonly member: TMember }
  | { readonly kind: "delete"; readonly members: readonly TMember[] };

export function formatProjectMemberActionLabel(
  member: ProjectFolderMenuMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) return member.title;
  return member.environmentLabel
    ? `${member.environmentLabel}: ${member.workspaceRoot}`
    : member.workspaceRoot;
}

export function buildProjectFolderActionMenuItems(
  project: ProjectFolderMenuProject,
): ReadonlyArray<ContextMenuItem<ProjectFolderActionMenuId>> {
  const targeted = (
    action: "copy-path" | "delete",
    label: string,
    options?: {
      destructive?: boolean;
      icon?: string;
      separatorBefore?: boolean;
    },
  ): ContextMenuItem<ProjectFolderActionMenuId> => {
    if (project.memberProjects.length === 1) {
      return {
        id: action,
        label,
        ...options,
      };
    }

    return {
      id: action,
      label,
      ...(options?.icon ? { icon: options.icon } : {}),
      ...(options?.separatorBefore ? { separatorBefore: true } : {}),
      children: project.memberProjects.map((member) => ({
        id: `${action}:${member.physicalProjectKey}` as const,
        label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
        ...(options?.destructive ? { destructive: true } : {}),
      })),
    };
  };

  return [
    { id: "project-settings", label: "Project settings", icon: "settings" },
    targeted("copy-path", "Copy path", { icon: "folder" }),
    targeted("delete", "Remove", {
      destructive: true,
      icon: "trash",
      separatorBefore: true,
    }),
  ];
}

export function resolveProjectFolderMenuAction<TMember extends ProjectFolderMenuMember>(
  project: { readonly memberProjects: readonly TMember[] },
  actionId: string,
): ResolvedProjectFolderMenuAction<TMember> | null {
  if (actionId === "project-settings") return { kind: "project-settings" };

  if (actionId === "copy-path") {
    const member = project.memberProjects.length === 1 ? project.memberProjects[0] : undefined;
    return member ? { kind: "copy-path", member } : null;
  }
  if (actionId.startsWith("copy-path:")) {
    const key = actionId.slice("copy-path:".length);
    const member = project.memberProjects.find((candidate) => candidate.physicalProjectKey === key);
    return member ? { kind: "copy-path", member } : null;
  }

  if (actionId === "delete") {
    const member = project.memberProjects.length === 1 ? project.memberProjects[0] : undefined;
    return member ? { kind: "delete", members: [member] } : null;
  }
  if (actionId.startsWith("delete:")) {
    const key = actionId.slice("delete:".length);
    const member = project.memberProjects.find((candidate) => candidate.physicalProjectKey === key);
    return member ? { kind: "delete", members: [member] } : null;
  }

  return null;
}

export function buildRemoveProjectConfirmMessage(input: {
  readonly members: ReadonlyArray<{
    readonly title: string;
    readonly workspaceRoot: string;
    readonly environmentLabel: string | null;
  }>;
  readonly groupDisplayName: string;
  readonly groupMemberCount: number;
  readonly threadCount: number;
  readonly hasOtherMembers: boolean;
}): string {
  const isWholeGroup = input.members.length === input.groupMemberCount;
  const targetKind = input.hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = input.members.length === 1 ? input.members[0]! : null;
  const targetLabel = singleMember?.title ?? input.groupDisplayName;
  return [
    input.threadCount > 0
      ? `Remove ${targetKind} "${targetLabel}" and delete its ${input.threadCount} thread${
          input.threadCount === 1 ? "" : "s"
        }?`
      : `Remove ${targetKind} "${targetLabel}"?`,
    ...(singleMember
      ? [
          `Path: ${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel
            ? [`Environment: ${singleMember.environmentLabel}`]
            : []),
        ]
      : [`This removes ${input.members.length} grouped project entries.`]),
    ...(input.threadCount > 0
      ? ["This permanently clears conversation history for those threads and any archived threads."]
      : ["This permanently clears any archived conversation history."]),
    isWholeGroup && !input.hasOtherMembers
      ? "This removes only the project entries, not the files on disk."
      : "Other entries in this grouped project are unaffected.",
    "This action cannot be undone.",
  ].join("\n");
}

export function routeBelongsToProjectMembers(input: {
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  readonly routeThread: { readonly environmentId: string; readonly projectId: string } | null;
  readonly routeDraft: { readonly environmentId: string; readonly projectId: string } | null;
}): boolean {
  const belongs = (ref: { readonly environmentId: string; readonly projectId: string } | null) =>
    ref !== null &&
    input.members.some(
      (member) => member.environmentId === ref.environmentId && member.id === ref.projectId,
    );
  return belongs(input.routeThread) || belongs(input.routeDraft);
}
