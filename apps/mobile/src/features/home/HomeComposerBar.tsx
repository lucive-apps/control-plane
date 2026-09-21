import { StackActions, useNavigation } from "@react-navigation/native";
import { TextInputWrapper } from "expo-paste-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { AppTextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import { GlassSurface } from "../../components/GlassSurface";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { convertPastedImagesToAttachments, pickComposerMedia } from "../../lib/composerImages";
import { useNativePaste } from "../../lib/useNativePaste";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { NewTaskFlowProvider, useNewTaskFlow } from "../threads/new-task-flow-provider";
import { ComposerDictationStopChip } from "../voice-input/ComposerDictationControl";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";

const COLLAPSED_INPUT_HEIGHT = 52;
const MIN_INPUT_HEIGHT = 52;

type PickerKind = "workspace" | "environments" | "model";

type PickerItem = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly selected: boolean;
};

function CircleIconButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: "mic" | "arrow.up";
  readonly onPress: () => void;
  readonly variant?: "primary" | "muted";
}) {
  const variant = props.variant ?? "muted";
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        variant === "primary"
          ? "size-11 items-center justify-center rounded-full bg-primary active:opacity-70"
          : "size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      }
    >
      <SymbolView
        name={props.icon === "arrow.up" ? "arrow.up" : "mic"}
        size={20}
        tintColorClassName={variant === "primary" ? "accent-primary-foreground" : "accent-icon"}
        type="monochrome"
      />
    </Pressable>
  );
}

function ComposerPickerSheet(props: {
  readonly title: string;
  readonly visible: boolean;
  readonly items: ReadonlyArray<PickerItem>;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return props.items;
    return props.items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        (item.subtitle?.toLowerCase().includes(needle) ?? false),
    );
  }, [props.items, query]);
  const active = filtered.filter((item) => item.selected);
  const more = filtered.filter((item) => !item.selected);

  useEffect(() => {
    if (!props.visible) setQuery("");
  }, [props.visible]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible={props.visible}
    >
      <View className="flex-1 bg-screen" style={{ paddingTop: 12 }}>
        <View className="flex-row items-center px-4 pb-3">
          <Pressable
            accessibilityLabel="Close"
            className="size-10 items-center justify-center rounded-full bg-subtle"
            onPress={props.onClose}
          >
            <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
          <Text className="flex-1 text-center text-lg font-t3-medium text-foreground">
            {props.title}
          </Text>
          <View className="size-10" />
        </View>
        <View className="px-4 pb-3">
          <AppTextInput
            className="min-h-11 rounded-full px-4"
            onChangeText={setQuery}
            placeholder={`${props.title}...`}
            value={query}
          />
        </View>
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {active.length > 0 ? (
            <View className="px-4 pb-2">
              <Text className="pb-2 text-sm text-foreground-muted">Active</Text>
              {active.map((item) => (
                <PickerRow key={item.id} item={item} onSelect={props.onSelect} />
              ))}
            </View>
          ) : null}
          {more.length > 0 ? (
            <View className="px-4">
              <Text className="pb-2 text-sm text-foreground-muted">More</Text>
              {more.map((item) => (
                <PickerRow key={item.id} item={item} onSelect={props.onSelect} />
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function PickerRow(props: { readonly item: PickerItem; readonly onSelect: (id: string) => void }) {
  return (
    <Pressable
      className="min-h-12 flex-row items-center gap-3 py-3"
      onPress={() => props.onSelect(props.item.id)}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.item.title}</Text>
        {props.item.subtitle ? (
          <Text className="text-sm text-foreground-muted">{props.item.subtitle}</Text>
        ) : null}
      </View>
      {props.item.selected ? (
        <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" type="monochrome" />
      ) : null}
    </Pressable>
  );
}

export function HomeComposerBar(
  props: {
    readonly lockedProject?: EnvironmentProject | null;
  } = {},
) {
  return (
    <NewTaskFlowProvider>
      <HomeComposerBarInner lockedProject={props.lockedProject ?? null} />
    </NewTaskFlowProvider>
  );
}

function HomeComposerBarInner(props: { readonly lockedProject: EnvironmentProject | null }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const flow = useNewTaskFlow();
  const inputRef = useRef<TextInput>(null);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const { height: keyboardTranslate } = useReanimatedKeyboardAnimation();
  const restBottom = Math.max(insets.bottom, 10);
  const stickyStyle = useAnimatedStyle(() => {
    const openHeight = Math.max(0, -keyboardTranslate.value);
    const lift = Math.max(0, openHeight - restBottom);
    return { transform: [{ translateY: -lift }] };
  }, [restBottom]);
  const windowHeight = useWindowDimensions().height;
  const maxInputHeight = Math.max(
    MIN_INPUT_HEIGHT,
    Math.round(windowHeight - keyboardHeight - insets.top - 76 - 128),
  );
  const inputHeight = useSharedValue(COLLAPSED_INPUT_HEIGHT);
  const dragStartHeight = useSharedValue(COLLAPSED_INPUT_HEIGHT);
  const inputHeightStyle = useAnimatedStyle(() => ({
    minHeight: inputHeight.value,
  }));
  const collapse = useCallback(() => {
    if (picker !== null) return;
    setExpanded(false);
    inputHeight.value = COLLAPSED_INPUT_HEIGHT;
    inputRef.current?.blur();
    Keyboard.dismiss();
  }, [inputHeight, picker]);
  const resizeComposer = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-6, 6])
        .onStart(() => {
          dragStartHeight.value = inputHeight.value;
        })
        .onEnd((event) => {
          const flickDown = event.translationY > 28 || event.velocityY > 500;
          const flickUp = event.translationY < -28 || event.velocityY < -500;
          if (flickDown) {
            inputHeight.value = COLLAPSED_INPUT_HEIGHT;
            runOnJS(collapse)();
            return;
          }
          inputHeight.value = flickUp ? maxInputHeight : MIN_INPUT_HEIGHT;
        }),
    [collapse, dragStartHeight, inputHeight, maxInputHeight],
  );
  const setProject = flow.setProject;
  const firstProject = flow.projectScopes[0]?.representative ?? null;
  const lockedProject = props.lockedProject;

  useEffect(() => {
    if (lockedProject !== null) {
      setProject(lockedProject);
      return;
    }
    if (!expanded || flow.selectedProject !== null || firstProject === null) return;
    setProject(firstProject);
  }, [expanded, firstProject, flow.selectedProject, lockedProject, setProject]);

  const voiceInput = useVoiceInputController({
    ownerKey: "home-composer",
    draftMessage: flow.prompt,
    selection: { start: flow.prompt.length, end: flow.prompt.length },
    disabled: flow.submitting,
    onChangeDraftMessage: flow.setPrompt,
    onChangeSelection: () => undefined,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isDictating = voicePresentation.statusKind === "active";

  const handlePasteImages = useNativePaste((uris) => {
    void (async () => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: flow.attachments.length,
        });
        if (images.length > 0) {
          flow.appendAttachments(images);
          setExpanded(true);
        }
      } catch (error) {
        console.error("[home composer paste]", error);
      }
    })();
  });

  const expand = () => {
    inputHeight.value = COLLAPSED_INPUT_HEIGHT;
    setExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async () => {
    if (flow.prompt.trim().length === 0 || flow.submitting) return;
    if (flow.selectedProject === null && firstProject !== null) setProject(firstProject);
    const message = flow.buildPendingTaskMessage(makeTurnCommandMetadata(), {
      currentCheckoutBranch: flow.currentCheckoutBranchName,
    });
    if (!message) return;
    flow.setSubmitting(true);
    try {
      await enqueueThreadOutboxMessage(message);
      flow.setPrompt("");
      collapse();
      navigation.dispatch(
        StackActions.push("Thread", {
          environmentId: String(message.environmentId),
          threadId: String(message.threadId),
        }),
      );
    } finally {
      flow.setSubmitting(false);
    }
  };

  const attachPhotos = async () => {
    const result = await pickComposerMedia({ existingCount: flow.attachments.length });
    if (result.attachments.length > 0) {
      flow.appendAttachments(result.attachments);
      expand();
    }
    if (result.error) Alert.alert("Could not attach photo", result.error);
  };

  const takePhoto = async () => {
    try {
      const imagePicker = await import("expo-image-picker");
      const permission = await imagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Camera access needed", "Allow camera access to take a photo.");
        return;
      }
      const result = await imagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
      if (result.canceled || !result.assets[0]?.uri) return;
      const images = await convertPastedImagesToAttachments({
        uris: [result.assets[0].uri],
        existingCount: flow.attachments.length,
      });
      if (images.length > 0) {
        flow.appendAttachments(images);
        expand();
      }
    } catch (error) {
      Alert.alert(
        "Could not take photo",
        error instanceof Error ? error.message : "The camera is unavailable.",
      );
    }
  };

  const machineLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ??
    flow.environments[0]?.environmentLabel ??
    "Environment";
  const projectLabel = flow.selectedProject?.title ?? "Workspace";
  const modelLabel = flow.selectedModelOption?.label ?? "Model";
  const hasText = flow.prompt.trim().length > 0;

  const plusMenu = (
    <ControlPillMenu
      accessibilityLabel="Add photos"
      actions={[
        { id: "photos", title: "Add Photos", image: "photo" },
        { id: "camera", title: "Take a Photo", image: "camera" },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") void attachPhotos();
        if (nativeEvent.event === "camera") void takePhoto();
      }}
    >
      <View className="size-11 items-center justify-center rounded-full bg-subtle">
        <SymbolView name="plus" size={20} tintColorClassName="accent-icon" type="monochrome" />
      </View>
    </ControlPillMenu>
  );

  const micButton = (
    <CircleIconButton
      accessibilityLabel="Start dictation"
      disabled={flow.submitting}
      icon="mic"
      onPress={() => {
        expand();
        voiceInput.start();
      }}
    />
  );
  const sendButton = (
    <CircleIconButton
      accessibilityLabel="Send"
      disabled={flow.submitting}
      icon="arrow.up"
      onPress={() => void send()}
      variant="primary"
    />
  );
  const trailingControl = isDictating ? (
    <ComposerDictationStopChip
      audioLevels={voiceInput.audioLevels}
      elapsedSeconds={voiceInput.elapsedSeconds}
      onStop={voiceInput.stop}
    />
  ) : hasText ? (
    <View className="flex-row items-center gap-2">
      {micButton}
      {sendButton}
    </View>
  ) : (
    micButton
  );

  return (
    <>
      <Animated.View
        pointerEvents="box-none"
        style={[
          {
            position: "absolute",
            bottom: restBottom,
            left: 0,
            right: 0,
          },
          stickyStyle,
        ]}
      >
        {expanded ? (
          <Pressable
            accessibilityLabel="Dismiss composer"
            onPress={collapse}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: "100%",
              height: windowHeight,
            }}
          />
        ) : null}
        <View pointerEvents="box-none" className="px-3" style={{ paddingBottom: 6 }}>
          <GlassSurface
            className="overflow-hidden rounded-[28px] border border-border"
            fallbackClassName="bg-card"
          >
            {expanded ? (
              <View className="px-3 pb-2">
                <GestureDetector gesture={resizeComposer}>
                  <View
                    accessibilityLabel="Resize composer"
                    accessibilityRole="adjustable"
                    className="items-center py-2.5"
                    collapsable={false}
                  >
                    <View className="h-[5px] w-9 rounded-full bg-foreground/20" />
                  </View>
                </GestureDetector>
                <View className="flex-row flex-wrap items-center pb-1">
                  <ComposerInlineControl
                    chevronDirection="down"
                    label={projectLabel}
                    onPress={lockedProject ? undefined : () => setPicker("workspace")}
                    showChevron={lockedProject === null}
                    static={lockedProject !== null}
                  />
                  <ComposerInlineControl
                    chevronDirection="down"
                    icon="desktopcomputer"
                    label={machineLabel}
                    onPress={() => setPicker("environments")}
                  />
                </View>
                <TextInputWrapper onPaste={handlePasteImages}>
                  <Animated.View style={inputHeightStyle}>
                    <AppTextInput
                      ref={inputRef}
                      autoFocus
                      className="border-0 bg-transparent px-1 py-2"
                      multiline
                      onChangeText={flow.setPrompt}
                      placeholder="Plan, ask, build..."
                      value={flow.prompt}
                    />
                  </Animated.View>
                </TextInputWrapper>
                <View className="flex-row items-center gap-1 pt-1">
                  {plusMenu}
                  <ComposerInlineControl
                    chevronDirection="down"
                    emphasized
                    label={modelLabel}
                    onPress={() => setPicker("model")}
                  />
                  <View className="flex-1" />
                  {trailingControl}
                </View>
              </View>
            ) : (
              <View className="min-h-[52px] flex-row items-center gap-3 px-3 py-2">
                {plusMenu}
                <Pressable className="flex-1 py-2" onPress={expand}>
                  <Text className="text-base text-foreground-muted" numberOfLines={1}>
                    {hasText ? flow.prompt : "Plan, ask, build..."}
                  </Text>
                </Pressable>
                {trailingControl}
              </View>
            )}
          </GlassSurface>
        </View>
      </Animated.View>
      <ComposerPickerSheet
        items={flow.projectScopes.map((scope) => ({
          id: scope.key,
          title: scope.title,
          selected: scope.key === flow.selectedProjectKey,
        }))}
        title="Workspace"
        visible={picker === "workspace"}
        onClose={() => setPicker(null)}
        onSelect={(id) => {
          const scope = flow.projectScopes.find((item) => item.key === id);
          if (scope) flow.setProject(scope.representative);
          setPicker(null);
        }}
      />
      <ComposerPickerSheet
        items={flow.environments.map((environment) => ({
          id: String(environment.environmentId),
          title: environment.environmentLabel,
          selected: environment.environmentId === flow.selectedEnvironmentId,
        }))}
        title="Environments"
        visible={picker === "environments"}
        onClose={() => setPicker(null)}
        onSelect={(id) => {
          const environment = flow.environments.find((item) => String(item.environmentId) === id);
          if (environment) flow.selectEnvironment(environment.environmentId);
          setPicker(null);
        }}
      />
      <ComposerPickerSheet
        items={flow.modelOptions.map((option) => ({
          id: option.key,
          title: option.label,
          subtitle: option.subtitle,
          selected: option.key === flow.selectedModelKey,
        }))}
        title="Model"
        visible={picker === "model"}
        onClose={() => setPicker(null)}
        onSelect={(id) => {
          flow.setSelectedModelKey(id);
          setPicker(null);
        }}
      />
    </>
  );
}
