import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import handler from "../api/download.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(name, value);
    },
    end() {},
  };
}

test("redirects a download request to the latest arm64 DMG", async () => {
  const dmg =
    "https://github.com/lucive-apps/control-plane/releases/download/0.0.54/Control-Plane-0.0.54-arm64.dmg";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      assets: [
        { name: "Control-Plane-0.0.54-arm64.zip", browser_download_url: "https://example.com/zip" },
        { name: "Control-Plane-0.0.54-arm64.dmg", browser_download_url: dmg },
      ],
    }),
  });

  const res = response();
  await handler({ method: "GET" }, res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.get("Location"), dmg);
  assert.match(res.headers.get("Cache-Control"), /s-maxage=300/);
});

test("falls back to releases without caching an API failure", async () => {
  globalThis.fetch = async () => {
    throw new Error("GitHub unavailable");
  };

  const res = response();
  await handler({ method: "GET" }, res);

  assert.equal(
    res.headers.get("Location"),
    "https://github.com/lucive-apps/control-plane/releases/latest",
  );
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("rejects non-download methods", async () => {
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };

  const res = response();
  await handler({ method: "POST" }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.get("Allow"), "GET, HEAD");
});
