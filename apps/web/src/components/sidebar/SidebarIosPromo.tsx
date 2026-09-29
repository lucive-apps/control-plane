import { ExternalLinkIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { readLocalApi } from "../../localApi";
import { useUiStateStore } from "../../uiStateStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// TODO(ios-promo): placeholder. Swap in the real TestFlight public link before
// merging.
export const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/REPLACE_ME";

export const SidebarIosPromo = memo(function SidebarIosPromo() {
  const dismissed = useUiStateStore((state) => state.iosPromoDismissed);
  const dismiss = useUiStateStore((state) => state.dismissIosPromo);

  const openTestFlight = useCallback(() => {
    void readLocalApi()?.shell.openExternal(IOS_TESTFLIGHT_URL);
  }, []);

  if (dismissed) return null;

  return (
    <div className="group/ios-promo relative flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-control-surface px-2.5 py-2">
      <SmartphoneIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
      <div className="min-w-0 flex-1 pr-4">
        <div className="truncate text-xs leading-4 font-medium text-sidebar-foreground">
          Control Plane for iPhone
        </div>
        <a
          href={IOS_TESTFLIGHT_URL}
          onClick={(event) => {
            event.preventDefault();
            openTestFlight();
          }}
          className="inline-flex items-center gap-1 rounded-sm text-[11px] leading-4 text-sidebar-muted-foreground underline decoration-dotted underline-offset-2 outline-none transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Join the TestFlight beta
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
        </a>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismiss}
              className="absolute top-1 right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="top">Dismiss</TooltipPopup>
      </Tooltip>
    </div>
  );
});
