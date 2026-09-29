#!/usr/bin/env node

// Derives every tracked desktop and web icon from each variant's 1024px master PNG.
//
// The masters (`*-ios-1024.png`) are the Control Plane jet tiles. Everything else is a
// resize of the master, except the macOS tile: its rounded body and shadow are kept from
// the tracked macOS PNG, and only the body is repainted with the master scaled into the
// classic 824px safe area.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const MASTER_SIZE = 1024;
// The macOS pre-Tahoe icon body is 824x824, inset 100px, with the shadow outside it.
const MACOS_BODY_SIZE = 824;
const MACOS_BODY_INSET = (MASTER_SIZE - MACOS_BODY_SIZE) / 2;

interface IconVariant {
  readonly label: string;
  readonly master: string;
  readonly outputs: {
    readonly universal: string;
    readonly macos: string;
    readonly appleTouch: string;
    readonly favicon16: string;
    readonly favicon32: string;
    readonly faviconIco: string;
    readonly windowsIco: string;
  };
}

export class IconExportError extends Schema.TaggedError<IconExportError>()("IconExportError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Icon export failed for ${this.path}.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}\nRun \`vp run icons:export\`.`;
  }
}

const ICON_VARIANTS = [
  {
    label: "development",
    master: BRAND_ASSET_PATHS.developmentIosIconPng,
    outputs: {
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "preview",
    master: BRAND_ASSET_PATHS.nightlyIosIconPng,
    outputs: {
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    master: BRAND_ASSET_PATHS.productionIosIconPng,
    outputs: {
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

const image = (path: string, run: () => Promise<Buffer>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new IconExportError({ path, cause }) });

const resize = (path: string, master: Buffer, size: number) =>
  image(path, () =>
    sharp(master)
      .resize(size, size, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (relativePath: string) =>
    fs.readFile(path.join(repositoryRoot, relativePath)).pipe(
      Effect.map(Buffer.from),
      Effect.mapError((cause) => new IconExportError({ path: relativePath, cause })),
    );

  const master = yield* read(variant.master);
  const { outputs } = variant;
  const icoRenditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    resize(outputs.windowsIco, master, size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportError({ path: outputs.windowsIco, cause }),
  });
  const macosTile = yield* read(outputs.macos);
  const macosBody = yield* resize(outputs.macos, master, MACOS_BODY_SIZE);
  const macos = yield* image(outputs.macos, () =>
    sharp(macosTile)
      .composite([
        { input: macosBody, left: MACOS_BODY_INSET, top: MACOS_BODY_INSET, blend: "atop" },
      ])
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );

  return new Map<string, Buffer>([
    [outputs.universal, master],
    [outputs.macos, macos],
    [outputs.appleTouch, yield* resize(outputs.appleTouch, master, 180)],
    [outputs.favicon16, yield* resize(outputs.favicon16, master, 16)],
    [outputs.favicon32, yield* resize(outputs.favicon32, master, 32)],
    [outputs.faviconIco, ico],
    [outputs.windowsIco, ico],
  ]);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");

  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    for (const [relativePath, contents] of yield* renderVariant(repositoryRoot, variant)) {
      generated.set(relativePath, contents);
    }
  }
  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const contents = generated.get(override.sourceRelativePath);
    if (contents === undefined) {
      return yield* Effect.die(
        new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, contents);
  }

  const stale: Array<string> = [];
  for (const [relativePath, contents] of generated) {
    const current = yield* fs
      .readFile(path.join(repositoryRoot, relativePath))
      .pipe(Effect.orElseSucceed(() => new Uint8Array()));
    if (!Buffer.from(current).equals(contents)) stale.push(relativePath);
  }

  if (checkOnly) {
    if (stale.length > 0) return yield* new IconExportAssetsStaleError({ paths: stale });
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    return;
  }

  for (const relativePath of stale) {
    yield* fs
      .writeFile(path.join(repositoryRoot, relativePath), generated.get(relativePath)!)
      .pipe(Effect.mapError((cause) => new IconExportError({ path: relativePath, cause })));
    yield* Console.log(`wrote ${relativePath}`);
  }
  yield* Console.log(`${stale.length} of ${generated.size} generated icon assets updated.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check),
).pipe(
  Command.withDescription(
    "Export development, preview, and production icons from their 1024px master PNGs.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
