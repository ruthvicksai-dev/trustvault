export type UserRole = "admin" | "owner" | "viewer";
export type UserStatus = "active" | "disabled";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt?: string;
}

export type DocumentPermission = "owner" | "read" | "edit";

export interface DocumentItem {
  id: string;
  title: string;
  category: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
  permission: DocumentPermission;
}

export interface DocumentGrant {
  id: string;
  documentId: string;
  userId: string;
  userEmail: string;
  permission: "read" | "edit";
  grantedBy: string;
  createdAt: string;
  revokedAt: string | null;
  isActive?: boolean;
}

export interface AuditEvent {
  id: string;
  actorId: string | null;
  documentId: string | null;
  action: string;
  outcome: "success" | "denied" | "failure";
  reason: string | null;
  metadata: Record<string, any> | null;
  occurredAt: string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}

export interface DocumentsResponse {
  documents: DocumentItem[];
  pagination: Pagination;
}

export interface AuditEventsResponse {
  events: AuditEvent[];
  pagination: Pagination;
}

export interface ApiErrorResponse {
  error: string;
  details?: Array<{ field: string; message: string }>;
}
