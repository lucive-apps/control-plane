#!/usr/bin/env node

// Renders the Android launcher, splash, and notification artwork from each variant's
// Control Plane jet SVG.
//
// Android masks the central 72dp of a 108dp adaptive canvas, so the iOS tiles cannot be
// used as a foreground: their square gets framed again. Each variant instead gets a
// transparent foreground with the jet inside the safe zone, over the white background
// color set in apps/mobile/app.config.ts, matching the white iOS tiles.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, the same proportion the launcher crops, so the splash is the
// foreground rendered at the full splash canvas.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// 24dp at xxxhdpi, the status bar icon size.
const NOTIFICATION_CANVAS = 96;
// The jet's bounds inside the 1024 viewBox of the mark SVGs.
const JET = { x: 262, y: 151, width: 499, height: 721 };
// Jet height as a fraction of the 108dp canvas. The iOS tiles draw the jet at 71% of the
// tile; the launcher shows 72dp of 108dp, so 0.47 matches that framing and keeps the
// jet's corners inside the 66dp guaranteed circle.
const LAUNCHER_JET_FRACTION = 0.47;
// Status bar icons are cropped by nothing, so the silhouette fills most of the canvas.
const NOTIFICATION_JET_FRACTION = 0.92;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

const VARIANT_MARKS = {
  dev: BRAND_ASSET_PATHS.developmentMarkSvg,
  nightly: BRAND_ASSET_PATHS.nightlyMarkSvg,
  prod: BRAND_ASSET_PATHS.productionMarkSvg,
} as const;

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

// Centers the jet on a transparent square canvas at the given height fraction.
const jetSvg = (paths: ReadonlyArray<string>, size: number, fraction: number) => {
  const scale = (size * fraction) / JET.height;
  const tx = (size - JET.width * scale) / 2 - JET.x * scale;
  const ty = (size - JET.height * scale) / 2 - JET.y * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none"><g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})">${paths.join("")}</g></svg>`;
};

const rasterize = (layer: string, svg: string) =>
  Effect.tryPromise({
    try: () => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readJetPaths = Effect.fn("androidIcons.readJetPaths")(function* (
  repositoryRoot: string,
  variant: keyof typeof VARIANT_MARKS,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const svg = yield* fs.readFileString(path.join(repositoryRoot, VARIANT_MARKS[variant]));
  return svg.match(/<path[^>]*\/>/g) ?? [];
});

// A flat white silhouette, for Android's monochrome themed icon and the status bar.
const silhouette = (paths: ReadonlyArray<string>) =>
  paths.map((path) => path.replace(/fill="[^"]*"/, 'fill="#FFFFFF"'));

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs: Array<readonly [string, Buffer]> = [];
  for (const variant of ["dev", "nightly", "prod"] as const) {
    const paths = yield* readJetPaths(repositoryRoot, variant);
    outputs.push(
      [
        `android-icon-foreground-${variant}.png`,
        yield* rasterize(
          `${variant}-foreground`,
          jetSvg(paths, ADAPTIVE_CANVAS, LAUNCHER_JET_FRACTION),
        ),
      ],
      [
        `android-splash-icon-${variant}.png`,
        yield* rasterize(`${variant}-splash`, jetSvg(paths, SPLASH_CANVAS, LAUNCHER_JET_FRACTION)),
      ],
    );
  }
  const productionSilhouette = silhouette(yield* readJetPaths(repositoryRoot, "prod"));
  outputs.push(
    [
      "android-icon-mark.png",
      yield* rasterize(
        "monochrome",
        jetSvg(productionSilhouette, ADAPTIVE_CANVAS, LAUNCHER_JET_FRACTION),
      ),
    ],
    [
      "android-notification-icon.png",
      yield* rasterize(
        "notification",
        jetSvg(productionSilhouette, NOTIFICATION_CANVAS, NOTIFICATION_JET_FRACTION),
      ),
    ],
  );
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
