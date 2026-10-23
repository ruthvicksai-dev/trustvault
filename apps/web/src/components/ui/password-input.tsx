import * as React from "react";
import { useState } from "react";
import { Input } from "./input";
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react";
import { cn } from "@/lib/utils";

export interface PasswordInputProps
  extends Omit<React.ComponentProps<typeof Input>, "type"> {
  defaultVisible?: boolean;
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, defaultVisible = false, disabled, ...props }, ref) => {
    const [isVisible, setIsVisible] = useState(defaultVisible);

    const toggleVisibility = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsVisible((prev) => !prev);
    };

    return (
      <div className="relative w-full">
        <Input
          {...props}
          ref={ref}
          type={isVisible ? "text" : "password"}
          disabled={disabled}
          className={cn("pr-10", className)}
        />
        <button
          type="button"
          onClick={toggleVisibility}
          disabled={disabled}
          tabIndex={0}
          aria-label={isVisible ? "Hide password" : "Show password"}
          title={isVisible ? "Hide password" : "Show password"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center size-6 rounded-lg text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          {isVisible ? (
            <RiEyeOffLine className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <RiEyeLine className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="sr-only">
            {isVisible ? "Hide password" : "Show password"}
          </span>
        </button>
      </div>
    );
  }
);

PasswordInput.displayName = "PasswordInput";
