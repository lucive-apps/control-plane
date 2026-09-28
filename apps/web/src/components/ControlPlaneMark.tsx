import type { SVGProps } from "react";

/**
 * Monochrome Control Plane mark (source: assets/prod/control-plane-mark.svg).
 * Paints with currentColor; the body sits at reduced opacity so the shape reads at icon sizes.
 * The viewBox is a tight square centered on the mark.
 */
export function ControlPlaneMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="151 151 721 721" xmlns="http://www.w3.org/2000/svg">
      <path d="M509 151L430 444L592 445Z" fill="currentColor" />
      <path d="M509 359L761 611V652L509 826L262 652V607Z" fill="currentColor" fillOpacity={0.55} />
      <path d="M450 660L326 782L324 842L394 872L452 812V662Z" fill="currentColor" />
      <path d="M566 660L564 812L624 872L694 842V786L568 660Z" fill="currentColor" />
    </svg>
  );
}
