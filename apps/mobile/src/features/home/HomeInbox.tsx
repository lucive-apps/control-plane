import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { resolveThreadStatus } from "../threads/threadPresentation";
import { HomeComposerBar } from "./HomeComposerBar";

export type HomeInboxLane = "inbox" | "working" | "attention";

const INBOX_FOLDER_ICON_SIZE = 28;

export function classifyHomeThread(thread: EnvironmentThreadShell): "working" | "attention" | null {
  const status = resolveThreadStatus(thread);
  if (status?.kind === "working" || status?.kind === "connecting") return "working";
  if (
    status?.kind === "awaiting-input" ||
    status?.kind === "pending-approval" ||
    status?.kind === "plan-ready" ||
    status?.kind === "error"
  ) {
    return "attention";
  }
  if (thread.latestTurn?.completedAt && thread.session?.status !== "running") {
    return "attention";
  }
  return null;
}

export function HomeInbox(props: {
  readonly projects: ReadonlyArray<{ readonly key: string; readonly title: string }>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly showComposer: boolean;
  readonly onOpenWorking: () => void;
  readonly onOpenAttention: () => void;
  readonly onOpenProject: (projectKey: string) => void;
  readonly onAddProject: () => void;
}) {
  const insets = useSafeAreaInsets();
  let workingCount = 0;
  let attentionCount = 0;
  for (const thread of props.threads) {
    const lane = classifyHomeThread(thread);
    if (lane === "working") workingCount += 1;
    if (lane === "attention") attentionCount += 1;
  }

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 12) + (props.showComposer ? 88 : 24),
          paddingHorizontal: HOME_HORIZONTAL_INSET,
          paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 56 : 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="pb-4 text-[28px] font-t3-bold text-foreground">Inbox</Text>
        <View className="flex-row gap-3 pb-8">
          <InboxTile
            color="#0a84ff"
            count={workingCount}
            icon="arrow.triangle.2.circlepath"
            label="Working"
            onPress={props.onOpenWorking}
          />
          <InboxTile
            color="#ff9f0a"
            count={attentionCount}
            icon="bell.fill"
            label="Needs Attention"
            onPress={props.onOpenAttention}
          />
        </View>
        <Text className="pb-2 text-sm text-foreground-muted">Projects</Text>
        {props.projects.map((project) => (
          <Pressable
            key={project.key}
            className="min-h-14 flex-row items-center gap-3.5 py-3"
            onPress={() => props.onOpenProject(project.key)}
          >
            <View className="size-8 items-center justify-center">
              <SymbolView
                name="folder"
                size={INBOX_FOLDER_ICON_SIZE}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </View>
            <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
              {project.title}
            </Text>
            <SymbolView
              name="chevron.right"
              size={16}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        ))}
        <Pressable
          className="min-h-14 flex-row items-center gap-3.5 py-3"
          onPress={props.onAddProject}
        >
          <View className="size-8 items-center justify-center">
            <SymbolView
              name="folder.badge.plus"
              size={INBOX_FOLDER_ICON_SIZE}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </View>
          <Text className="text-base text-foreground-muted">Add Project</Text>
        </Pressable>
      </ScrollView>
      {props.showComposer ? <HomeComposerBar /> : null}
    </View>
  );
}

function InboxTile(props: {
  readonly color: string;
  readonly count: number;
  readonly icon: "arrow.triangle.2.circlepath" | "bell.fill";
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className="min-h-[112px] flex-1 justify-between rounded-2xl border border-border bg-card p-4"
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={22} tintColor={props.color} type="monochrome" />
      <Text className="text-base font-t3-medium text-foreground">
        {props.label} {props.count}
      </Text>
    </Pressable>
  );
}
