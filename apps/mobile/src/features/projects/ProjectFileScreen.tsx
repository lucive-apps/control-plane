import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { readFailureMeansMissing } from "@t3tools/client-runtime/state/assistant-flows";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, type ProjectReadFileResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AndroidScreenHeader,
  type AndroidHeaderAction,
} from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import { FilePreviewLoading, FilePreviewNotice } from "../files/FilePreviewFeedback";
import type { ProjectFilePath } from "./useProjectActions";

// Fork-owned. The Memory sheet (design A5): a Project file rendered, with Edit
// for a plain text editor. The same screen edits AGENTS.md from Project
// settings. Saves are last-write-wins against the coordinator's own edits, as
// on desktop, so Edit reads the file again first.

type ProjectFileRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly path: string;
};

const FOOTNOTES: Record<ProjectFilePath, string> = {
  "MEMORY.md": "Changes apply on the coordinator's next session.",
  "AGENTS.md": "Read by the coordinator and every agent.",
};

function isProjectFilePath(path: string): path is ProjectFilePath {
  return Object.hasOwn(FOOTNOTES, path);
}

const EMPTY_READ_ATOM = Atom.make(AsyncResult.initial<ProjectReadFileResult, unknown>(false)).pipe(
  Atom.withLabel("mobile-project-file:empty"),
);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function confirmDiscard(onDiscard: () => void): void {
  const title = "Discard changes?";
  const message = "Your edits have not been saved.";
  if (Platform.OS === "ios") {
    Alert.alert(title, message, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onDiscard },
    ]);
    return;
  }
  showConfirmDialog({
    title,
    message,
    cancelText: "Keep editing",
    confirmText: "Discard",
    destructive: true,
    onConfirm: onDiscard,
  });
}

export function ProjectFileScreen({ route }: StaticScreenProps<ProjectFileRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const path = route.params.path;
  const project = useProject(scopeProjectRef(environmentId, projectId));
  // The coordinator is Local, so the Project folder is its workspace root.
  const cwd = project?.workspaceRoot ?? null;
  const knownPath = isProjectFilePath(path) ? path : null;

  const readAtom: Atom.Atom<AsyncResult.AsyncResult<ProjectReadFileResult, unknown>> | null =
    useMemo(
      () =>
        cwd === null || knownPath === null
          ? null
          : projectEnvironment.readFile({ environmentId, input: { cwd, relativePath: knownPath } }),
      [cwd, environmentId, knownPath],
    );
  const result = useAtomValue(readAtom ?? EMPTY_READ_ATOM);
  const failure = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  const missing = failure !== null && readFailureMeansMissing(failure);
  const file = missing ? null : Option.getOrNull(AsyncResult.value(result));
  const truncated = file?.truncated === true;

  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [editor, setEditor] = useState<{
    readonly original: string;
    readonly draft: string;
  } | null>(null);
  const [busy, setBusy] = useState<"opening" | "saving" | null>(null);
  const dirty = editor !== null && editor.draft !== editor.original;

  const reread = useCallback(
    () =>
      readAtom === null
        ? Promise.resolve(null)
        : executeAtomQuery(appAtomRegistry, readAtom, { refresh: true, reportFailure: false }),
    [readAtom],
  );

  const startEditing = useCallback(async () => {
    if (busy !== null) return;
    setBusy("opening");
    const fresh = await reread();
    setBusy(null);
    if (fresh === null) return;
    if (fresh._tag === "Success") {
      if (fresh.value.truncated) {
        Alert.alert("Too large to edit", "Too large to edit on this device.");
        return;
      }
      setEditor({ original: fresh.value.contents, draft: fresh.value.contents });
      return;
    }
    if (isAtomCommandInterrupted(fresh)) return;
    const error = squashAtomCommandFailure(fresh);
    // A missing file opens empty; saving creates it.
    if (readFailureMeansMissing(error)) {
      setEditor({ original: "", draft: "" });
      return;
    }
    Alert.alert("Could not open the file", errorMessage(error, "The file could not be read."));
  }, [busy, reread]);

  const save = useCallback(async () => {
    if (editor === null || knownPath === null || busy !== null) return;
    if (cwd === null) {
      Alert.alert(
        "Could not save",
        "The Project is unavailable. Reconnect to its environment. It may also have been deleted.",
      );
      return;
    }
    setBusy("saving");
    const written = await writeFile({
      environmentId,
      input: { cwd, relativePath: knownPath, contents: editor.draft },
    });
    if (written._tag === "Failure") {
      setBusy(null);
      if (!isAtomCommandInterrupted(written)) {
        Alert.alert(
          "Could not save",
          errorMessage(squashAtomCommandFailure(written), "The file could not be saved."),
        );
      }
      return;
    }
    await reread();
    setBusy(null);
    setEditor(null);
  }, [busy, cwd, editor, environmentId, knownPath, reread, writeFile]);

  const cancelEditing = useCallback(() => {
    if (dirty) {
      confirmDiscard(() => setEditor(null));
      return;
    }
    setEditor(null);
  }, [dirty]);

  // Swiping the sheet down or going back never drops unsaved text silently.
  usePreventRemove(dirty, ({ data }) => {
    confirmDiscard(() => navigation.dispatch(data.action));
  });

  const editing = editor !== null;
  const canEdit = readAtom !== null && !truncated && busy === null && (file !== null || missing);
  // The first screen of the Project sheet closes it; inside Settings the
  // native back button returns to Project settings.
  const isSheetRoot = navigation.getState()?.index === 0;
  const title = knownPath ?? "File";
  const subtitle = project?.title;

  const androidActions: AndroidHeaderAction[] = editing
    ? [
        {
          accessibilityLabel: "Cancel editing",
          icon: "xmark",
          onPress: cancelEditing,
          disabled: busy !== null,
        },
        {
          accessibilityLabel: `Save ${title}`,
          icon: "checkmark",
          onPress: () => void save(),
          disabled: busy !== null,
        },
      ]
    : [
        {
          accessibilityLabel: `Edit ${title}`,
          icon: "square.and.pencil",
          onPress: () => void startEditing(),
          disabled: !canEdit,
        },
      ];

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          headerBackVisible: !editing,
          title,
          unstable_headerSubtitle: Platform.OS === "ios" ? subtitle : undefined,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          subtitle={subtitle ?? null}
          actions={androidActions}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      {editing ? (
        <>
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="Cancel editing"
              disabled={busy !== null}
              label="Cancel"
              onPress={cancelEditing}
            />
          </NativeHeaderToolbar>
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel={`Save ${title}`}
              disabled={busy !== null}
              label="Save"
              onPress={() => void save()}
            />
          </NativeHeaderToolbar>
        </>
      ) : (
        <>
          {isSheetRoot ? (
            <NativeHeaderToolbar placement="left">
              <NativeHeaderToolbar.Button
                accessibilityLabel="Close"
                label="Done"
                onPress={() => navigation.goBack()}
              />
            </NativeHeaderToolbar>
          ) : null}
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel={`Edit ${title}`}
              disabled={!canEdit}
              label="Edit"
              onPress={() => void startEditing()}
            />
          </NativeHeaderToolbar>
        </>
      )}

      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View className="flex-1">
          {knownPath === null ? (
            <EmptyState title="File unavailable" detail="Only MEMORY.md and AGENTS.md open here." />
          ) : editor !== null ? (
            // Checked before the Project, so a draft survives the Project
            // going away mid-edit. Markdown and code stay as typed.
            <AppTextInput
              accessibilityLabel={`${knownPath} contents`}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoFocus
              className="flex-1 rounded-none border-0 bg-sheet px-5 py-4 text-base"
              editable={busy === null}
              multiline
              onChangeText={(draft) =>
                setEditor((current) => (current === null ? current : { ...current, draft }))
              }
              scrollEnabled
              textAlignVertical="top"
              value={editor.draft}
            />
          ) : project === null ? (
            <EmptyState
              title="Project unavailable"
              detail="Reconnect to its environment. It may also have been deleted."
            />
          ) : missing ? (
            <EmptyState title={`No ${knownPath} yet`} detail="Tap Edit to create it." />
          ) : file !== null ? (
            <>
              {truncated ? (
                <FilePreviewNotice title="Partial file">
                  Too large to edit on this device.
                </FilePreviewNotice>
              ) : null}
              <FileMarkdownPreview
                cwd={project.workspaceRoot}
                environmentId={environmentId}
                markdown={file.contents}
                relativePath={knownPath}
                threadId={null}
                onRefresh={() => reread().then(() => undefined)}
              />
            </>
          ) : failure !== null ? (
            <EmptyState
              title="File unavailable"
              detail={errorMessage(failure, "The file could not be read.")}
              actionLabel="Try again"
              onAction={() => void reread()}
            />
          ) : (
            <FilePreviewLoading message="Loading file..." />
          )}
        </View>
        {knownPath !== null ? (
          <Text
            className="border-t border-border-subtle px-5 pt-2.5 text-xs text-foreground-tertiary"
            style={{ paddingBottom: editing ? 10 : Math.max(insets.bottom, 12) }}
          >
            {FOOTNOTES[knownPath]}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}
