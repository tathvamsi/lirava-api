import { Hono } from "hono";
import { getFileForUser } from "../services/files/index.js";
import { contentDisposition, isInlineSafe } from "../services/files/http.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";

export const filesRoutes = new Hono<AuthEnv>();

filesRoutes.use("*", requireAuth);

filesRoutes.get("/:id", async (c) => {
  // Someone else's file looks exactly like a file that does not exist.
  const file = await getFileForUser(c.req.param("id"), c.get("user").id);
  if (!file) return c.json({ error: "File not found" }, 404);

  // Only formats a browser can display safely open in the page. Anything else downloads.
  const inline = c.req.query("download") !== "1" && isInlineSafe(file.mime);

  return new Response(new Uint8Array(file.data), {
    status: 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", file.name),
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});
