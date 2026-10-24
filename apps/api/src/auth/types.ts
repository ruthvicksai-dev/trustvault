import "express-session";

export type UserRole = "admin" | "owner" | "viewer";
export type UserStatus = "active" | "disabled";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  displayName?: string | null;
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    role?: UserRole;
    createdAt?: number;
    passwordUpdatedAt?: number;
    csrfToken?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
