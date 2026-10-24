import { z } from "zod";
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "./argon2.js";

/**
 * Strict schema for user registration.
 * Rejects any client-supplied fields like 'role', 'status', 'id', etc.
 */
export const registerSchema = z
  .object({
    email: z
      .string({ required_error: "Email is required" })
      .email("Invalid email address format")
      .max(255, "Email cannot exceed 255 characters")
      .transform((val) => val.trim().toLowerCase()),
    password: z
      .string({ required_error: "Password is required" })
      .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
      .max(MAX_PASSWORD_LENGTH, `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
  })
  .strict({ message: "Unexpected fields in registration request" });

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Strict schema for login.
 * Rejects any unexpected fields.
 */
export const loginSchema = z
  .object({
    email: z
      .string({ required_error: "Email is required" })
      .email("Invalid email address format")
      .max(255, "Email cannot exceed 255 characters")
      .transform((val) => val.trim().toLowerCase()),
    password: z
      .string({ required_error: "Password is required" })
      .min(1, "Password is required")
      .max(MAX_PASSWORD_LENGTH, `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
  })
  .strict({ message: "Unexpected fields in login request" });

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Strict schema for authenticated password changes.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ required_error: "Current password is required" })
      .min(1, "Current password is required")
      .max(MAX_PASSWORD_LENGTH, `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
    newPassword: z
      .string({ required_error: "New password is required" })
      .min(MIN_PASSWORD_LENGTH, `New password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
      .max(MAX_PASSWORD_LENGTH, `New password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
  })
  .strict({ message: "Unexpected fields in password change request" });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Strict schema for authenticated profile updates.
 * Rejects any attempt to tamper with role, status, email, id, etc.
 */
export const updateProfileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Display name must be at least 1 character")
      .max(100, "Display name cannot exceed 100 characters")
      .refine((val) => !/<script/i.test(val), { message: "Display name cannot contain script tags" })
      .nullable()
      .optional(),
  })
  .strict({ message: "Unexpected fields in profile update request" });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
