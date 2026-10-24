import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";
import { EditProfileDialog } from "@/components/settings/edit-profile-dialog";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";
import { Spinner } from "@/components/ui/spinner";
import {
  RiUser3Line,
  RiLockPasswordLine,
  RiLogoutBoxRLine,
  RiArrowDownSLine,
  RiAlertLine,
  RiEditLine,
} from "@remixicon/react";

export function UserNav() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
        setLogoutError(null);
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  // Close dropdown on Escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setLogoutError(null);
      }
    }

    if (open) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      {/* User Button Trigger */}
      <button
        type="button"
        id="user-menu-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((prev) => {
            if (prev) setLogoutError(null);
            return !prev;
          });
        }}
        className="flex items-center gap-2 p-1.5 sm:px-2.5 sm:py-1.5 rounded-full hover:bg-muted/70 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-center size-7 rounded-full bg-primary/10 text-primary font-semibold text-xs uppercase shrink-0">
          {(user.displayName || user.email).slice(0, 2)}
        </div>
        <span className="hidden md:inline-block max-w-[140px] truncate text-xs font-medium text-foreground">
          {user.displayName || user.email}
        </span>
        <RiArrowDownSLine className={`size-3.5 text-muted-foreground transition-transform duration-200 hidden sm:block ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown Menu Popup */}
      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          aria-labelledby="user-menu-button"
          className="absolute right-0 z-50 mt-2 w-72 sm:w-80 max-w-[calc(100vw-1.5rem)] origin-top-right rounded-3xl border border-border bg-popover p-2.5 text-popover-foreground shadow-2xl outline-none animate-in fade-in-0 zoom-in-95 duration-100"
        >
          {/* User Safe Identity Summary */}
          <div className="px-3 py-2">
            <p className="text-xs font-semibold text-foreground truncate" title={user.displayName || user.email}>
              {user.displayName || user.email}
            </p>
            {user.displayName && (
              <p className="text-[11px] text-muted-foreground truncate" title={user.email}>
                {user.email}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0 h-4">
                {user.role}
              </Badge>
              <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500 inline-block shrink-0" />
                Active Session
              </span>
            </div>
          </div>

          <Separator className="my-2 bg-border/70" />

          {/* Theme Selector */}
          <div className="px-2 py-1.5">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
              Appearance
            </div>
            <ThemeSwitcher variant="segmented" className="w-full" />
          </div>

          <Separator className="my-2 bg-border/70" />

          {/* Edit Profile Action */}
          <button
            type="button"
            role="menuitem"
            disabled={isLoggingOut}
            onClick={() => {
              setOpen(false);
              setEditProfileOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RiEditLine className="size-4 text-muted-foreground shrink-0" />
            <span>Edit Profile</span>
          </button>

          {/* Change Password Action */}
          <button
            type="button"
            role="menuitem"
            disabled={isLoggingOut}
            onClick={() => {
              setOpen(false);
              setChangePasswordOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RiLockPasswordLine className="size-4 text-muted-foreground shrink-0" />
            <span>Change Password</span>
          </button>

          <Separator className="my-1.5 opacity-60" />

          {/* Sign Out Action with pending state and feedback */}
          {logoutError && (
            <div
              role="alert"
              className="flex items-start gap-2 p-2 mb-1.5 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20"
            >
              <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
              <span>{logoutError}</span>
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
            onClick={async () => {
              setIsLoggingOut(true);
              setLogoutError(null);
              try {
                await logout();
                setOpen(false);
              } catch (err: any) {
                setLogoutError(err?.message || "Failed to sign out. Please try again.");
              } finally {
                setIsLoggingOut(false);
              }
            }}
            className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoggingOut ? (
              <>
                <Spinner size="xs" className="text-destructive shrink-0" />
                <span>Signing Out…</span>
              </>
            ) : (
              <>
                <RiLogoutBoxRLine className="size-4 text-destructive shrink-0" />
                <span>Sign Out</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Edit Profile Dialog */}
      <EditProfileDialog
        open={editProfileOpen}
        onOpenChange={setEditProfileOpen}
      />

      {/* Change Password Dialog */}
      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />
    </div>
  );
}
