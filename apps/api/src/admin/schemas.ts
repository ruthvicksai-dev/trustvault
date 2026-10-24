import { z } from "zod";

export const updateUserRoleSchema = z
  .object({
    role: z.enum(["admin", "owner", "viewer"], {
      errorMap: () => ({ message: "Role must be one of: admin, owner, viewer" }),
    }),
  })
  .strict({ message: "Unexpected fields in role update request" });

export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

export const updateUserStatusSchema = z
  .object({
    status: z.enum(["active", "disabled"], {
      errorMap: () => ({ message: "Status must be active or disabled" }),
    }),
  })
  .strict({ message: "Unexpected fields in status update request" });

export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

export const updateUserAdminSchema = z
  .object({
    role: z.enum(["admin", "owner", "viewer"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict({ message: "Unexpected fields in admin update request" })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: "At least one of role or status must be provided",
  });

export type UpdateUserAdminInput = z.infer<typeof updateUserAdminSchema>;
