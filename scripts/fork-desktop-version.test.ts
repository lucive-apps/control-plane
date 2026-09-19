import { assert, describe, it } from "@effect/vitest";

import {
  InvalidForkDesktopVersionError,
  compareStableDesktopVersion,
  forkDesktopReleaseAssetNames,
  formatStableDesktopVersion,
  parseStableDesktopVersion,
  resolveNextForkDesktopVersion,
} from "./fork-desktop-version.ts";

describe("resolveNextForkDesktopVersion", () => {
  it("bumps the patch when the package version is already published", () => {
    assert.equal(
      resolveNextForkDesktopVersion({
        packageVersion: "0.0.43",
        publishedVersions: ["0.0.42", "0.0.43"],
      }),
      "0.0.44",
    );
  });

  it("reuses an unpublished package version so a failed ship can retry", () => {
    assert.equal(
      resolveNextForkDesktopVersion({
        packageVersion: "0.0.44",
        publishedVersions: ["0.0.43"],
      }),
      "0.0.44",
    );
  });

  it("advances past a GitHub tag that is ahead of package.json", () => {
    assert.equal(
      resolveNextForkDesktopVersion({
        packageVersion: "0.0.40",
        publishedVersions: ["0.0.43"],
      }),
      "0.0.44",
    );
  });

  it("keeps an unpublished first version when GitHub has no releases", () => {
    assert.equal(
      resolveNextForkDesktopVersion({
        packageVersion: "0.0.43",
        publishedVersions: [],
      }),
      "0.0.43",
    );
  });

  it("ignores v-prefixed tags that are behind and non-stable prerelease tags", () => {
    assert.equal(
      resolveNextForkDesktopVersion({
        packageVersion: "0.0.43",
        publishedVersions: ["v0.0.42", "0.0.43-lucive.1"],
      }),
      "0.0.43",
    );
  });

  it("rejects an unparsable package version", () => {
    try {
      resolveNextForkDesktopVersion({ packageVersion: "not-a-version" });
      assert.fail("Expected InvalidForkDesktopVersionError");
    } catch (error) {
      assert.instanceOf(error, InvalidForkDesktopVersionError);
    }
  });
});

describe("stable desktop versions", () => {
  it("parses optional v prefixes and ignores prerelease tags", () => {
    assert.deepStrictEqual(parseStableDesktopVersion("v1.2.3"), {
      major: 1,
      minor: 2,
      patch: 3,
    });
    assert.equal(parseStableDesktopVersion("1.2.3-nightly.1"), undefined);
    assert.equal(formatStableDesktopVersion({ major: 1, minor: 2, patch: 3 }), "1.2.3");
    assert.isTrue(
      compareStableDesktopVersion(
        { major: 0, minor: 0, patch: 44 },
        { major: 0, minor: 0, patch: 43 },
      ) > 0,
    );
  });

  it("names the GitHub assets electron-updater needs", () => {
    assert.deepStrictEqual(forkDesktopReleaseAssetNames("0.0.44"), [
      "Control-Plane-0.0.44-arm64.dmg",
      "Control-Plane-0.0.44-arm64.zip",
      "Control-Plane-0.0.44-arm64.zip.blockmap",
      "latest-mac.yml",
    ]);
  });
});
