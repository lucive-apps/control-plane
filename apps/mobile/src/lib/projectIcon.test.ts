import { describe, expect, it } from "vite-plus/test";

import { lookupLucideIconNodes } from "./lucideIcon";
import { resolveProjectIconGlyph } from "./projectIcon";

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("resolveProjectIconGlyph", () => {
  it("returns null without an assigned icon", () => {
    expect(resolveProjectIconGlyph(null, "Control Plane")).toBeNull();
    expect(resolveProjectIconGlyph(undefined, "Control Plane")).toBeNull();
  });

  it("draws a known Lucide name as its glyph nodes in the icon color", () => {
    const glyph = resolveProjectIconGlyph(
      { kind: "lucide", name: "folder-code", color: "sky" },
      "Control Plane",
    );
    expect(glyph).toMatchObject({ kind: "lucide", name: "folder-code", color: "sky" });
    expect(glyph?.kind === "lucide" ? glyph.nodes : null).toEqual([
      ["path", { d: "M10 10.5 8 13l2 2.5" }],
      ["path", { d: "m14 10.5 2 2.5-2 2.5" }],
      [
        "path",
        {
          d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
        },
      ],
    ]);
  });

  it("resolves a Lucide alias to its canonical icon's nodes", () => {
    const alias = resolveProjectIconGlyph(
      { kind: "lucide", name: "alarm-check", color: "red" },
      "Alarms",
    );
    expect(alias).toMatchObject({ kind: "lucide", name: "alarm-check", color: "red" });
    expect(alias?.kind === "lucide" ? alias.nodes : null).toEqual(
      lookupLucideIconNodes("alarm-clock-check"),
    );
  });

  it("falls back to the title monogram in the icon color for an unknown Lucide name", () => {
    expect(
      resolveProjectIconGlyph(
        { kind: "lucide", name: "not-a-lucide-icon", color: "violet" },
        "Control Plane",
      ),
    ).toEqual({ kind: "monogram", text: "CP", color: "violet" });
    expect(
      resolveProjectIconGlyph({ kind: "lucide", name: "constructor", color: "gray" }, "api"),
    ).toEqual({ kind: "monogram", text: "AI", color: "gray" });
  });

  it("passes emoji, monogram, and image icons through", () => {
    expect(resolveProjectIconGlyph({ kind: "emoji", emoji: "🚀" }, "Rocket")).toEqual({
      kind: "emoji",
      emoji: "🚀",
    });
    expect(
      resolveProjectIconGlyph({ kind: "monogram", text: "HT", color: "emerald" }, "Hometrace"),
    ).toEqual({ kind: "monogram", text: "HT", color: "emerald" });
    expect(resolveProjectIconGlyph({ kind: "image", dataUrl: IMAGE_DATA_URL }, "Photos")).toEqual({
      kind: "image",
      dataUrl: IMAGE_DATA_URL,
    });
  });
});
