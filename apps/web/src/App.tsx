import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/context/auth-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/app-shell";
import { LoginPage } from "@/pages/login-page";
import { OverviewPage } from "@/pages/overview-page";
import { DocumentsPage } from "@/pages/documents-page";
import { SharedPage } from "@/pages/shared-page";
import { AuditPage } from "@/pages/audit-page";
import { AdminPage } from "@/pages/admin-page";

export function App() {
  return (
    <TooltipProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Auth Routes */}
            <Route path="/login" element={<LoginPage />} />

            {/* Authenticated Shell Routes */}
            <Route path="/" element={<AppShell />}>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="overview" element={<OverviewPage />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="shared" element={<SharedPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="admin" element={<AdminPage />} />
            </Route>

            {/* Catch-all redirect */}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  );
}
