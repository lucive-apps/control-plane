export const FORK_APP_BASE_NAME = "Control Plane";
export const FORK_GITHUB_REPOSITORY = "lucive-apps/control-plane";
export const FORK_DESKTOP_APP_ID = "com.lucive.controlplane";
export const FORK_DESKTOP_DEV_APP_ID = "com.lucive.controlplane.dev";
export const FORK_ARTIFACT_NAME = "Control-Plane-${version}-${arch}.${ext}";
export const FORK_IOS_APPLE_TEAM_ID = "37FM6MWUPG";
export const FORK_IOS_BUNDLE_ID = "app.lucive.controlplane";

export function forkAppDisplayName(stageLabel: "Dev" | "Nightly" | null = null): string {
  return stageLabel === "Dev" || stageLabel === "Nightly"
    ? `${FORK_APP_BASE_NAME} (${stageLabel})`
    : FORK_APP_BASE_NAME;
}

export const FORK_DESKTOP_PROTOCOL_SCHEMES = [
  "controlplane",
  "controlplane-dev",
  "t3code",
  "t3code-dev",
] as const;
