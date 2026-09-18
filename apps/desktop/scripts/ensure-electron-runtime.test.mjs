import { assert, describe, it } from "vite-plus/test";

import {
  detectAppleSilicon,
  isUsableDesktopElectronBinary,
  resolveDesktopElectronArch,
} from "./ensure-electron-runtime.mjs";

describe("desktop Electron architecture", () => {
  it("uses arm64 on Apple Silicon even when Node is translated x64", () => {
    assert.equal(
      resolveDesktopElectronArch({
        platform: "darwin",
        nodeArch: "x64",
        appleSilicon: true,
      }),
      "arm64",
    );
  });

  it("keeps Node's arch on Intel macOS and other platforms", () => {
    assert.equal(
      resolveDesktopElectronArch({
        platform: "darwin",
        nodeArch: "x64",
        appleSilicon: false,
      }),
      "x64",
    );
    assert.equal(
      resolveDesktopElectronArch({
        platform: "linux",
        nodeArch: "x64",
        appleSilicon: false,
      }),
      "x64",
    );
  });

  it("rejects a Rosetta Electron binary on Apple Silicon", () => {
    assert.isFalse(isUsableDesktopElectronBinary("Mach-O 64-bit executable x86_64", "arm64"));
    assert.isTrue(isUsableDesktopElectronBinary("Mach-O 64-bit executable arm64", "arm64"));
    assert.isTrue(
      isUsableDesktopElectronBinary(
        "Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]",
        "arm64",
      ),
    );
  });

  it("treats sysctl hw.optional.arm64=1 as Apple Silicon", () => {
    assert.isTrue(
      detectAppleSilicon({
        platform: "darwin",
        sysctl: () => ({ status: 0, stdout: "1\n" }),
      }),
    );
    assert.isFalse(
      detectAppleSilicon({
        platform: "darwin",
        sysctl: () => ({ status: 0, stdout: "0\n" }),
      }),
    );
    assert.isFalse(
      detectAppleSilicon({
        platform: "linux",
        sysctl: () => ({ status: 0, stdout: "1\n" }),
      }),
    );
  });
});
