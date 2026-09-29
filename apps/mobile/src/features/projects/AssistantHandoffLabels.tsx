import type { AgentMessagePresentation } from "@t3tools/client-runtime/state/assistant-thread-view";
import { formatScheduledMessageTime } from "@t3tools/client-runtime/state/schedules";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { AssistantFeedTimeline } from "./useAssistantThreadView";

// Fork-owned. What a Project's handoff messages add to the thread feed, kept
// out of the upstream-shared ThreadFeed.

/** Above a manager's request in an agent thread: the Project or the agent that asked, linked. */
export function AssistantAttributionLabel(props: {
  readonly timeline: AssistantFeedTimeline;
  readonly attribution: Extract<AgentMessagePresentation, { kind: "attributed-user" }>;
}) {
  const { timeline, attribution } = props;
  const { project } = timeline;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`From ${attribution.displayName}`}
      accessibilityHint="Opens that thread"
      hitSlop={6}
      onPress={() => timeline.onOpenThread(attribution.linkThreadId)}
      className="mb-1 max-w-[80%] flex-row items-center gap-1.5 pr-1"
    >
      <ProjectFavicon
        environmentId={project.environmentId}
        faviconPath={project.faviconPath}
        projectIcon={project.projectIcon}
        projectTitle={project.title}
        size={12}
        workspaceRoot={project.workspaceRoot}
      />
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {attribution.displayName}
      </Text>
    </Pressable>
  );
}

/** Above a prompt a Project schedule sent: "Scheduled · <name> · 7:00", in the device's zone. */
export function ScheduledRunLabel(props: {
  readonly name: string;
  /** When the prompt arrived: the message's `createdAt`. */
  readonly at: string;
  readonly iconColor: ColorValue;
}) {
  const time = formatScheduledMessageTime(props.at, new Date());
  return (
    <View className="mb-1 max-w-[80%] flex-row items-center gap-1.5 pr-1">
      <SymbolView name="clock" size={12} tintColor={props.iconColor} />
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {["Scheduled", props.name, time].filter((part) => part.length > 0).join(" · ")}
      </Text>
    </View>
  );
}

/** "<Agent> replied" inside a row label, the name opening that agent's thread. */
export function AgentRepliedLabel(props: {
  readonly displayName: string;
  readonly onOpen: () => void;
}) {
  return (
    <>
      <Text className="font-t3-medium text-foreground" onPress={props.onOpen} suppressHighlighting>
        {props.displayName}
      </Text>
      {" replied"}
    </>
  );
}
