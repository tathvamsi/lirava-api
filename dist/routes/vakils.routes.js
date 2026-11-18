import { Hono } from "hono";
import { listVakils, getVakilForUser, createVakil, deleteVakil } from "../services/repo/index.js";
import { saveFile } from "../services/files/index.js";
import { checkUpload } from "../services/files/http.js";
import { indexDocument } from "../services/documents/index.js";
import { requireAuth } from "../middleware/auth.js";
import { config } from "../config.js";
export const vakilsRoutes = new Hono();
vakilsRoutes.use("*", requireAuth);
const MAX_FILES_PER_UPLOAD = 10;
vakilsRoutes.get("/", async (c) => {
    const vakils = await listVakils(c.get("user").id);
    return c.json({ vakils });
});
vakilsRoutes.get("/:id", async (c) => {
    const vakil = await getVakilForUser(c.req.param("id"), c.get("user").id);
    if (!vakil)
        return c.json({ error: "Vakil not found" }, 404);
    return c.json({ vakil });
});
vakilsRoutes.post("/", async (c) => {
    try {
        const body = await c.req.json();
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        if (!name)
            return c.json({ error: "A name is required." }, 400);
        const vakil = await createVakil({
            name,
            purpose: typeof body.purpose === "string" ? body.purpose.slice(0, 500) : "",
            instructions: typeof body.instructions === "string" ? body.instructions.slice(0, 8000) : "",
            look: body.look,
            userId: c.get("user").id, // never taken from the request body
        });
        return c.json({ success: true, vakil });
    }
    catch (err) {
        console.error("[vakils] create failed:", err);
        return c.json({ error: "Could not create the Vakil." }, 500);
    }
});
vakilsRoutes.delete("/:id", async (c) => {
    const success = await deleteVakil(c.req.param("id"), c.get("user").id);
    if (!success)
        return c.json({ error: "Vakil not found" }, 404);
    return c.json({ success });
});
vakilsRoutes.post("/:id/files", async (c) => {
    const user = c.get("user");
    const vakil = await getVakilForUser(c.req.param("id"), user.id);
    if (!vakil)
        return c.json({ error: "Vakil not found" }, 404);
    try {
        const formData = await c.req.formData();
        const rawFiles = formData.getAll("file").filter((item) => typeof item === "object" && item !== null && "arrayBuffer" in item);
        if (!rawFiles.length)
            return c.json({ error: "No file was provided." }, 400);
        if (rawFiles.length > MAX_FILES_PER_UPLOAD)
            return c.json({ error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.` }, 400);
        const attachments = [];
        for (const file of rawFiles) {
            if (file.size > config.maxUploadBytes) {
                return c.json({ error: `${file.name || "File"} is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` }, 413);
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            const name = file.name || "uploaded_file";
            const check = checkUpload(name, buffer);
            if (!check.ok)
                return c.json({ error: check.reason }, 415);
            // The type comes from our own allowlist, not from what the browser claimed.
            const saved = await saveFile(vakil.id, name, check.mime, buffer, user.id);
            // Read the text page by page and index it, so questions can be answered from the right page.
            const index = await indexDocument({ userId: user.id, fileId: saved.id, name: saved.name, mime: saved.mime, buffer }).catch(() => ({ status: "failed", pages: 0, chunks: 0, unit: "page", note: "The file was saved but could not be indexed." }));
            attachments.push({ ...saved, index });
        }
        return c.json({ files: attachments });
    }
    catch (err) {
        console.error("[vakil-files] Error uploading file:", err);
        return c.json({ error: "Could not upload the file." }, 500);
    }
});
