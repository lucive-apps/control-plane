import { PROJECT_IMAGE_ICON_MAX_DATA_URL_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  centerSquareCrop,
  fitProjectIconDataUrl,
  PROJECT_ICON_IMAGE_MAX_SOURCE_BYTES,
  validateProjectIconImageFile,
} from "./projectIconImage";

describe("validateProjectIconImageFile", () => {
  it("accepts png, jpg, webp, and svg", () => {
    for (const [name, type] of [
      ["a.png", "image/png"],
      ["a.jpg", "image/jpeg"],
      ["a.webp", "image/webp"],
      ["a.svg", "image/svg+xml"],
    ] as const) {
      expect(validateProjectIconImageFile({ name, type, size: 1024 })).toBeNull();
    }
  });

  it("falls back to the extension when the browser reports no type", () => {
    expect(validateProjectIconImageFile({ name: "Logo.SVG", type: "", size: 10 })).toBeNull();
  });

  it("rejects other formats and oversized files", () => {
    expect(validateProjectIconImageFile({ name: "a.gif", type: "image/gif", size: 10 })).toMatch(
      /PNG, JPG, WebP, or SVG/,
    );
    expect(validateProjectIconImageFile({ name: "a.txt", type: "", size: 10 })).not.toBeNull();
    expect(
      validateProjectIconImageFile({
        name: "a.png",
        type: "image/png",
        size: PROJECT_ICON_IMAGE_MAX_SOURCE_BYTES + 1,
      }),
    ).toMatch(/5 MB/);
  });
});

describe("centerSquareCrop", () => {
  it("crops the long side around the center", () => {
    expect(centerSquareCrop(300, 100)).toEqual({ sx: 100, sy: 0, side: 100 });
    expect(centerSquareCrop(100, 300)).toEqual({ sx: 0, sy: 100, side: 100 });
    expect(centerSquareCrop(64, 64)).toEqual({ sx: 0, sy: 0, side: 64 });
  });
});

describe("fitProjectIconDataUrl", () => {
  const oversized = "x".repeat(PROJECT_IMAGE_ICON_MAX_DATA_URL_LENGTH + 1);

  it("keeps the largest size that fits", () => {
    const sizes: number[] = [];
    const result = fitProjectIconDataUrl((size) => {
      sizes.push(size);
      return size > 96 ? oversized : `ok-${size}`;
    });
    expect(result).toBe("ok-96");
    expect(sizes).toEqual([128, 96]);
  });

  it("gives up when even the smallest size is too large", () => {
    expect(fitProjectIconDataUrl(() => oversized)).toBeNull();
  });
});
