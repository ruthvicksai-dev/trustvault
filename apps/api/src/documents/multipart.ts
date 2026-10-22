import type { Request } from "express";
import busboy from "busboy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { finished } from "node:stream/promises";
import { MAX_DOCUMENT_FILE_SIZE } from "./file-validator.js";

export interface ParsedMultipartDocument {
  fields: {
    title?: string;
    category?: string;
    [key: string]: string | undefined;
  };
  buffer: Buffer;
  filename: string;
  declaredMimeType: string;
  tempFilePath: string;
  cleanup: () => Promise<void>;
}

export interface MultipartParseError {
  statusCode: 400 | 413;
  message: string;
}

/**
 * Parses streaming multipart/form-data upload using busboy.
 * Streams incoming file directly to an isolated temporary file to avoid unbounded memory buffering.
 * Enforces strict limits: max 1 file, 10MB file size limit, and cleans up on any failure.
 */
export function parseMultipartUpload(req: Request): Promise<ParsedMultipartDocument> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      reject({
        statusCode: 400,
        message: "Invalid content type: expected multipart/form-data",
      } as MultipartParseError);
      return;
    }

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_DOCUMENT_FILE_SIZE,
          files: 1,
          fields: 10,
        },
      });
    } catch (bbInitErr: any) {
      reject({
        statusCode: 400,
        message: `Malformed multipart request: ${bbInitErr.message || "Invalid headers or boundary"}`,
      } as MultipartParseError);
      return;
    }

    const fields: Record<string, string> = {};
    let tempFilePath: string | null = null;
    let writeStream: fs.WriteStream | null = null;
    let fileStreamPromise: Promise<void> | null = null;
    let fileDeclaredMime = "application/octet-stream";
    let fileOriginalName = "document";
    let fileCount = 0;
    let fileTruncated = false;
    let isCleanedUp = false;
    let reqAborted = false;

    const cleanupTempFile = async () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          await fs.promises.unlink(tempFilePath);
        } catch {
          // Ignore unlink errors during cleanup
        }
      }
    };

    // Clean up temporary file if client terminates connection prematurely
    const handleAbort = async () => {
      if (reqAborted) return;
      reqAborted = true;
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy(new Error("Upload aborted by client"));
      }
      await cleanupTempFile();
      reject({
        statusCode: 400,
        message: "Client aborted upload request",
      } as MultipartParseError);
    };

    req.on("aborted", handleAbort);
    req.on("close", () => {
      if (!req.complete) {
        handleAbort();
      }
    });

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (name, stream, info) => {
      fileCount++;
      if (fileCount > 1) {
        stream.resume(); // Discard additional files
        return;
      }

      // Finding H: Reject filenames containing null bytes or control characters immediately
      if (info.filename && /[\x00-\x1f\x7f]/.test(info.filename)) {
        stream.resume();
        cleanupTempFile().finally(() => {
          reject({
            statusCode: 400,
            message: "Filename contains invalid control characters or null bytes",
          } as MultipartParseError);
        });
        return;
      }

      fileOriginalName = info.filename || "document";
      fileDeclaredMime = info.mimeType || "application/octet-stream";

      // Finding D: Secure temp file with mode 0o600 (owner-only) and flags 'wx' (exclusive creation)
      // in OS temp directory using cryptographically secure UUID.
      const tempId = crypto.randomUUID();
      tempFilePath = path.join(os.tmpdir(), `trustvault-upload-${tempId}.tmp`);
      try {
        const ws = fs.createWriteStream(tempFilePath, {
          mode: 0o600,
          flags: "wx",
        });
        writeStream = ws;

        stream.on("limit", () => {
          fileTruncated = true;
        });

        // Finding E: finished(ws) ensures stream is completely flushed and file descriptor is closed.
        // Attach rejection handler to prevent unhandledRejection when stream is destroyed on abort/error,
        // while preserving rejection on fileStreamPromise so later await in bb.on("finish") observes errors.
        const finishedPromise = finished(ws);
        finishedPromise.catch(() => {});
        fileStreamPromise = finishedPromise;
        stream.on("error", (err) => {
          ws.destroy(err);
        });

        stream.pipe(ws);
      } catch (createErr: any) {
        stream.resume();
        cleanupTempFile().finally(() => {
          reject({
            statusCode: 400,
            message: `Failed to initialize temporary upload file: ${createErr.message}`,
          } as MultipartParseError);
        });
      }
    });

    bb.on("error", (err: any) => {
      cleanupTempFile().finally(() => {
        reject({
          statusCode: 400,
          message: `Malformed multipart payload: ${err?.message || "Invalid payload format"}`,
        } as MultipartParseError);
      });
    });

    bb.on("finish", async () => {
      if (reqAborted) return;

      if (fileCount === 0 || !tempFilePath || !fileStreamPromise) {
        await cleanupTempFile();
        reject({
          statusCode: 400,
          message: "No file was provided in the upload request",
        } as MultipartParseError);
        return;
      }

      try {
        await fileStreamPromise;
      } catch (streamErr: any) {
        await cleanupTempFile();
        reject({
          statusCode: 400,
          message: `File stream write error: ${streamErr.message}`,
        } as MultipartParseError);
        return;
      }

      if (fileTruncated) {
        await cleanupTempFile();
        reject({
          statusCode: 413,
          message: "File size exceeds maximum permitted limit of 10 MB",
        } as MultipartParseError);
        return;
      }

      try {
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size === 0) {
          await cleanupTempFile();
          reject({
            statusCode: 400,
            message: "Document content cannot be empty",
          } as MultipartParseError);
          return;
        }

        if (stats.size > MAX_DOCUMENT_FILE_SIZE) {
          await cleanupTempFile();
          reject({
            statusCode: 413,
            message: "File size exceeds maximum permitted limit of 10 MB",
          } as MultipartParseError);
          return;
        }

        const buffer = await fs.promises.readFile(tempFilePath);

        resolve({
          fields,
          buffer,
          filename: fileOriginalName,
          declaredMimeType: fileDeclaredMime,
          tempFilePath,
          cleanup: cleanupTempFile,
        });
      } catch (readErr: any) {
        await cleanupTempFile();
        reject({
          statusCode: 400,
          message: `Failed to finalize uploaded file: ${readErr.message}`,
        } as MultipartParseError);
      }
    });

    req.pipe(bb);
  });
}
