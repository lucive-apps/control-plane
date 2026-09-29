import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";

export type ThreadInspectorMode = "route" | "git" | "files";

const INSPECTOR_PREWARM_DELAY_MS = 350;

function InspectorContentPane(props: {
  readonly children: ReactNode;
  readonly mounted: boolean;
  readonly visible: boolean;
}) {
  if (!props.mounted) {
    return null;
  }

  return (
    <View
      accessibilityElementsHidden={!props.visible}
      focusable={props.visible}
      importantForAccessibility={props.visible ? "auto" : "no-hide-descendants"}
      pointerEvents={props.visible ? "auto" : "none"}
      style={{
        position: "absolute",
        inset: 0,
        opacity: props.visible ? 1 : 0,
        zIndex: props.visible ? 1 : 0,
      }}
    >
      {props.children}
    </View>
  );
}

export function ThreadInspectorContentStack(props: {
  readonly Files: ComponentType;
  /** Absent where git controls are hidden (a Project's coordinator and Local agents). */
  readonly Git?: ComponentType;
  readonly mode: ThreadInspectorMode;
  readonly Route?: ComponentType;
}) {
  const [mountedModes, setMountedModes] = useState<ReadonlySet<ThreadInspectorMode>>(
    () => new Set([props.mode]),
  );
  const hasGit = props.Git !== undefined;

  useEffect(() => {
    setMountedModes((current) => {
      if (current.has(props.mode)) {
        return current;
      }
      return new Set([...current, props.mode]);
    });

    // Without Git there is no other chat inspector to keep warm.
    if (props.mode === "route" || !hasGit) {
      return;
    }

    // The file tree is expensive to detach because UIKit rebuilds its focus
    // graph. Keep both chat inspectors alive after the opening animation so a
    // later Files/Git switch only changes visibility.
    const alternateMode = props.mode === "files" ? "git" : "files";
    const timeout = setTimeout(() => {
      setMountedModes((current) => {
        if (current.has(alternateMode)) {
          return current;
        }
        return new Set([...current, alternateMode]);
      });
    }, INSPECTOR_PREWARM_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [hasGit, props.mode]);

  const Files = props.Files;
  const Git = props.Git;
  const Route = props.Route;

  return (
    <View className="flex-1">
      <InspectorContentPane
        mounted={mountedModes.has("files") || props.mode === "files"}
        visible={props.mode === "files"}
      >
        <Files />
      </InspectorContentPane>
      {Git ? (
        <InspectorContentPane
          mounted={mountedModes.has("git") || props.mode === "git"}
          visible={props.mode === "git"}
        >
          <Git />
        </InspectorContentPane>
      ) : null}
      {Route ? (
        <InspectorContentPane
          mounted={mountedModes.has("route") || props.mode === "route"}
          visible={props.mode === "route"}
        >
          <Route />
        </InspectorContentPane>
      ) : null}
    </View>
  );
}
