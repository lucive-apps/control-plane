import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { decodeLucideIconNodes, lookupLucideIconNodes, lucideNodeToSvgProps } from "./lucideIcon";
import { projectIconColorHex } from "./projectIcon";

describe("generated Lucide data", () => {
  it("matches the lucide-react web draws with (rerun scripts/generate-lucide-icons.mjs)", () => {
    const webLucide = NodePath.resolve(
      import.meta.dirname,
      "../../../web/node_modules/lucide-react/package.json",
    );
    const generated = NodePath.resolve(import.meta.dirname, "lucideIconNodes.generated.json");
    const readVersion = (path: string, field: string) =>
      (JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>)[field];
    expect(readVersion(generated, "lucideVersion")).toBe(readVersion(webLucide, "version"));
  });

  it("resolves canonical names and aliases, and rejects unknown ones", () => {
    expect(lookupLucideIconNodes("folder-code")?.length).toBe(3);
    expect(lookupLucideIconNodes("alarm-check")).toEqual(
      lookupLucideIconNodes("alarm-clock-check"),
    );
    expect(lookupLucideIconNodes("not-a-lucide-icon")).toBeNull();
    expect(lookupLucideIconNodes("__proto__")).toBeNull();
  });
});

describe("decodeLucideIconNodes", () => {
  it("reads bare paths and tagged elements", () => {
    expect(decodeLucideIconNodes("M3 3h18|circle;cx=12;cy=12;r=10;fill=currentColor")).toEqual([
      ["path", { d: "M3 3h18" }],
      ["circle", { cx: "12", cy: "12", r: "10", fill: "currentColor" }],
    ]);
  });

  it("drops elements it cannot draw", () => {
    expect(decodeLucideIconNodes("script;src=x|M1 1")).toEqual([["path", { d: "M1 1" }]]);
  });
});

describe("lucideNodeToSvgProps", () => {
  const sky = projectIconColorHex("sky");

  it("maps each element to camelCase props", () => {
    expect(
      lucideNodeToSvgProps(["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], sky),
    ).toEqual({
      element: "rect",
      props: { width: "18", height: "18", x: "3", y: "3", rx: "2" },
    });
    expect(lucideNodeToSvgProps(["line", { x1: "2", x2: "22", y1: "2", y2: "22" }], sky)).toEqual({
      element: "line",
      props: { x1: "2", x2: "22", y1: "2", y2: "22" },
    });
    expect(
      lucideNodeToSvgProps(["path", { d: "M1 1", "stroke-width": "1.5", key: "abc" }], sky),
    ).toEqual({ element: "path", props: { d: "M1 1", strokeWidth: "1.5" } });
  });

  it("tints currentColor with the icon color", () => {
    expect(
      lucideNodeToSvgProps(["circle", { cx: "12", cy: "12", r: "1", fill: "currentColor" }], sky),
    ).toEqual({ element: "circle", props: { cx: "12", cy: "12", r: "1", fill: "#0ea5e9" } });
  });

  it("returns null for an element react-native-svg is not given", () => {
    expect(lucideNodeToSvgProps(["text" as "path", { x: "0" }], sky)).toBeNull();
  });
});
