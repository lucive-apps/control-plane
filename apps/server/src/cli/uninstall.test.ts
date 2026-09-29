import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ScheduleHostBackend, scheduleEntryLabel } from "../schedules/ScheduleHost.ts";
import { findOwnedLauncher, findScheduleEntry } from "./uninstall.ts";

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});

it.layer(NodeServices.layer)("t3 uninstall schedule entry", (it) => {
  it.effect("claims only this home's installed schedule entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const environmentIdPath = path.join(stateDir, "environment-id");
      const installed = new Set<string>();
      const probed: Array<string> = [];
      const find = findScheduleEntry(environmentIdPath).pipe(
        Effect.provideService(
          ScheduleHostBackend,
          ScheduleHostBackend.of({
            scheduler: "launchd",
            mode: "os",
            apply: () => Effect.die("uninstall never installs"),
            probe: (label) =>
              Effect.sync(() => {
                probed.push(label);
                return installed.has(label)
                  ? { state: "installed", path: `/agents/${label}.plist`, problems: [] }
                  : { state: "not-needed", problems: [] };
              }),
            remove: () => Effect.die("planning never removes"),
          }),
        ),
      );

      // A home that never started a server has no id, so no label to look for.
      assert.isUndefined(yield* find);
      assert.deepStrictEqual(probed, []);

      yield* fs.writeFileString(environmentIdPath, "environment-1\n");
      const label = scheduleEntryLabel(undefined, "environment-1");
      assert.isUndefined(yield* find);
      installed.add(label);
      assert.deepStrictEqual(yield* find, { label, path: `/agents/${label}.plist` });
      assert.deepStrictEqual(probed, [label, label]);
    }).pipe(Effect.scoped),
  );
});
