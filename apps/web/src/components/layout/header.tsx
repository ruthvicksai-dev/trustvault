import React, { useState } from "react";
import { UserNav } from "./user-nav";
import { Sidebar } from "./sidebar";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { RiMenuLine, RiShieldKeyholeLine } from "@remixicon/react";

interface HeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function Header({ title, description, actions }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-4 md:px-8 border-b border-border/80 bg-background/80 backdrop-blur-md">
      {/* Left side: Mobile trigger and page title */}
      <div className="flex items-center gap-3">
        <div className="md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-xl" />}>
              <RiMenuLine className="size-5" />
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72">
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>

        <div className="flex flex-col min-w-0">
          <h1 className="text-sm sm:text-base md:text-lg font-bold font-heading text-foreground tracking-tight truncate flex items-center gap-2">
            {title}
          </h1>
          {description && (
            <p className="hidden sm:block text-xs text-muted-foreground truncate">{description}</p>
          )}
        </div>
      </div>

      {/* Right side: Actions, ThemeSwitcher & UserNav */}
      <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
        {actions && <div className="flex items-center gap-1.5 sm:gap-2">{actions}</div>}
        <div className="h-4 w-px bg-border/60 mx-0.5 hidden sm:block" />
        <div className="hidden sm:block">
          <ThemeSwitcher />
        </div>
        <UserNav />
      </div>
    </header>
  );
}
