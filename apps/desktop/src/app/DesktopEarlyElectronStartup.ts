import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  isDevelopment ? "com.lucive.ControlPlane.Development.desktop" : "com.lucive.ControlPlane.desktop";

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

export const isDesktopDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

export function resolveDesktopChromiumUserDataPath(input: {
  readonly appDataDirectory: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly pathExists: (path: string) => boolean;
}): string {
  const userDataDirName = input.isDevelopment ? "t3code-dev" : "t3code";
  const legacyUserDataDirName = input.isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
  const legacyPath = input.joinPath(input.appDataDirectory, legacyUserDataDirName);
  return input.pathExists(legacyPath)
    ? legacyPath
    : input.joinPath(input.appDataDirectory, userDataDirName);
}

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
}): string {
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDesktopDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    t3Home,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDesktopDevelopmentEnvironment(input.env);
  return {
    isDevelopment,
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment),
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
