// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Backups and the integration's small state file are written from HID callbacks outside any Effect fiber.
// Fork-owned. Wires the Creator Micro 2 controller into the desktop app: its
// state file and backups under the desktop state dir, the IPC methods the
// settings panel and sidebar use, key presses into the window, and a clean
// release of the pad on shutdown.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import {
  CreatorMicroSlots,
  CreatorMicroState,
  type CreatorMicroKeyPress,
} from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  CreatorMicroController,
  DEFAULT_PERSISTED,
  type CreatorMicroPersisted,
} from "./CreatorMicroController.ts";
import { makeNodeHidBackend } from "./CreatorMicroNodeHid.ts";

const { logInfo, logWarning, logError } = makeComponentLogger("creator-micro");

const INPUT_MONITORING_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";

const PersistedSchema = Schema.Struct({
  enabled: Schema.Boolean,
  originalSlotKeycodes: Schema.NullOr(Schema.Array(Schema.String)),
  backupDir: Schema.NullOr(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

async function writeAtomic(file: string, text: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, text, "utf8");
  await NodeFSP.rename(temp, file);
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export const installCreatorMicro = Effect.fn("desktop.creatorMicro.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const root = NodePath.join(environment.stateDir, "creator-micro");
  const stateFile = NodePath.join(root, "state.json");
  const backupsDir = NodePath.join(root, "backups");

  const controller = new CreatorMicroController({
    hid: makeNodeHidBackend(environment.platform),
    loadPersisted: async () => {
      try {
        return decodePersisted(JSON.parse(await NodeFSP.readFile(stateFile, "utf8")));
      } catch {
        return DEFAULT_PERSISTED;
      }
    },
    savePersisted: (state: CreatorMicroPersisted) =>
      writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`),
    writeBackup: async (files) => {
      const createdAt = new Date().toISOString();
      const dir = NodePath.join(backupsDir, timestamp());
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(dir, "keymap.json"), files.keymap, "utf8");
      if (files.smartActions !== null) {
        await NodeFSP.writeFile(
          NodePath.join(dir, "smart_actions.json"),
          files.smartActions,
          "utf8",
        );
      }
      await NodeFSP.writeFile(
        NodePath.join(dir, "backup.json"),
        `${JSON.stringify(
          { createdAt, reason: files.reason, firmware: files.firmware, fileList: files.fileList },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { dir, createdAt };
    },
    readBackupKeymap: (dir) => NodeFSP.readFile(NodePath.join(dir, "keymap.json"), "utf8"),
    onStateChanged: (state) => {
      runFork(electronWindow.sendAll(IpcChannels.CREATOR_MICRO_STATE_CHANNEL, state));
    },
    onKeyPressed: (slot, threadKey) => {
      const press: CreatorMicroKeyPress = { slot, threadKey };
      runFork(
        desktopWindow.activate.pipe(
          Effect.ignoreCause,
          Effect.andThen(
            electronWindow.sendAll(IpcChannels.CREATOR_MICRO_KEY_PRESS_CHANNEL, press),
          ),
        ),
      );
    },
    log: (level, message, detail) => {
      const annotations = detail === undefined ? undefined : { detail: String(detail) };
      runFork(
        level === "error"
          ? logError(message, annotations)
          : level === "warn"
            ? logWarning(message, annotations)
            : logInfo(message, annotations),
      );
    },
  });

  const action = (run: () => Promise<CreatorMicroState>) => Effect.promise(run);

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: CreatorMicroState,
      handler: () => Effect.sync(() => controller.getState()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_SET_SLOTS_CHANNEL,
      payload: CreatorMicroSlots,
      result: Schema.Void,
      handler: (slots) => Effect.sync(() => controller.setSlots(slots)),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_ENABLE_CHANNEL,
      payload: Schema.Void,
      result: CreatorMicroState,
      handler: () => action(() => controller.enable()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_DISABLE_CHANNEL,
      payload: Schema.Void,
      result: CreatorMicroState,
      handler: () => action(() => controller.disable()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_RESTORE_CHANNEL,
      payload: Schema.Void,
      result: CreatorMicroState,
      handler: () => action(() => controller.restoreBackup()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CREATOR_MICRO_OPEN_PERMISSION_SETTINGS_CHANNEL,
      payload: Schema.Void,
      result: Schema.Boolean,
      handler: () =>
        Effect.promise(() =>
          environment.platform === "darwin"
            ? Electron.shell.openExternal(INPUT_MONITORING_URL).then(
                () => true,
                () => false,
              )
            : Promise.resolve(false),
        ),
    }),
  );

  // Starting reads the state file and, when enabled, opens the pad (read-only).
  runFork(
    Effect.tryPromise(() => controller.start()).pipe(
      Effect.catch((error) => logWarning("could not start", { error: String(error) })),
    ),
  );
  // Shutdown: keys go dark and the handle closes. The keymap stays bound.
  yield* Effect.addFinalizer(() => Effect.promise(() => controller.stop()));
});
