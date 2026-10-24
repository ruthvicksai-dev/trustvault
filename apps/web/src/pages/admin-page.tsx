import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AuditEventSkeleton } from "@/components/audit/audit-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/auth-context";
import { auditApi, adminApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { AuditEvent, User, UserRole, UserStatus } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  RiAdminLine,
  RiCheckLine,
  RiCloseLine,
  RiAlertLine,
  RiShieldCheckLine,
  RiFilterLine,
  RiRefreshLine,
  RiLockLine,
  RiUserSharedLine,
  RiUserFollowLine,
  RiUserForbidLine,
  RiSearchLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiHistoryLine,
} from "@remixicon/react";

export function AdminPage() {
  const { user: currentAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<"users" | "audit">("users");

  /* ───────────────────────────────────────────────────────────────────────── */
  /* User Management State                                                      */
  /* ───────────────────────────────────────────────────────────────────────── */
  const [users, setUsers] = useState<User[]>([]);
  const [usersTotal, setUsersTotal] = useState<number>(0);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersSuccess, setUsersSuccess] = useState<string | null>(null);

  // User filters & pagination
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<"" | UserRole>("");
  const [userStatusFilter, setUserStatusFilter] = useState<"" | UserStatus>("");
  const [userPage, setUserPage] = useState(0);
  const USERS_PER_PAGE = 15;

  // Action confirmation modals
  const [roleModalUser, setRoleModalUser] = useState<User | null>(null);
  const [selectedNewRole, setSelectedNewRole] = useState<UserRole>("viewer");
  const [statusModalUser, setStatusModalUser] = useState<User | null>(null);
  const [actionPending, setActionPending] = useState(false);

  /* ───────────────────────────────────────────────────────────────────────── */
  /* System Audit State                                                        */
  /* ───────────────────────────────────────────────────────────────────────── */
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [auditTotal, setAuditTotal] = useState<number>(0);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Audit Filters
  const [actionFilter, setActionFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<"" | "success" | "denied" | "failure">("");
  const [actorIdFilter, setActorIdFilter] = useState("");
  const [documentIdFilter, setDocumentIdFilter] = useState("");

  /* ───────────────────────────────────────────────────────────────────────── */
  /* Data Fetching                                                             */
  /* ───────────────────────────────────────────────────────────────────────── */
  const fetchUsers = useCallback(async () => {
    if (currentAdmin?.role !== "admin") return;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await adminApi.listUsers({
        search: userSearch || undefined,
        role: userRoleFilter || undefined,
        status: userStatusFilter || undefined,
        limit: USERS_PER_PAGE,
        offset: userPage * USERS_PER_PAGE,
      });
      setUsers(res.users || []);
      setUsersTotal(res.pagination?.total || 0);
    } catch (err: any) {
      setUsersError(err?.message || "Failed to load registered users.");
    } finally {
      setUsersLoading(false);
    }
  }, [currentAdmin?.role, userSearch, userRoleFilter, userStatusFilter, userPage]);

  const fetchSystemEvents = useCallback(async () => {
    if (currentAdmin?.role !== "admin") return;
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await auditApi.listSystemEvents({
        action: actionFilter || undefined,
        outcome: outcomeFilter || undefined,
        actorId: actorIdFilter || undefined,
        documentId: documentIdFilter || undefined,
        limit: 50,
        offset: 0,
      });
      setEvents(res.events || []);
      setAuditTotal(res.pagination?.total || 0);
    } catch (err: any) {
      setAuditError(err?.message || "Failed to load system audit trail. Admin role required.");
    } finally {
      setAuditLoading(false);
    }
  }, [currentAdmin?.role, actionFilter, outcomeFilter, actorIdFilter, documentIdFilter]);

  useEffect(() => {
    if (activeTab === "users") {
      fetchUsers();
    } else {
      fetchSystemEvents();
    }
  }, [activeTab, fetchUsers, fetchSystemEvents]);

  /* ───────────────────────────────────────────────────────────────────────── */
  /* Handlers for Consequential Admin Actions                                  */
  /* ───────────────────────────────────────────────────────────────────────── */
  const handleConfirmRoleChange = async () => {
    if (!roleModalUser) return;
    setActionPending(true);
    setUsersError(null);
    setUsersSuccess(null);
    try {
      const res = await adminApi.updateUserRole(roleModalUser.id, selectedNewRole);
      setUsersSuccess(`Successfully updated role of ${roleModalUser.email} to ${selectedNewRole}.`);
      setRoleModalUser(null);
      await fetchUsers();
    } catch (err: any) {
      setUsersError(err?.message || "Failed to update user role.");
    } finally {
      setActionPending(false);
    }
  };

  const handleConfirmStatusToggle = async () => {
    if (!statusModalUser) return;
    setActionPending(true);
    setUsersError(null);
    setUsersSuccess(null);
    const newStatus: UserStatus = statusModalUser.status === "active" ? "disabled" : "active";
    try {
      const res = await adminApi.updateUserStatus(statusModalUser.id, newStatus);
      const actionText = newStatus === "disabled" ? "disabled (active sessions revoked)" : "re-enabled";
      setUsersSuccess(`Account ${statusModalUser.email} has been ${actionText}.`);
      setStatusModalUser(null);
      await fetchUsers();
    } catch (err: any) {
      setUsersError(err?.message || "Failed to change user account status.");
    } finally {
      setActionPending(false);
    }
  };

  // Route-level protection for unauthorized non-admins
  if (currentAdmin?.role !== "admin") {
    return (
      <div>
        <Header title="Administration Restricted" />
        <div className="p-8 max-w-lg mx-auto mt-12 text-center space-y-4">
          <div className="flex items-center justify-center size-14 rounded-3xl bg-destructive/10 text-destructive mx-auto">
            <RiLockLine className="size-7" />
          </div>
          <div>
            <h2 className="text-lg font-bold font-heading text-foreground">Access Restricted</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Platform administration and user management is restricted exclusively to authenticated users with the <strong>admin</strong> role. Your current role is <strong>{currentAdmin?.role}</strong>. The backend enforces this policy with HTTP 403 Forbidden.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const getOutcomeBadge = (outcome: string) => {
    switch (outcome) {
      case "success":
        return (
          <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 gap-1 px-1.5 py-0">
            <RiCheckLine className="size-3" />
            Success
          </Badge>
        );
      case "denied":
        return (
          <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1 px-1.5 py-0">
            <RiAlertLine className="size-3" />
            Denied
          </Badge>
        );
      case "failure":
        return (
          <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20 gap-1 px-1.5 py-0">
            <RiCloseLine className="size-3" />
            Failure
          </Badge>
        );
      default:
        return <Badge variant="outline">{outcome}</Badge>;
    }
  };

  const getRoleBadge = (role: UserRole) => {
    switch (role) {
      case "admin":
        return (
          <Badge variant="secondary" className="bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20 text-[10px] uppercase font-bold tracking-wider">
            Admin
          </Badge>
        );
      case "owner":
        return (
          <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-[10px] uppercase font-bold tracking-wider">
            Owner
          </Badge>
        );
      case "viewer":
        return (
          <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider">
            Viewer
          </Badge>
        );
    }
  };

  return (
    <div>
      <Header
        title="Platform Administration"
        description="Administrative user directory, role governance, and security event oversight"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={activeTab === "users" ? fetchUsers : fetchSystemEvents}
              disabled={activeTab === "users" ? usersLoading : auditLoading}
              title="Refresh view"
            >
              <RiRefreshLine className={`size-4 ${(activeTab === "users" ? usersLoading : auditLoading) ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Button
            variant={activeTab === "users" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("users")}
            className="gap-2 text-xs"
          >
            <RiUserSharedLine className="size-4" />
            <span>User Management</span>
            {usersTotal > 0 && (
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === "users" ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {usersTotal}
              </span>
            )}
          </Button>

          <Button
            variant={activeTab === "audit" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("audit")}
            className="gap-2 text-xs"
          >
            <RiHistoryLine className="size-4" />
            <span>Security Audit Trail</span>
          </Button>
        </div>

        {/* ═════════════════════════════════════════════════════════════════ */}
        {/* TAB 1: USER MANAGEMENT                                            */}
        {/* ═════════════════════════════════════════════════════════════════ */}
        {activeTab === "users" && (
          <div className="space-y-6 animate-in fade-in-50 duration-150">
            {/* Invariant Policy Callout */}
            <div className="p-4 rounded-3xl bg-sidebar border border-sidebar-border text-xs text-muted-foreground flex items-start gap-3">
              <RiShieldCheckLine className="size-4 text-primary shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-foreground">Role Governance & Session Invariants</p>
                <p>
                  Administrators can manage application roles (<code>admin</code>, <code>owner</code>, <code>viewer</code>) and account status. To prevent lockout, administrators cannot modify their own role or disable their own account, and the last active administrator cannot be demoted or disabled. Disabling an account immediately terminates all active server sessions.
                </p>
              </div>
            </div>

            {/* Notification Banners */}
            {usersError && (
              <div className="p-4 rounded-3xl bg-destructive/10 text-destructive text-xs border border-destructive/20 flex items-start gap-2">
                <RiAlertLine className="size-4 shrink-0 mt-0.5" />
                <span>{usersError}</span>
              </div>
            )}

            {usersSuccess && (
              <div className="p-4 rounded-3xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs border border-emerald-500/20 flex items-start gap-2">
                <RiCheckLine className="size-4 shrink-0 mt-0.5" />
                <span>{usersSuccess}</span>
              </div>
            )}

            {/* User Search & Filters */}
            <div className="p-4 rounded-3xl border border-border bg-card space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <RiFilterLine className="size-4 text-primary" />
                <span>Search & Filter Directory</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Search</label>
                  <div className="relative">
                    <RiSearchLine className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
                    <Input
                      placeholder="Email or display name"
                      value={userSearch}
                      onChange={(e) => {
                        setUserSearch(e.target.value);
                        setUserPage(0);
                      }}
                      className="h-8 text-xs pl-8"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Role</label>
                  <select
                    value={userRoleFilter}
                    onChange={(e) => {
                      setUserRoleFilter(e.target.value as any);
                      setUserPage(0);
                    }}
                    className="w-full h-8 rounded-2xl border border-input bg-background px-3 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">All Roles</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Account Status</label>
                  <select
                    value={userStatusFilter}
                    onChange={(e) => {
                      setUserStatusFilter(e.target.value as any);
                      setUserPage(0);
                    }}
                    className="w-full h-8 rounded-2xl border border-input bg-background px-3 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">All Statuses</option>
                    <option value="active">Active Only</option>
                    <option value="disabled">Disabled Only</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Users Table */}
            {usersLoading ? (
              <div className="p-12 text-center">
                <Spinner size="md" className="mx-auto mb-2 text-primary" />
                <p className="text-xs text-muted-foreground">Loading registered users…</p>
              </div>
            ) : users.length === 0 ? (
              <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-2">
                <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
                  <RiUserForbidLine className="size-6" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">No matching users</h3>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                  No accounts match the current filter criteria.
                </p>
              </div>
            ) : (
              <div className="rounded-3xl border border-border bg-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted/40 border-b border-border text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3">User & Contact</th>
                        <th className="px-4 py-3">Role</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Registered</th>
                        <th className="px-4 py-3 text-right">Administrative Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {users.map((u) => {
                        const isSelf = u.id === currentAdmin.id;
                        return (
                          <tr key={u.id} className="hover:bg-muted/10 transition-colors">
                            {/* User details */}
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="flex items-center justify-center size-7 rounded-full bg-primary/10 text-primary font-semibold text-xs uppercase shrink-0">
                                  {(u.displayName || u.email).slice(0, 2)}
                                </div>
                                <div className="space-y-0.5 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-foreground truncate">
                                      {u.displayName || u.email}
                                    </span>
                                    {isSelf && (
                                      <Badge variant="outline" className="text-[9px] px-1 py-0 bg-primary/10 text-primary border-primary/20">
                                        You
                                      </Badge>
                                    )}
                                  </div>
                                  {u.displayName && (
                                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                                      {u.email}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>

                            {/* Role */}
                            <td className="px-4 py-3">
                              {getRoleBadge(u.role)}
                            </td>

                            {/* Status */}
                            <td className="px-4 py-3">
                              <Badge
                                variant="outline"
                                className={`text-[10px] capitalize font-medium ${
                                  u.status === "active"
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                    : "bg-destructive/10 text-destructive border-destructive/20"
                                }`}
                              >
                                {u.status}
                              </Badge>
                            </td>

                            {/* Registered */}
                            <td className="px-4 py-3 text-muted-foreground text-[11px]">
                              {u.createdAt ? formatDate(u.createdAt) : "—"}
                            </td>

                            {/* Actions */}
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="xs"
                                  disabled={isSelf}
                                  title={isSelf ? "You cannot modify your own role" : "Change user role"}
                                  onClick={() => {
                                    setRoleModalUser(u);
                                    setSelectedNewRole(u.role);
                                  }}
                                >
                                  Role
                                </Button>

                                <Button
                                  variant={u.status === "active" ? "ghost" : "default"}
                                  size="xs"
                                  disabled={isSelf}
                                  className={
                                    u.status === "active"
                                      ? "text-destructive hover:bg-destructive/10"
                                      : "bg-emerald-600 hover:bg-emerald-700 text-white"
                                  }
                                  title={isSelf ? "You cannot disable your own account" : undefined}
                                  onClick={() => setStatusModalUser(u)}
                                >
                                  {u.status === "active" ? "Disable" : "Re-enable"}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination footer */}
                <div className="p-3 bg-muted/20 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Showing {users.length} of {usersTotal} Users
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={userPage === 0}
                      onClick={() => setUserPage((p) => Math.max(0, p - 1))}
                    >
                      <RiArrowLeftSLine className="size-4" />
                    </Button>
                    <span className="px-2 font-medium text-foreground">
                      Page {userPage + 1} of {Math.max(1, Math.ceil(usersTotal / USERS_PER_PAGE))}
                    </span>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={(userPage + 1) * USERS_PER_PAGE >= usersTotal}
                      onClick={() => setUserPage((p) => p + 1)}
                    >
                      <RiArrowRightSLine className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═════════════════════════════════════════════════════════════════ */}
        {/* TAB 2: SYSTEM AUDIT OVERSIGHT                                     */}
        {/* ═════════════════════════════════════════════════════════════════ */}
        {activeTab === "audit" && (
          <div className="space-y-6 animate-in fade-in-50 duration-150">
            {/* Privacy Callout */}
            <div className="p-4 rounded-3xl bg-sidebar border border-sidebar-border text-xs text-muted-foreground flex items-start gap-3">
              <RiShieldCheckLine className="size-4 text-primary shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-foreground">Administrative Oversight & Privacy Invariants</p>
                <p>
                  Administrators have global visibility into system security events (authentication attempts, grant modifications, rate limits, downloads), but do <strong>not</strong> possess implicit access to confidential document contents or keys. Backend authorization remains authoritative.
                </p>
              </div>
            </div>

            {/* Filter Controls */}
            <div className="p-4 rounded-3xl border border-border bg-card space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <RiFilterLine className="size-4 text-primary" />
                <span>Filter Security Events</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Action</label>
                  <Input
                    placeholder="e.g. auth_login, admin_change_role"
                    value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Outcome</label>
                  <select
                    value={outcomeFilter}
                    onChange={(e) => setOutcomeFilter(e.target.value as any)}
                    className="w-full h-8 rounded-2xl border border-input bg-background px-3 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">All Outcomes</option>
                    <option value="success">Success</option>
                    <option value="denied">Denied</option>
                    <option value="failure">Failure</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Actor UUID</label>
                  <Input
                    placeholder="UUID of user"
                    value={actorIdFilter}
                    onChange={(e) => setActorIdFilter(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && fetchSystemEvents()}
                    className="h-8 text-xs font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Document UUID</label>
                  <Input
                    placeholder="UUID of document"
                    value={documentIdFilter}
                    onChange={(e) => setDocumentIdFilter(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && fetchSystemEvents()}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              {(actorIdFilter || documentIdFilter) && (
                <div className="flex justify-end pt-1">
                  <Button size="xs" onClick={fetchSystemEvents}>
                    Apply UUID Filters
                  </Button>
                </div>
              )}
            </div>

            {auditError && (
              <div className="p-4 rounded-3xl bg-destructive/10 text-destructive text-xs border border-destructive/20 flex items-start gap-2">
                <RiAlertLine className="size-4 shrink-0 mt-0.5" />
                <span>{auditError}</span>
              </div>
            )}

            {/* Events Table / List */}
            {auditLoading ? (
              <div role="status">
                <span className="sr-only">Loading security events…</span>
                <div className="space-y-3" aria-busy="true" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <AuditEventSkeleton key={i} />
                  ))}
                </div>
              </div>
            ) : events.length === 0 ? (
              <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-2">
                <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
                  <RiAdminLine className="size-6" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">No matching security events</h3>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                  No audit records match the current filter criteria.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  <span>Showing {events.length} of {auditTotal} Events</span>
                </div>

                {events.map((evt) => (
                  <div
                    key={evt.id}
                    className="p-4 rounded-3xl border border-border bg-card hover:bg-muted/10 transition-colors text-xs space-y-2"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground">
                          {evt.action}
                        </span>
                        {getOutcomeBadge(evt.outcome)}
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {formatDate(evt.occurredAt)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/40">
                      {evt.actorId && (
                        <span>
                          Actor: <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">{evt.actorId}</code>
                        </span>
                      )}
                      {evt.documentId && (
                        <span>
                          Doc: <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">{evt.documentId}</code>
                        </span>
                      )}
                      {evt.reason && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          Reason: {evt.reason}
                        </span>
                      )}
                      {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground/80">
                          Meta: {JSON.stringify(evt.metadata)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* Role Change Confirmation Modal                                     */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <Dialog open={!!roleModalUser} onOpenChange={(open) => !open && setRoleModalUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-primary mb-1">
              <RiUserFollowLine className="size-5" />
              <DialogTitle>Change User Application Role</DialogTitle>
            </div>
            <DialogDescription>
              Select the new authorization role for <strong>{roleModalUser?.email}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <div className="p-3 rounded-2xl bg-muted/40 space-y-1.5 border border-border">
              <div className="text-muted-foreground">Current Role: <span className="font-semibold text-foreground uppercase">{roleModalUser?.role}</span></div>
              <div className="text-muted-foreground">Target User: <span className="font-mono text-[11px] text-foreground">{roleModalUser?.email}</span></div>
            </div>

            <div className="space-y-2">
              <label className="font-semibold text-foreground">Select New Role</label>
              <div className="grid grid-cols-3 gap-2">
                {(["viewer", "owner", "admin"] as UserRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setSelectedNewRole(r)}
                    className={`p-2.5 rounded-2xl border text-center font-medium capitalize transition-all ${
                      selectedNewRole === r
                        ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                        : "border-border hover:bg-muted/50 text-muted-foreground"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {selectedNewRole === "admin" && "Admins have platform oversight and user management permissions."}
                {selectedNewRole === "owner" && "Owners can upload and manage private documents and grant access."}
                {selectedNewRole === "viewer" && "Viewers can only access documents explicitly granted to them."}
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => setRoleModalUser(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={actionPending || selectedNewRole === roleModalUser?.role}
              onClick={handleConfirmRoleChange}
            >
              {actionPending ? (
                <>
                  <Spinner size="xs" className="mr-1.5" />
                  Updating…
                </>
              ) : (
                "Confirm Role Change"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* Account Status Confirmation Modal                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <Dialog open={!!statusModalUser} onOpenChange={(open) => !open && setStatusModalUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive mb-1">
              <RiUserForbidLine className="size-5" />
              <DialogTitle>
                {statusModalUser?.status === "active" ? "Disable User Account" : "Re-enable User Account"}
              </DialogTitle>
            </div>
            <DialogDescription>
              {statusModalUser?.status === "active"
                ? `Disabling ${statusModalUser?.email} will immediately terminate all active sessions and block API access. Existing documents, grants, and audit records remain safely preserved.`
                : `Re-enabling ${statusModalUser?.email} will restore their ability to log in and access their authorized documents.`}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => setStatusModalUser(null)}
            >
              Cancel
            </Button>
            <Button
              variant={statusModalUser?.status === "active" ? "destructive" : "default"}
              size="sm"
              disabled={actionPending}
              onClick={handleConfirmStatusToggle}
            >
              {actionPending ? (
                <>
                  <Spinner size="xs" className="mr-1.5" />
                  Processing…
                </>
              ) : statusModalUser?.status === "active" ? (
                "Disable Account"
              ) : (
                "Re-enable Account"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
