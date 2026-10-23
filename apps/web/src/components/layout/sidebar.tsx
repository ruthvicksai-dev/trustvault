import React from "react";
import { NavLink } from "react-router-dom";
import {
  RiShieldCheckLine,
  RiDashboardLine,
  RiFileTextLine,
  RiShareLine,
  RiHistoryLine,
  RiAdminLine,
  RiLogoutBoxRLine,
  RiUser3Line,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const { user, logout } = useAuth();

  const navItems = [
    {
      to: "/overview",
      label: "Overview",
      icon: RiDashboardLine,
      allowed: true,
    },
    {
      to: "/documents",
      label: "My Documents",
      icon: RiFileTextLine,
      allowed: true,
    },
    {
      to: "/shared",
      label: "Shared with Me",
      icon: RiShareLine,
      allowed: true,
    },
    {
      to: "/audit",
      label: "My Document Audits",
      icon: RiHistoryLine,
      allowed: user?.role === "owner" || user?.role === "admin",
    },
    {
      to: "/admin",
      label: "System Audit Oversight",
      icon: RiAdminLine,
      allowed: user?.role === "admin",
      badge: "Admin",
    },
  ];

  return (
    <aside
      className={cn(
        "flex flex-col h-full bg-sidebar border-r border-sidebar-border text-sidebar-foreground",
        className
      )}
    >
      {/* Brand Header */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-sidebar-border/60">
        <div className="flex items-center justify-center size-9 rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
          <RiShieldCheckLine className="size-5" />
        </div>
        <div>
          <span className="font-heading font-bold text-lg tracking-tight text-sidebar-foreground">
            TrustVault
          </span>
          <span className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Secure Documents
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="px-3 pb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Navigation
        </div>
        {navItems
          .filter((item) => item.allowed)
          .map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs font-semibold"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <Icon className="size-4.5 shrink-0" />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-sidebar-border">
                    {item.badge}
                  </Badge>
                )}
              </NavLink>
            );
          })}
      </nav>

      {/* User Info & Session Footer */}
      <div className="p-4 border-t border-sidebar-border/60 bg-sidebar/50">
        <div className="flex items-center gap-3 p-2 rounded-2xl bg-sidebar-accent/40 mb-3">
          <div className="flex items-center justify-center size-8 rounded-full bg-sidebar-primary/10 text-sidebar-primary font-bold text-xs uppercase">
            <RiUser3Line className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-sidebar-foreground truncate" title={user?.email}>
              {user?.email}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="size-1.5 rounded-full bg-emerald-500 inline-block" />
              <span className="text-[11px] font-medium text-muted-foreground capitalize">
                {user?.role}
              </span>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => logout()}
        >
          <RiLogoutBoxRLine className="size-4 mr-2" />
          Sign Out
        </Button>
      </div>
    </aside>
  );
}
