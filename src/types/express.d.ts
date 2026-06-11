import "express";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireWorkspace middleware on all /api routes. */
      workspace?: {
        user: { id: string; email: string; name: string };
        organizationId: string;
        role: string;
      };
    }
  }
}
