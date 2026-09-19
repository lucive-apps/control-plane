import * as Schema from "effect/Schema";

import { FORK_GITHUB_REPOSITORY } from "./lib/fork-identity.ts";

export const FORK_DESKTOP_UPDATE_REPOSITORY = FORK_GITHUB_REPOSITORY;

export class InvalidForkDesktopVersionError extends Schema.TaggedError<InvalidForkDesktopVersionError>()(
  "InvalidForkDesktopVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid fork desktop version '${this.version}'.`;
  }
}

export interface StableDesktopVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseStableDesktopVersion(version: string): StableDesktopVersion | undefined {
  const core = version.trim().replace(/^v/i, "");
  const match = STABLE_VERSION_PATTERN.exec(core);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatStableDesktopVersion(version: StableDesktopVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareStableDesktopVersion(
  left: StableDesktopVersion,
  right: StableDesktopVersion,
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function forkDesktopReleaseAssetNames(version: string): readonly string[] {
  return [
    `Control-Plane-${version}-arm64.dmg`,
    `Control-Plane-${version}-arm64.zip`,
    `Control-Plane-${version}-arm64.zip.blockmap`,
    "latest-mac.yml",
  ];
}

export function resolveNextForkDesktopVersion(input: {
  readonly packageVersion: string;
  readonly publishedVersions?: readonly string[];
}): string {
  const packageVersion = parseStableDesktopVersion(input.packageVersion);
  if (!packageVersion) {
    throw new InvalidForkDesktopVersionError({ version: input.packageVersion });
  }

  const publishedVersions = (input.publishedVersions ?? [])
    .map(parseStableDesktopVersion)
    .filter((version): version is StableDesktopVersion => version !== undefined);
  const publishedKeys = new Set(publishedVersions.map(formatStableDesktopVersion));
  const highestPublished = publishedVersions.reduce<StableDesktopVersion | undefined>(
    (highest, version) =>
      highest === undefined || compareStableDesktopVersion(version, highest) > 0
        ? version
        : highest,
    undefined,
  );
  const candidate =
    highestPublished !== undefined &&
    compareStableDesktopVersion(packageVersion, highestPublished) < 0
      ? highestPublished
      : packageVersion;
  const candidateKey = formatStableDesktopVersion(candidate);
  if (publishedKeys.has(candidateKey)) {
    return formatStableDesktopVersion({ ...candidate, patch: candidate.patch + 1 });
  }
  return candidateKey;
}
