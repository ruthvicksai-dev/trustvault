import { z } from "zod";

export const createDocumentSchema = z
  .object({
    title: z
      .string({ required_error: "Title is required" })
      .trim()
      .min(1, "Title must be at least 1 character long")
      .max(200, "Title cannot exceed 200 characters"),
    category: z
      .string({ required_error: "Category is required" })
      .trim()
      .min(1, "Category must be at least 1 character long")
      .max(100, "Category cannot exceed 100 characters"),
    content: z
      .string({ required_error: "Content is required" })
      .min(1, "Document content cannot be empty"),
    mimeType: z
      .string()
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/, "Invalid MIME type format")
      .default("text/plain"),
  })
  .strict({ message: "Unexpected fields in document creation request" });

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Title must be at least 1 character long")
      .max(200, "Title cannot exceed 200 characters")
      .optional(),
    category: z
      .string()
      .trim()
      .min(1, "Category must be at least 1 character long")
      .max(100, "Category cannot exceed 100 characters")
      .optional(),
  })
  .strict({ message: "Unexpected fields in document update request" })
  .refine((data) => data.title !== undefined || data.category !== undefined, {
    message: "At least one of 'title' or 'category' must be provided for update",
  });

export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const createGrantSchema = z
  .object({
    email: z
      .string({ required_error: "User email is required" })
      .email("Invalid recipient email address format")
      .transform((val) => val.trim().toLowerCase()),
    permission: z.enum(["read", "edit"], {
      errorMap: () => ({ message: "Permission must be either 'read' or 'edit'" }),
    }),
  })
  .strict({ message: "Unexpected fields in grant creation request" });

export type CreateGrantInput = z.infer<typeof createGrantSchema>;

export const updateGrantSchema = z
  .object({
    permission: z.enum(["read", "edit"], {
      errorMap: () => ({ message: "Permission must be either 'read' or 'edit'" }),
    }),
  })
  .strict({ message: "Unexpected fields in grant update request" });

export type UpdateGrantInput = z.infer<typeof updateGrantSchema>;
