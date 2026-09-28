// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  resolveDesktopChromiumUserDataPath,
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
} from "./DesktopEarlyElectronStartup.ts";

describe("DesktopEarlyElectronStartup", () => {
  const joinPath = NodePath.posix.join;
  // No `~/.cplane` and no symlinks: the home resolves exactly as before M1.
  const noHomeLayout = {
    pathExists: () => false,
    isSymbolicLink: () => false,
    fileIdentity: () => undefined,
  };

  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("accepts JSONC in the early desktop settings file", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: () => `{
        // manually edited setting
        "linuxPasswordStore": "gnome-libsecret",
      }`,
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("falls back to auto when the early settings document is missing or invalid", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: () => {
        throw new Error("missing");
      },
    });

    assert.equal(preference, "auto");
  });

  it("preserves absolute root paths when resolving early settings", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/" },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
    });

    assert.deepEqual(options, {
      isDevelopment: true,
      linuxWmClass: "t3code-dev",
      linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
      passwordStore: "gnome-libsecret",
    });
  });

  it("keeps implicit development state under ~/.t3/dev when T3CODE_HOME is unset", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  it("treats whitespace-only T3CODE_HOME as unconfigured in development", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        T3CODE_HOME: "   ",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      ...noHomeLayout,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "gnome-libsecret" });
      },
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("pins Chromium userData to t3code-dev before GPU process spawn", () => {
    assert.equal(
      resolveDesktopChromiumUserDataPath({
        appDataDirectory: "/Users/alice/Library/Application Support",
        isDevelopment: true,
        joinPath,
        pathExists: () => false,
      }),
      "/Users/alice/Library/Application Support/t3code-dev",
    );
  });

  it("keeps a legacy Chromium userData directory when one already exists", () => {
    assert.equal(
      resolveDesktopChromiumUserDataPath({
        appDataDirectory: "/Users/alice/Library/Application Support",
        isDevelopment: true,
        joinPath,
        pathExists: (path) => path.endsWith("T3 Code (Dev)"),
      }),
      "/Users/alice/Library/Application Support/T3 Code (Dev)",
    );
  });

  it("switches Chromium userData to an existing cplane profile", () => {
    const appDataDirectory = "/Users/alice/Library/Application Support";
    const everyProfileExists = () => true;

    assert.equal(
      resolveDesktopChromiumUserDataPath({
        appDataDirectory,
        isDevelopment: false,
        joinPath,
        pathExists: everyProfileExists,
      }),
      `${appDataDirectory}/cplane`,
    );
    assert.equal(
      resolveDesktopChromiumUserDataPath({
        appDataDirectory,
        isDevelopment: true,
        joinPath,
        pathExists: everyProfileExists,
      }),
      `${appDataDirectory}/cplane-dev`,
    );
  });

  it("reads settings from the home the desktop will use once ~/.cplane exists", () => {
    const layout = (paths: Record<string, string>) => ({
      homeDirectory: "/home/user",
      joinPath,
      isSymbolicLink: () => false,
      fileIdentity: () => undefined,
      pathExists: (path: string) =>
        path === "/home/user/.cplane/userdata" || Object.hasOwn(paths, path),
      readFileString: (path: string) => {
        const contents = paths[path];
        if (contents === undefined) throw new Error(`missing ${path}`);
        return contents;
      },
    });
    const settings = JSON.stringify({ linuxPasswordStore: "kwallet6" });
    const completedMove = JSON.stringify({
      state: "complete",
      from: "/home/user/.t3",
      environmentId: "environment-1",
      sourceMaxSequence: 7,
      at: "2026-01-01T00:00:00.000Z",
      version: "0.0.60",
    });

    assert.equal(
      resolveEarlyLinuxPasswordStorePreference({
        env: {},
        ...layout({ "/home/user/.cplane/userdata/desktop-settings.json": settings }),
      }),
      "kwallet6",
    );
    // An inherited T3CODE_HOME follows the completed move.
    assert.equal(
      resolveEarlyLinuxPasswordStorePreference({
        env: { T3CODE_HOME: "/home/user/.t3" },
        ...layout({
          "/home/user/.cplane/userdata/home-migration.json": completedMove,
          "/home/user/.cplane/userdata/desktop-settings.json": settings,
        }),
      }),
      "kwallet6",
    );
    // Dev state stays in ~/.t3/dev.
    assert.equal(
      resolveEarlyLinuxPasswordStorePreference({
        env: { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
        ...layout({ "/home/user/.t3/dev/desktop-settings.json": settings }),
      }),
      "kwallet6",
    );
  });
});
