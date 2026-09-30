import { File, Paths } from "expo-file-system";

/**
 * Remembers that demo mode is on, so a reviewer who relaunches the app lands
 * back in the demo until they tap Exit demo. The flag is a file in the app's
 * documents folder rather than the keychain, so reinstalling the app starts
 * outside the demo. Reads are synchronous so launch restores the demo before
 * the first frame.
 */

function flagFile(): InstanceType<typeof File> {
  return new File(Paths.document, "demo-mode-active");
}

export function readDemoModeFlag(): boolean {
  try {
    return flagFile().exists;
  } catch {
    return false;
  }
}

export function writeDemoModeFlag(active: boolean): void {
  try {
    const file = flagFile();
    if (active) {
      file.write("1");
    } else if (file.exists) {
      file.delete();
    }
  } catch {
    // Device-local convenience. A failed write only affects the next launch.
  }
}
