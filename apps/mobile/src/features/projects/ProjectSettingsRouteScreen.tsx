import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { summarizeSchedules } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  isArchivedAssistant,
  ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { buildModelOptions, groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { Footnote, MenuRow } from "./ProjectFormRows";
import { useProjectActions } from "./useProjectActions";

// Fork-owned. Project settings (design A3) inside the Settings sheet. Every
// edit is one dispatch through useProjectActions. Schedules and shared
// instructions push inside the sheet.

type ProjectSettingsRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
};

function modelMenu(input: {
  readonly config: ServerConfig | null;
  readonly project: EnvironmentProject;
}): { readonly options: ReadonlyArray<ModelOption>; readonly current: ModelOption | null } {
  const selection =
    input.config === null
      ? (input.project.defaultModelSelection ?? null)
      : resolveProjectSettings(input.config.settings, input.project.id, input.project).settings
          .defaultModelSelection;
  const options = buildModelOptions(input.config, selection);
  const current =
    selection === null
      ? null
      : (options.find(
          (option) =>
            option.selection.instanceId === selection.instanceId &&
            option.selection.model === selection.model,
        ) ?? null);
  return { options, current };
}

/** Provider-grouped native menu; one provider lists its models inline. */
function modelMenuActions(models: ReturnType<typeof modelMenu> | null): MenuAction[] {
  if (models === null) return [];
  const currentKey = models.current?.key ?? null;
  const groups = groupByProvider(models.options);
  return groups.map((group) => ({
    id: `provider:${group.providerKey}`,
    title: group.providerLabel,
    displayInline: groups.length === 1,
    subactions: group.models.map((option) => ({
      id: `model:${option.key}`,
      title: option.label,
      ...(option.subtitle.length > 0 ? { subtitle: option.subtitle } : {}),
      state: option.key === currentKey ? ("on" as const) : ("off" as const),
      ...(option.isUnavailable === true ? { attributes: { disabled: true } } : {}),
    })),
  }));
}

export function ProjectSettingsRouteScreen({
  route,
}: StaticScreenProps<ProjectSettingsRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const config = useEnvironmentServerConfig(environmentId);
  const actions = useProjectActions();
  const isProject = project?.assistant != null;

  // Leave once, whether the Project was deleted here or elsewhere, or moved
  // back to Tasks from another client.
  const seenRef = useRef(false);
  const leftRef = useRef(false);
  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    navigation.goBack();
  }, [navigation]);
  useEffect(() => {
    if (isProject) {
      seenRef.current = true;
      return;
    }
    if (seenRef.current) leave();
  }, [isProject, leave]);

  const models = useMemo(
    () => (project === null ? null : modelMenu({ config, project })),
    [config, project],
  );
  const modelActions = useMemo(() => modelMenuActions(models), [models]);

  if (project === null || !isProject) {
    return (
      <SettingsScreen title="Project settings">
        <EmptyState
          title="Project unavailable"
          detail="Reconnect to its environment. It may also have been deleted."
        />
      </SettingsScreen>
    );
  }

  const archived = isArchivedAssistant(project);
  const iconActions: MenuAction[] = [
    { id: "choose", title: "Choose emoji…", image: "face.smiling" },
    {
      id: "automatic",
      title: "Use automatic icon",
      image: "arrow.uturn.backward",
      ...(project.projectIcon == null ? { attributes: { disabled: true } } : {}),
    },
  ];
  const openSharedInstructions = () =>
    navigation.dispatch(
      StackActions.push("SettingsProjectFile", {
        environmentId: String(project.environmentId),
        projectId: String(project.id),
        path: "AGENTS.md",
      }),
    );
  const schedules = config?.environment.capabilities.projectSchedules;
  const openSchedules = () =>
    navigation.dispatch(
      StackActions.push("SettingsProjectSchedules", {
        environmentId: String(project.environmentId),
        projectId: String(project.id),
      }),
    );

  return (
    <SettingsScreen title="Project settings">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="flex-row items-center gap-4 px-2">
          <ProjectFavicon
            environmentId={project.environmentId}
            projectTitle={project.title}
            workspaceRoot={project.workspaceRoot}
            faviconPath={project.faviconPath}
            projectIcon={project.projectIcon}
            size={48}
          />
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-t3-semibold text-foreground" numberOfLines={2}>
              {project.title}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {archived ? "Archived Project" : "Project"}
            </Text>
          </View>
        </View>

        <SettingsSection title="Project">
          <SettingsRow
            icon="pencil"
            label="Name"
            value={project.title}
            onPress={() => void actions.rename(project)}
          />
          <MenuRow
            icon="face.smiling"
            label="Icon"
            accessibilityLabel="Change the Project icon"
            title="Project icon"
            actions={iconActions}
            onPressAction={(id) => {
              if (id === "choose") void actions.setIcon(project);
              if (id === "automatic") void actions.resetIcon(project);
            }}
            trailing={
              <ProjectFavicon
                environmentId={project.environmentId}
                projectTitle={project.title}
                workspaceRoot={project.workspaceRoot}
                faviconPath={project.faviconPath}
                projectIcon={project.projectIcon}
                size={22}
              />
            }
          />
          <View className="gap-1 p-4">
            <View className="flex-row items-center gap-4">
              <SymbolView
                name="folder"
                size={Platform.OS === "android" ? 24 : 22}
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="regular"
              />
              <Text className="text-lg text-foreground android:text-base">Folder</Text>
            </View>
            <Text className="text-sm leading-normal text-foreground-muted" selectable>
              {project.workspaceRoot}
            </Text>
          </View>
        </SettingsSection>

        <SettingsSection title="Default model for new agents">
          <MenuRow
            icon="cpu"
            label="Model"
            accessibilityLabel="Default model for new agents"
            title="Default model for new agents"
            actions={modelActions}
            onPressAction={(id) => {
              const option = models?.options.find((entry) => `model:${entry.key}` === id);
              if (option) void actions.setDefaultModel(project, option.selection);
            }}
            trailing={
              <Text
                className="max-w-[180px] text-right text-base text-foreground-muted"
                numberOfLines={1}
              >
                {models?.current?.label ?? "Not set"}
              </Text>
            }
          />
        </SettingsSection>
        <Footnote>The coordinator's own model is changed in its composer.</Footnote>

        {schedules !== undefined ? (
          <>
            <SettingsSection>
              <SettingsRow
                icon="clock"
                label="Schedules"
                value={summarizeSchedules(project.assistant)}
                onPress={openSchedules}
              />
            </SettingsSection>
            <Footnote>Run on the host in {schedules.timeZone}.</Footnote>
          </>
        ) : null}

        <SettingsSection>
          <SettingsRow
            icon="doc.text"
            label="Shared instructions"
            value="AGENTS.md"
            onPress={openSharedInstructions}
          />
        </SettingsSection>
        <Footnote>Read by the coordinator and every agent.</Footnote>

        <SettingsSection title="Danger zone">
          {archived ? (
            <SettingsActionRow
              icon="arrow.uturn.backward"
              label="Unarchive Project"
              onPress={() => void actions.unarchive(project)}
            />
          ) : (
            <SettingsActionRow
              icon="archivebox"
              label="Archive Project"
              onPress={() => void actions.archive(project)}
            />
          )}
          <SettingsActionRow
            icon="trash"
            label="Delete Project"
            tone="danger"
            onPress={() =>
              void actions.requestDelete(project).then((deleted) => {
                if (deleted) leave();
              })
            }
          />
        </SettingsSection>
        <Footnote>
          {archived
            ? "Unarchive returns it to Projects on Home."
            : "Archive stops its agents and hides it from the sidebar. Files stay."}{" "}
          Delete removes the coordinator and all agent threads. Files on disk stay.
        </Footnote>
      </ScrollView>
    </SettingsScreen>
  );
}
