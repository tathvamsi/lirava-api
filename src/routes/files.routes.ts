import { Hono } from "hono";
import { getFile } from "../services/files/index.js";

export const filesRoutes = new Hono();

filesRoutes.get("/:id", (c) => {
  const fileId = c.req.param("id");
  const file = getFile(fileId);
  if (!file) {
    return c.text("File not found", 404);
  }

  const download = c.req.query("download") === "1";
  const safeFilename = file.name.replace(/["\r\n]/g, "");
  const disposition = download
    ? `attachment; filename="${safeFilename}"`
    : `inline; filename="${safeFilename}"`;

  return new Response(file.data as any, {
    status: 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": disposition,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=86400",
    },
  });
});
