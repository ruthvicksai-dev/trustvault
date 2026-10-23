import React from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth-context";
import { Sidebar } from "./sidebar";
import { RiShieldCheckLine } from "@remixicon/react";

export function AppShell() {
  const { user, loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="flex items-center justify-center size-14 rounded-2xl bg-primary/10 text-primary">
            <RiShieldCheckLine className="size-8" />
          </div>
          <div className="text-center">
            <h2 className="font-heading font-bold text-lg">TrustVault</h2>
            <p className="text-xs text-muted-foreground mt-1">Verifying secure session…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop Fixed Sidebar */}
      <div className="hidden md:flex md:w-64 md:shrink-0">
        <Sidebar className="w-64" />
      </div>

      {/* Main Content Viewport */}
      <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
        <main className="flex-1 pb-12">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
