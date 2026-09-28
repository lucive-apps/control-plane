// @effect-diagnostics nodeBuiltinImport:off - Electron requires the work before `ready` to run synchronously, which the Effect FileSystem cannot do.
import * as NodeFS from "node:fs";

import type { HomeProbe } from "@t3tools/shared/home";

/**
 * Synchronous reads for the home and profile resolvers on the way to the Clerk
 * bridge. The bridge registers a privileged scheme, which Electron rejects once
 * `ready` has fired, and an awaited read hands the main thread back to Electron
 * so `ready` can fire first.
 */
export const syncHomeProbe: HomeProbe = {
  exists: (path) => NodeFS.existsSync(path),
  isSymbolicLink: (path) => {
    try {
      return NodeFS.lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  readFileString: (path) => {
    try {
      return NodeFS.readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  fileIdentity: (path) => {
    try {
      const stats = NodeFS.statSync(path);
      return { dev: stats.dev, ino: stats.ino };
    } catch {
      return undefined;
    }
  },
};
