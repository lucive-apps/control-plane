import * as NodeOS from "node:os";

import { isLegacyDefaultHome, writeOwnerMarker } from "@t3tools/shared/home";
import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

/**
 * Marks `~/.t3/userdata` as Control Plane's when a server starts on it, so the
 * R1 move knows it may copy that home. Dev servers (`devUrl` set) never mark
 * the home they share with the installed app.
 */
export const markDefaultHomeOwner = Effect.fn(function* (
  config: Pick<ServerConfig["Service"], "baseDir" | "stateDir" | "devUrl">,
  homeDirectory: string,
) {
  if (config.devUrl === undefined && (yield* isLegacyDefaultHome(config.baseDir, homeDirectory))) {
    yield* writeOwnerMarker(config.stateDir, packageJson.version);
  }
});

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    yield* markDefaultHomeOwner(config, NodeOS.homedir());
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
