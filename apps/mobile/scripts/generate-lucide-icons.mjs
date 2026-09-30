#!/usr/bin/env node

// Regenerates src/lib/lucideIconNodes.generated.json from the web app's lucide-react, so mobile
// draws every Lucide glyph the web icon picker can save without bundling the Lucide package.
//
//   node apps/mobile/scripts/generate-lucide-icons.mjs
//
// Output shape (kept to string values so the formatter never reflows it):
//   icons:   canonical name -> nodes joined by "|". A bare node is a path's `d`; any other
//            node is "tag;attr=value;attr=value". Lucide's React `key` attrs are dropped.
//   aliases: alias name -> canonical name, for names `lucide-react/dynamic` maps to the same file.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const MOBILE_ROOT = NodePath.resolve(import.meta.dirname, "..");
const LUCIDE_ROOT = NodePath.resolve(MOBILE_ROOT, "../web/node_modules/lucide-react");
const LUCIDE_ESM = NodePath.join(LUCIDE_ROOT, "dist/esm");
const OUTPUT_PATH = NodePath.join(MOBILE_ROOT, "src/lib/lucideIconNodes.generated.json");

const SUPPORTED_TAGS = new Set([
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
]);
const RESERVED = /[|;=]/;

function importLucideModule(relativePath) {
  return import(NodeURL.pathToFileURL(NodePath.join(LUCIDE_ESM, relativePath)).href);
}

/** Every name `lucide-react/dynamic` accepts, aliases included, with the icon file it loads. */
async function readDynamicIconFiles() {
  const { default: dynamicIconImports } = await importLucideModule("dynamicIconImports.js");
  const fileByName = new Map();
  for (const [name, load] of Object.entries(dynamicIconImports)) {
    const match = /import\(\s*["']\.\/icons\/([^"']+)\.js["']\s*\)/.exec(String(load));
    if (!match) throw new Error(`Cannot find the icon file for Lucide name "${name}"`);
    fileByName.set(name, match[1]);
  }
  return fileByName;
}

function encodeNode([tag, attrs], iconName) {
  if (!SUPPORTED_TAGS.has(tag)) {
    throw new Error(`Lucide icon "${iconName}" uses unsupported element <${tag}>`);
  }
  const entries = Object.entries(attrs).filter(([name]) => name !== "key");
  for (const [name, value] of entries) {
    if (RESERVED.test(name) || RESERVED.test(String(value))) {
      throw new Error(`Lucide icon "${iconName}" has a reserved character in ${tag}.${name}`);
    }
  }
  if (tag === "path" && entries.length === 1 && entries[0][0] === "d") {
    return String(entries[0][1]);
  }
  return [tag, ...entries.map(([name, value]) => `${name}=${value}`)].join(";");
}

async function main() {
  const { version } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(LUCIDE_ROOT, "package.json"), "utf8"),
  );
  const fileByName = await readDynamicIconFiles();

  // One canonical name per icon file: the name matching the file, else the first seen.
  const namesByFile = new Map();
  for (const [name, file] of fileByName) {
    const names = namesByFile.get(file) ?? [];
    names.push(name);
    namesByFile.set(file, names);
  }

  const icons = {};
  const aliases = {};
  for (const [file, names] of namesByFile) {
    const canonical = names.includes(file) ? file : names[0];
    const { __iconNode } = await importLucideModule(`icons/${file}.js`);
    if (!Array.isArray(__iconNode) || __iconNode.length === 0) {
      throw new Error(`Lucide icon file "${file}" exports no __iconNode`);
    }
    icons[canonical] = __iconNode.map((node) => encodeNode(node, canonical)).join("|");
    for (const name of names) {
      if (name !== canonical) aliases[name] = canonical;
    }
  }

  const sortKeys = (record) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const output = `${JSON.stringify(
    { lucideVersion: version, icons: sortKeys(icons), aliases: sortKeys(aliases) },
    null,
    2,
  )}\n`;
  NodeFS.writeFileSync(OUTPUT_PATH, output);

  const iconCount = Object.keys(icons).length;
  const aliasCount = Object.keys(aliases).length;
  console.log(
    `Wrote ${NodePath.relative(process.cwd(), OUTPUT_PATH)}: lucide-react ${version}, ` +
      `${iconCount} icons + ${aliasCount} aliases (${fileByName.size} names), ` +
      `${(Buffer.byteLength(output) / 1024).toFixed(1)} KiB`,
  );
}

await main();
