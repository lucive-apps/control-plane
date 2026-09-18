"use client";

import { EllipsisIcon } from "lucide-react";
import { createContext, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export const HeaderOverflowMenuContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

export function HeaderOverflowMenuItems({ children }: { children: ReactNode }) {
  return children;
}

export function ChatHeaderOverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <HeaderOverflowMenuContext value={{ open, setOpen }}>
      <Menu modal={false} open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button variant="ghost" size="icon-xs" type="button" aria-label="More actions" />
                }
              />
            }
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipPopup>More</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" keepMounted sideOffset={6} className="min-w-44">
          {children}
        </MenuPopup>
      </Menu>
    </HeaderOverflowMenuContext>
  );
}
