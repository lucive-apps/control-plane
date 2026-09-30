// Lucide glyph data for project icons, without bundling the Lucide package. The node data is
// generated from the web app's lucide-react by scripts/generate-lucide-icons.mjs and loaded on
// first use, so only screens that draw a Lucide project icon ever pay to parse it.

export type LucideSvgElement =
  | "path"
  | "circle"
  | "rect"
  | "line"
  | "polyline"
  | "polygon"
  | "ellipse";

/** One Lucide SVG child: its tag and attributes, as Lucide's `__iconNode` lists them. */
export type LucideIconNode = readonly [
  tag: LucideSvgElement,
  attributes: Readonly<Record<string, string>>,
];

interface LucideIconData {
  readonly icons: Readonly<Record<string, string>>;
  readonly aliases: Readonly<Record<string, string>>;
}

const LUCIDE_SVG_ELEMENTS: ReadonlySet<string> = new Set<LucideSvgElement>([
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
]);

let lucideIconData: LucideIconData | undefined;
const decodedIcons = new Map<string, ReadonlyArray<LucideIconNode> | null>();

function loadLucideIconData(): LucideIconData {
  lucideIconData ??= require("./lucideIconNodes.generated.json") as LucideIconData;
  return lucideIconData;
}

function ownValue(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Decodes the generator's compact form: a bare node is a path's `d`, else "tag;attr=value;...". */
export function decodeLucideIconNodes(encoded: string): ReadonlyArray<LucideIconNode> {
  return encoded.split("|").flatMap((part): LucideIconNode[] => {
    if (!part.includes(";")) return [["path", { d: part }]];
    const [tag = "", ...pairs] = part.split(";");
    if (!LUCIDE_SVG_ELEMENTS.has(tag)) return [];
    const attributes: Record<string, string> = {};
    for (const pair of pairs) {
      const separator = pair.indexOf("=");
      if (separator > 0) attributes[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    return [[tag as LucideSvgElement, attributes]];
  });
}

/** The SVG nodes for a Lucide icon name (aliases included), or null for a name mobile lacks. */
export function lookupLucideIconNodes(name: string): ReadonlyArray<LucideIconNode> | null {
  const cached = decodedIcons.get(name);
  if (cached !== undefined) return cached;
  const data = loadLucideIconData();
  const canonical = ownValue(data.aliases, name) ?? name;
  const encoded = ownValue(data.icons, canonical);
  const nodes = encoded === undefined ? null : decodeLucideIconNodes(encoded);
  const resolved = nodes !== null && nodes.length > 0 ? nodes : null;
  decodedIcons.set(name, resolved);
  return resolved;
}

function camelCaseAttribute(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Maps one Lucide node to the react-native-svg element and props that draw it: attribute names
 * in camelCase, and `currentColor` replaced by the icon's tint, since stroke and fill come from
 * the parent group rather than CSS.
 */
export function lucideNodeToSvgProps(
  node: LucideIconNode,
  color: string,
): {
  readonly element: LucideSvgElement;
  readonly props: Readonly<Record<string, string>>;
} | null {
  const [element, attributes] = node;
  if (!LUCIDE_SVG_ELEMENTS.has(element)) return null;
  const props: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "key") continue;
    props[camelCaseAttribute(name)] = value === "currentColor" ? color : value;
  }
  return { element, props };
}
