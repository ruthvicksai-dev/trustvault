import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@/context/theme-context";
import { AuthProvider } from "@/context/auth-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/app-shell";
import { PageLoader } from "@/components/ui/page-loader";

const LoginPage = lazy(() => import("@/pages/login-page").then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import("@/pages/overview-page").then((m) => ({ default: m.OverviewPage })));
const DocumentsPage = lazy(() => import("@/pages/documents-page").then((m) => ({ default: m.DocumentsPage })));
const SharedPage = lazy(() => import("@/pages/shared-page").then((m) => ({ default: m.SharedPage })));
const AuditPage = lazy(() => import("@/pages/audit-page").then((m) => ({ default: m.AuditPage })));
const AdminPage = lazy(() => import("@/pages/admin-page").then((m) => ({ default: m.AdminPage })));

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<PageLoader />}>
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
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
