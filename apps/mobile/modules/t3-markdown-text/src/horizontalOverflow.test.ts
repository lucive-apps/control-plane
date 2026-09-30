import { expect, it } from "vite-plus/test";

import { horizontalOverflowEdges, horizontalOverflowFadeGradient } from "./horizontalOverflow";

it("leaves a table that fits its viewport static", () => {
  expect(horizontalOverflowEdges({ viewportWidth: 363, contentWidth: 322, offsetX: 0 })).toEqual({
    overflows: false,
    leading: false,
    trailing: false,
  });
  // Rounding in the measured widths is not scrollable content.
  expect(
    horizontalOverflowEdges({ viewportWidth: 363, contentWidth: 363.5, offsetX: 0 }).overflows,
  ).toBe(false);
});

it("marks the hidden edges of a wide table as it scrolls", () => {
  const wide = { viewportWidth: 363, contentWidth: 802 };
  expect(horizontalOverflowEdges({ ...wide, offsetX: 0 })).toEqual({
    overflows: true,
    leading: false,
    trailing: true,
  });
  expect(horizontalOverflowEdges({ ...wide, offsetX: 200 })).toEqual({
    overflows: true,
    leading: true,
    trailing: true,
  });
  expect(horizontalOverflowEdges({ ...wide, offsetX: 439 })).toEqual({
    overflows: true,
    leading: true,
    trailing: false,
  });
});

it("does not treat an unmeasured viewport as overflowing", () => {
  expect(
    horizontalOverflowEdges({ viewportWidth: 0, contentWidth: 802, offsetX: 0 }).overflows,
  ).toBe(false);
});

it("fades toward the hidden edge only for opaque hex surfaces", () => {
  expect(horizontalOverflowFadeGradient("#f2f2f7", "trailing")).toBe(
    "linear-gradient(to right, #f2f2f700 0%, #f2f2f7 100%)",
  );
  expect(horizontalOverflowFadeGradient("#0A0A0A", "leading")).toBe(
    "linear-gradient(to left, #0A0A0A00 0%, #0A0A0A 100%)",
  );
  expect(horizontalOverflowFadeGradient("rgba(0, 0, 0, 0.04)", "trailing")).toBeUndefined();
  expect(horizontalOverflowFadeGradient(undefined, "trailing")).toBeUndefined();
});
