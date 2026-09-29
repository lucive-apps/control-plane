import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { environmentThreadShells } from "../../state/threads";
import { countProjectAgents, type ArchivedProjectRow } from "./archivedProjects";

// Fork-owned. Settings > Archived: archived Projects above the per-workspace
// thread groups. A row opens Project settings; Unarchive returns it to Home.

export function ArchivedProjectsSection(props: {
  readonly rows: ReadonlyArray<ArchivedProjectRow<EnvironmentProject>>;
  readonly onOpenProject: (project: EnvironmentProject) => void;
  readonly onUnarchiveProject: (project: EnvironmentProject) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <View className="pt-4">
      <Text className="px-1 pb-2 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">
        Projects
      </Text>
      <View className="overflow-hidden rounded-[20px] bg-card">
        {props.rows.map((row, index) => (
          <ArchivedProjectItem
            key={row.key}
            row={row}
            last={index === props.rows.length - 1}
            onOpenProject={props.onOpenProject}
            onUnarchiveProject={props.onUnarchiveProject}
          />
        ))}
      </View>
    </View>
  );
}

function ArchivedProjectItem(props: {
  readonly row: ArchivedProjectRow<EnvironmentProject>;
  readonly last: boolean;
  readonly onOpenProject: (project: EnvironmentProject) => void;
  readonly onUnarchiveProject: (project: EnvironmentProject) => void;
}) {
  const { row } = props;
  // Selects just this Project's count, so live shell updates while the
  // screen is open re-render a row only when its count changes.
  const selectAgentCount = useCallback(
    (threads: ReadonlyArray<EnvironmentThreadShell>) => countProjectAgents(threads, row.project),
    [row.project],
  );
  const agentCount = useAtomValue(environmentThreadShells.threadShellsAtom, selectAgentCount);
  const detail = `${agentCount} ${agentCount === 1 ? "agent" : "agents"} · ${row.ageLabel}`;
  return (
    <View
      className={
        props.last
          ? "flex-row items-center gap-3 px-4 py-3"
          : "flex-row items-center gap-3 border-b border-separator px-4 py-3"
      }
    >
      <Pressable
        accessibilityHint="Opens Project settings"
        accessibilityLabel={`${row.title}, ${detail}`}
        accessibilityRole="button"
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-60"
        onPress={() => props.onOpenProject(row.project)}
      >
        <ProjectFavicon
          environmentId={row.project.environmentId}
          faviconPath={row.project.faviconPath}
          projectIcon={row.project.projectIcon}
          projectTitle={row.project.title}
          size={22}
          workspaceRoot={row.project.workspaceRoot}
        />
        <Text className="min-w-0 flex-1 text-base leading-snug text-foreground" numberOfLines={1}>
          <Text className="font-t3-bold text-foreground">{row.title}</Text>
          <Text className="text-foreground-tertiary">{` · ${detail}`}</Text>
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={`Unarchive ${row.title}`}
        accessibilityRole="button"
        className="rounded-full bg-subtle px-3 py-1.5 active:opacity-60"
        onPress={() => props.onUnarchiveProject(row.project)}
      >
        <Text className="text-sm font-t3-medium text-foreground">Unarchive</Text>
      </Pressable>
    </View>
  );
}
