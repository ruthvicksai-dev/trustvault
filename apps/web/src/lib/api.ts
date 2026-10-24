import type {
  User,
  AdminUsersResponse,
  DocumentItem,
  DocumentGrant,
  DocumentsResponse,
  AuditEventsResponse,
  ApiErrorResponse,
} from "@/types";

export class ApiError extends Error {
  statusCode: number;
  details?: Array<{ field: string; message: string }>;

  constructor(message: string, statusCode: number, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

// In-memory CSRF token storage (never placed in localStorage / sessionStorage)
let cachedCsrfToken: string | null = null;
let csrfTokenPromise: Promise<string> | null = null;

// Callback for session expiry / unauthorized events
let onUnauthorizedCallback: (() => void) | null = null;

export function setOnUnauthorizedHandler(handler: () => void) {
  onUnauthorizedCallback = handler;
}

/**
 * Fetches or returns cached CSRF token from the server.
 */
export async function getCsrfToken(forceRefresh = false): Promise<string> {
  if (cachedCsrfToken && !forceRefresh) {
    return cachedCsrfToken;
  }

  if (csrfTokenPromise && !forceRefresh) {
    return csrfTokenPromise;
  }

  csrfTokenPromise = (async () => {
    try {
      const res = await fetch("/api/auth/csrf-token", {
        method: "GET",
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error(`Failed to acquire CSRF token: HTTP ${res.status}`);
      }

      const data = await res.json();
      cachedCsrfToken = data.csrfToken;
      return data.csrfToken as string;
    } finally {
      csrfTokenPromise = null;
    }
  })();

  return csrfTokenPromise;
}

export function clearCsrfToken() {
  cachedCsrfToken = null;
}

interface RequestOptions extends RequestInit {
  requiresCsrf?: boolean;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const headers = new Headers(options.headers || {});

  // For state-changing requests or when explicitly requested, attach CSRF token
  if (stateChanging || options.requiresCsrf) {
    try {
      const token = await getCsrfToken();
      if (token) {
        headers.set("x-csrf-token", token);
      }
    } catch {
      // Proceed; server will reject if required
    }
  }

  // Ensure JSON Content-Type unless body is FormData
  if (!(options.body instanceof FormData) && !headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(endpoint, {
    ...options,
    method,
    headers,
    credentials: "include",
  });

  // Handle 401 Unauthorized (session expired or unauthenticated)
  if (response.status === 401) {
    // If not a login or register attempt, notify auth provider to reset state
    if (!endpoint.includes("/api/auth/login") && !endpoint.includes("/api/auth/register")) {
      clearCsrfToken();
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback();
      }
    }
  }

  // Handle error responses
  if (!response.ok) {
    let errorMessage = `HTTP error ${response.status}`;
    let details: Array<{ field: string; message: string }> | undefined;

    try {
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        const errorJson: ApiErrorResponse = await response.json();
        errorMessage = errorJson.error || errorMessage;
        details = errorJson.details;
      } else {
        const text = await response.text();
        if (text) errorMessage = text;
      }
    } catch {
      // Use fallback error message
    }

    throw new ApiError(errorMessage, response.status, details);
  }

  // Parse JSON response
  if (response.status === 204) {
    return {} as T;
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  return (await response.text()) as unknown as T;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Authentication API                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

export const authApi = {
  async getMe(): Promise<{ user: User }> {
    return request<{ user: User }>("/api/auth/me");
  },

  async login(credentials: { email: string; password: string }): Promise<{ user: User }> {
    clearCsrfToken();
    const res = await request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    // Immediately pre-fetch CSRF token for the new session
    getCsrfToken(true).catch(() => {});
    return res;
  },

  async register(data: { email: string; password: string }): Promise<{ message: string; user: User }> {
    return request<{ message: string; user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async logout(): Promise<{ message: string }> {
    try {
      const res = await request<{ message: string }>("/api/auth/logout", {
        method: "POST",
      });
      clearCsrfToken();
      return res;
    } catch (err) {
      clearCsrfToken();
      throw err;
    }
  },

  async changePassword(data: { currentPassword: string; newPassword: string }): Promise<{ message: string }> {
    return request<{ message: string }>("/api/auth/change-password", {
      method: "POST",
      requiresCsrf: true,
      body: JSON.stringify(data),
    });
  },

  async updateProfile(data: { displayName?: string | null }): Promise<{ message: string; user: User }> {
    return request<{ message: string; user: User }>("/api/auth/profile", {
      method: "PATCH",
      requiresCsrf: true,
      body: JSON.stringify(data),
    });
  },
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* Documents API                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

export interface ListDocumentsParams {
  search?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export const documentsApi = {
  async list(params: ListDocumentsParams = {}): Promise<DocumentsResponse> {
    const query = new URLSearchParams();
    if (params.search?.trim()) query.set("search", params.search.trim());
    if (params.category?.trim()) query.set("category", params.category.trim());
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    return request<DocumentsResponse>(`/api/documents${qs ? `?${qs}` : ""}`);
  },

  async getById(id: string): Promise<{ document: DocumentItem }> {
    return request<{ document: DocumentItem }>(`/api/documents/${encodeURIComponent(id)}`);
  },

  async upload(formData: FormData): Promise<{ message: string; document: DocumentItem }> {
    return request<{ message: string; document: DocumentItem }>("/api/documents", {
      method: "POST",
      requiresCsrf: true,
      body: formData,
    });
  },

  async update(
    id: string,
    updates: { title?: string; category?: string }
  ): Promise<{ message: string; document: DocumentItem }> {
    return request<{ message: string; document: DocumentItem }>(
      `/api/documents/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        requiresCsrf: true,
        body: JSON.stringify(updates),
      }
    );
  },

  async delete(id: string): Promise<{ message: string }> {
    return request<{ message: string }>(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      requiresCsrf: true,
    });
  },

  /**
   * Downloads document content securely through the backend authorized streaming endpoint.
   * Creates a transient Blob URL, triggers save dialog, and immediately revokes the URL.
   */
  async download(id: string, filenameFallback = "document"): Promise<void> {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/download`, {
      method: "GET",
      credentials: "include",
    });

    if (!response.ok) {
      let errorMessage = `Failed to download: HTTP ${response.status}`;
      try {
        const errorJson = await response.json();
        if (errorJson?.error) errorMessage = errorJson.error;
      } catch {
        // Fallback
      }
      throw new ApiError(errorMessage, response.status);
    }

    // Determine filename from Content-Disposition header if present
    let filename = filenameFallback;
    const disposition = response.headers.get("content-disposition");
    if (disposition) {
      // Support RFC 5987 filename*=UTF-8''... or standard filename="..."
      const rfc5987Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (rfc5987Match && rfc5987Match[1]) {
        try {
          filename = decodeURIComponent(rfc5987Match[1]);
        } catch {
          // Keep fallback
        }
      } else {
        const standardMatch = disposition.match(/filename="?([^";]+)"?/i);
        if (standardMatch && standardMatch[1]) {
          filename = standardMatch[1].trim();
        }
      }
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Secure cleanup: immediately revoke the transient object URL
    setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);
  },

  /* ── Grants ─────────────────────────────────────────────────────────────── */

  async listGrants(documentId: string): Promise<{ grants: DocumentGrant[] }> {
    return request<{ grants: DocumentGrant[] }>(
      `/api/documents/${encodeURIComponent(documentId)}/grants`
    );
  },

  async createGrant(
    documentId: string,
    data: { email: string; permission: "read" | "edit" }
  ): Promise<{ message: string; grant: DocumentGrant }> {
    return request<{ message: string; grant: DocumentGrant }>(
      `/api/documents/${encodeURIComponent(documentId)}/grants`,
      {
        method: "POST",
        requiresCsrf: true,
        body: JSON.stringify(data),
      }
    );
  },

  async updateGrant(
    documentId: string,
    grantId: string,
    data: { permission: "read" | "edit" }
  ): Promise<{ message: string; grant: DocumentGrant }> {
    return request<{ message: string; grant: DocumentGrant }>(
      `/api/documents/${encodeURIComponent(documentId)}/grants/${encodeURIComponent(grantId)}`,
      {
        method: "PATCH",
        requiresCsrf: true,
        body: JSON.stringify(data),
      }
    );
  },

  async revokeGrant(documentId: string, grantId: string): Promise<{ message: string }> {
    return request<{ message: string }>(
      `/api/documents/${encodeURIComponent(documentId)}/grants/${encodeURIComponent(grantId)}`,
      {
        method: "DELETE",
        requiresCsrf: true,
      }
    );
  },

  async getDocumentAudit(
    documentId: string,
    params: { limit?: number; offset?: number } = {}
  ): Promise<AuditEventsResponse> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const qs = query.toString();
    return request<AuditEventsResponse>(
      `/api/documents/${encodeURIComponent(documentId)}/audit${qs ? `?${qs}` : ""}`
    );
  },
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* System Audit API (Admin Only)                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

export interface SystemAuditParams {
  action?: string;
  outcome?: "success" | "denied" | "failure";
  actorId?: string;
  documentId?: string;
  limit?: number;
  offset?: number;
}

export const auditApi = {
  async listSystemEvents(params: SystemAuditParams = {}): Promise<AuditEventsResponse> {
    const query = new URLSearchParams();
    if (params.action?.trim()) query.set("action", params.action.trim());
    if (params.outcome) query.set("outcome", params.outcome);
    if (params.actorId?.trim()) query.set("actorId", params.actorId.trim());
    if (params.documentId?.trim()) query.set("documentId", params.documentId.trim());
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    return request<AuditEventsResponse>(`/api/audit${qs ? `?${qs}` : ""}`);
  },
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* Admin User Management API                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

export interface AdminListUsersParams {
  search?: string;
  role?: "admin" | "owner" | "viewer";
  status?: "active" | "disabled";
  limit?: number;
  offset?: number;
}

export const adminApi = {
  async listUsers(params: AdminListUsersParams = {}): Promise<AdminUsersResponse> {
    const query = new URLSearchParams();
    if (params.search?.trim()) query.set("search", params.search.trim());
    if (params.role) query.set("role", params.role);
    if (params.status) query.set("status", params.status);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    return request<AdminUsersResponse>(`/api/admin/users${qs ? `?${qs}` : ""}`);
  },

  async getUser(id: string): Promise<{ user: User }> {
    return request<{ user: User }>(`/api/admin/users/${encodeURIComponent(id)}`);
  },

  async updateUserRole(id: string, role: "admin" | "owner" | "viewer"): Promise<{ message: string; user: User }> {
    return request<{ message: string; user: User }>(`/api/admin/users/${encodeURIComponent(id)}/role`, {
      method: "PATCH",
      requiresCsrf: true,
      body: JSON.stringify({ role }),
    });
  },

  async updateUserStatus(id: string, status: "active" | "disabled"): Promise<{ message: string; user: User }> {
    return request<{ message: string; user: User }>(`/api/admin/users/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      requiresCsrf: true,
      body: JSON.stringify({ status }),
    });
  },

  async updateUser(
    id: string,
    data: { role?: "admin" | "owner" | "viewer"; status?: "active" | "disabled"; displayName?: string | null }
  ): Promise<{ message: string; user: User }> {
    return request<{ message: string; user: User }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      requiresCsrf: true,
      body: JSON.stringify(data),
    });
  },
};
