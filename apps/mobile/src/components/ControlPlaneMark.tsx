import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * Monochrome Control Plane mark, matching the web ControlPlaneMark
 * (source: assets/prod/control-plane-mark.svg). The viewBox is a tight square,
 * so width equals height. The body sits at reduced opacity so the shape reads at icon sizes.
 */
export function ControlPlaneMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const paint = { color: props.color, colorClassName: props.colorClassName, fill: "currentColor" };
  return (
    <Svg
      accessibilityLabel="Control Plane"
      height={props.height}
      width={props.height}
      viewBox="151 151 721 721"
    >
      <ThemedPath d="M509 151L430 444L592 445Z" {...paint} />
      <ThemedPath d="M509 359L761 611V652L509 826L262 652V607Z" fillOpacity={0.55} {...paint} />
      <ThemedPath d="M450 660L326 782L324 842L394 872L452 812V662Z" {...paint} />
      <ThemedPath d="M566 660L564 812L624 872L694 842V786L568 660Z" {...paint} />
    </Svg>
  );
}
