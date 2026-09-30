import type { ProjectIconColor } from "@t3tools/contracts";
import { memo, type ComponentType } from "react";
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Polyline, Rect } from "react-native-svg";

import {
  lucideNodeToSvgProps,
  type LucideIconNode,
  type LucideSvgElement,
} from "../lib/lucideIcon";
import { projectIconColorHex } from "../lib/projectIcon";

type LucideSvgComponent = ComponentType<Readonly<Record<string, string>>>;

const SVG_ELEMENTS = {
  path: Path,
  circle: Circle,
  rect: Rect,
  line: Line,
  polyline: Polyline,
  polygon: Polygon,
  ellipse: Ellipse,
} as unknown as Record<LucideSvgElement, LucideSvgComponent>;

/** A Lucide glyph drawn like lucide-react's defaults: 24 grid, 2px round stroke, no fill. */
export const LucideProjectIcon = memo(function LucideProjectIcon(props: {
  readonly nodes: ReadonlyArray<LucideIconNode>;
  readonly color: ProjectIconColor;
  readonly size: number;
}) {
  const color = projectIconColorHex(props.color);
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
    >
      <G fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {props.nodes.map((node) => {
          const mapped = lucideNodeToSvgProps(node, color);
          if (mapped === null) return null;
          // No Lucide icon repeats a node, so its element and attributes are a unique key.
          const Element = SVG_ELEMENTS[mapped.element];
          const key = `${mapped.element}:${Object.values(mapped.props).join(",")}`;
          return <Element key={key} {...mapped.props} />;
        })}
      </G>
    </Svg>
  );
});
