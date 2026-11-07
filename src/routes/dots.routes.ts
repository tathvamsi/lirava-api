import { Hono } from "hono";
import { listDots, getDot, createDot, deleteDot } from "../services/repo/index.js";
import { saveFile, guessMime, type Attachment } from "../services/files/index.js";

export const dotsRoutes = new Hono();

dotsRoutes.get("/", (c) => {
  const userId = c.req.query("userId") || "";
  const dots = listDots(userId);
  return c.json({ agents: dots, dots });
});

dotsRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const dot = getDot(id);
  if (!dot) return c.json({ error: "Dot not found" }, 404);
  return c.json({ agent: dot, dot });
});

dotsRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const dot = createDot(body);
    return c.json({ success: true, agent: dot, dot });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dotsRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const success = deleteDot(id);
  return c.json({ success });
});

dotsRoutes.post("/:id/files", async (c) => {
  try {
    const dotId = c.req.param("id");
    const userId = c.req.header("x-user-id") || c.req.query("userId") || "";

    const formData = await c.req.formData();
    const rawFiles = formData.getAll("file");
    const attachments: Attachment[] = [];

    for (const item of rawFiles) {
      if (item && typeof item === "object" && "arrayBuffer" in item) {
        const file = item as unknown as File;
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const name = file.name || "uploaded_file";
        const mime = file.type || guessMime(name);
        const att = saveFile(dotId, name, mime, buffer, userId);
        attachments.push(att);
      }
    }

    return c.json({ files: attachments });
  } catch (err: any) {
    console.error("[dots-files] Error uploading file:", err);
    return c.json({ error: err.message || "Failed to upload file" }, 500);
  }
});
