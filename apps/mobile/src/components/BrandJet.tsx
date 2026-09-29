import Constants from "expo-constants";
import Svg, { Path } from "react-native-svg";

const appVariant = Constants.expoConfig?.extra?.appVariant;
// Mirrors assets/{dev,nightly,prod}/control-plane-*mark.svg so the mark matches the app icon.
const JET_COLORS =
  appVariant === "development"
    ? { accent: "#0DC3DB", body: "#55677F" }
    : appVariant === "preview"
      ? { accent: "#7565C7", body: "#2B2D5E" }
      : { accent: "#7D5027", body: "#D1A272" };

/** Full-color Control Plane jet for the current app variant. Square: width equals height. */
export function BrandJet(props: { readonly size: number }) {
  return (
    <Svg
      accessibilityLabel="Control Plane"
      width={props.size}
      height={props.size}
      viewBox="151 151 721 721"
    >
      <Path d="M509 151L430 444L592 445Z" fill={JET_COLORS.accent} />
      <Path d="M509 359L761 611V652L509 826L262 652V607Z" fill={JET_COLORS.body} />
      <Path d="M450 660L326 782L324 842L394 872L452 812V662Z" fill={JET_COLORS.accent} />
      <Path d="M566 660L564 812L624 872L694 842V786L568 660Z" fill={JET_COLORS.accent} />
    </Svg>
  );
}
