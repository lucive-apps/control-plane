# Brand icons

Every app icon is the Control Plane jet. Each variant has a vector mark and a 1024px master tile (the jet on white), which are the sources of truth:

- `dev/control-plane-dev-mark.svg`, `dev/blueprint-ios-1024.png`
- `nightly/control-plane-nightly-mark.svg`, `nightly/nightly-ios-1024.png`
- `prod/control-plane-mark.svg`, `prod/black-ios-1024.png`

The `prod/t3-black-*` files already hold the jet; only their names are inherited.

Run `vp run icons:export` from the repository root to regenerate the tracked Linux, macOS, Windows, and web assets from the masters. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their masters without changing files.

The macOS PNGs keep their classic pre-Tahoe tile: the rounded 824×824 body inset 100px with its shadow comes from the tracked file, and the exporter only repaints the body with the master. To start a new variant, copy an existing macOS PNG and export.

Do not edit the generated PNG or ICO files directly. Change a master and export.

## Android launcher and mobile splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the square master tiles cannot be used directly. The
Android artwork is instead rendered from the variant mark SVGs by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground-*.png`: the transparent jet, sized to stay inside
  the safe zone over the white adaptive background color.
- `apps/mobile/assets/android-splash-icon-*.png`: the same foreground at the full splash canvas,
  so the splash mask frames the jet like the launcher does.
- `apps/mobile/assets/ios-splash-icon-*.png`: the transparent jet for the iOS splash screen,
  which draws its image unmasked over the light or dark splash background. Never point the iOS
  splash at the square app icon tiles: they show as a white box in dark mode.
- `apps/mobile/assets/android-icon-mark.png` and `android-notification-icon.png`: flat white
  silhouettes for Android's monochrome themed icon and the status bar.

Rerun the export after changing a mark SVG.
