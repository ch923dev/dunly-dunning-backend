import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { isProd } from "../env.js";

/**
 * The one API validation shape (audit B17):
 * `{ error: "validation", details: [{ field, message }] }` — produced here
 * for thrown ZodErrors and by every route's inline safeParse handling.
 */
export function zodIssueDetails(err: ZodError): { field: string; message: string }[] {
  return err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation",
      details: zodIssueDetails(err),
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: "internal_error",
    message: isProd ? "Something went wrong" : String(err?.message ?? err),
  });
};
