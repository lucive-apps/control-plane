import {
  desktopProfileDirs,
  type FileIdentity,
  resolveHomeSync,
  selectDesktopProfileDir,
} from "@t3tools/shared/home";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import { resolveDesktopStateDir, type JoinPath } from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  /** Throws when the file cannot be read. */
  readonly readFileString: (path: string) => string;
  readonly pathExists: (path: string) => boolean;
  readonly isSymbolicLink: (path: string) => boolean;
  readonly fileIdentity: (path: string) => FileIdentity | undefined;
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
  const dirs = desktopProfileDirs({
    appDataDirectory: input.appDataDirectory,
    isDevelopment: input.isDevelopment,
    join: input.joinPath,
  });
  return selectDesktopProfileDir(dirs, {
    cplane: input.pathExists(dirs.cplane),
    legacy: input.pathExists(dirs.legacy),
  });
}

// Must land on the same file DesktopEnvironment later resolves, so it runs the
// same home resolver synchronously.
function resolveEarlyDesktopSettingsPath(input: EarlyDesktopSettingsInput): string {
  const isDevelopment = isDesktopDevelopmentEnvironment(input.env);
  const home = resolveHomeSync(
    {
      homeDirectory: input.homeDirectory,
      join: input.joinPath,
      env: { CPLANE_HOME: input.env.CPLANE_HOME, T3CODE_HOME: input.env.T3CODE_HOME },
      variant: isDevelopment ? "dev" : "userdata",
    },
    {
      exists: input.pathExists,
      isSymbolicLink: input.isSymbolicLink,
      fileIdentity: input.fileIdentity,
      readFileString: (path) => {
        try {
          return input.readFileString(path);
        } catch {
          return undefined;
        }
      },
    },
  );
  const stateDir = resolveDesktopStateDir({ home, isDevelopment, joinPath: input.joinPath });
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
