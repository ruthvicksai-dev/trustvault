import React, { useState, useRef, useEffect } from "react";
import { useTheme, type Theme } from "@/context/theme-context";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RiSunLine,
  RiMoonLine,
  RiComputerLine,
  RiCheckLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";

interface ThemeSwitcherProps {
  className?: string;
  variant?: "dropdown" | "segmented";
  align?: "left" | "right";
}

const themeOptions: Array<{
  value: Theme;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: "light",
    label: "Light",
    description: "Bright, high-contrast theme",
    icon: RiSunLine,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Calibrated low-light theme",
    icon: RiMoonLine,
  },
  {
    value: "system",
    label: "System",
    description: "Follow operating system setting",
    icon: RiComputerLine,
  },
];

export function ThemeSwitcher({
  className,
  variant = "dropdown",
  align = "right",
}: ThemeSwitcherProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const CurrentIcon =
    theme === "system"
      ? RiComputerLine
      : theme === "dark"
      ? RiMoonLine
      : RiSunLine;

  const currentLabel =
    theme === "system"
      ? `System (${resolvedTheme === "dark" ? "Dark" : "Light"})`
      : theme === "dark"
      ? "Dark"
      : "Light";

  // Segmented 3-way toggle (used in settings or compact bars)
  if (variant === "segmented") {
    return (
      <div
        role="radiogroup"
        aria-label="Theme mode selection"
        className={cn(
          "grid grid-cols-3 gap-1 p-1 rounded-2xl bg-muted/70 border border-border/80 w-full",
          className
        )}
      >
        {themeOptions.map((opt) => {
          const Icon = opt.icon;
          const isSelected = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setTheme(opt.value)}
              className={cn(
                "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-xs font-medium transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring select-none min-w-0",
                isSelected
                  ? "bg-background text-foreground shadow-xs font-semibold ring-1 ring-border/50"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/40"
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{opt.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Dropdown variant (standard header / navigation toggle)
  return (
    <div className={cn("relative inline-block text-left", className)} ref={containerRef}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              aria-haspopup="true"
              aria-label={`Theme switcher: currently ${currentLabel}`}
              onClick={() => setOpen((prev) => !prev)}
              className="rounded-full text-foreground/80 hover:text-foreground hover:bg-muted/70 transition-colors"
            >
              <CurrentIcon className="size-4.5" />
            </Button>
          }
        />
        <TooltipContent side="bottom" align="center" className="text-xs">
          Theme: {currentLabel}
        </TooltipContent>
      </Tooltip>

      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          aria-label="Theme options"
          className={cn(
            "absolute z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] origin-top-right rounded-3xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl outline-none animate-in fade-in-0 zoom-in-95 duration-100",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Appearance
          </div>

          <div className="space-y-0.5">
            {themeOptions.map((opt) => {
              const Icon = opt.icon;
              const isSelected = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => {
                    setTheme(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2.5 rounded-2xl px-3 py-2 text-xs font-medium transition-colors cursor-pointer text-left outline-none focus-visible:bg-accent focus-visible:text-accent-foreground",
                    isSelected
                      ? "bg-accent/80 text-accent-foreground font-semibold"
                      : "text-foreground hover:bg-muted/60"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={cn(
                        "flex items-center justify-center size-6 rounded-lg",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <Icon className="size-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate">{opt.label}</p>
                      <p className="text-[10px] text-muted-foreground font-normal truncate">
                        {opt.description}
                      </p>
                    </div>
                  </div>

                  {isSelected && (
                    <RiCheckLine className="size-4 text-primary shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
