import type { ErrorRequestHandler } from "express";
import { ZodError, z } from "zod";
import { isProd } from "../env.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_error",
      details: z.treeifyError(err),
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: "internal_error",
    message: isProd ? "Something went wrong" : String(err?.message ?? err),
  });
};
