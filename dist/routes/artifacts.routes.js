import { Hono } from "hono";
import { listArtifacts, saveArtifact } from "../services/repo/index.js";
import { generateCourtPdf, generateCourtDocx } from "../services/legal/court-engine.js";
import { saveFile } from "../services/files/index.js";
export const artifactsRoutes = new Hono();
artifactsRoutes.get("/", (c) => {
    const userId = c.req.query("userId") || "";
    const artifacts = listArtifacts(userId, { agentOnly: c.req.query("agentOnly") === "true" });
    return c.json({ artifacts });
});
artifactsRoutes.post("/", async (c) => {
    try {
        const body = await c.req.json();
        let pdfFileId = body.pdfFileId || null;
        const title = body.title || "Legal Agreement";
        const filename = body.filename || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 50)}.pdf`;
        // Automatically generate court PDF if not provided so PDF preview & download work immediately!
        if (!pdfFileId && body.content) {
            try {
                const pdfBytes = await generateCourtPdf({
                    courtName: "In the High Court of Judicature",
                    caseType: body.kind === "contract" ? "Commercial Agreement" : "Legal Document",
                    petitioner: title,
                    respondent: "Parties Concerned",
                    grounds: [body.content.slice(0, 400)],
                    prayers: ["Document presented for record and legal compliance."],
                });
                const saved = saveFile(body.dotId || "vakil_dev", filename, "application/pdf", Buffer.from(pdfBytes), body.userId || "");
                pdfFileId = saved.id;
            }
            catch (pdfErr) {
                console.warn("Could not auto-generate PDF for artifact:", pdfErr);
            }
        }
        const artifact = saveArtifact({
            ...body,
            filename,
            pdfFileId,
        });
        return c.json({ success: true, artifact });
    }
    catch (err) {
        return c.json({ error: err.message }, 500);
    }
});
artifactsRoutes.get("/:id", (c) => {
    const id = c.req.param("id");
    const artifacts = listArtifacts();
    const artifact = artifacts.find((a) => a.id === id);
    if (!artifact)
        return c.json({ error: "Artifact not found" }, 404);
    return c.json({ artifact });
});
artifactsRoutes.get("/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = c.req.query("format") || "pdf";
    const artifacts = listArtifacts();
    const artifact = artifacts.find((a) => a.id === id);
    if (!artifact)
        return c.json({ error: "Artifact not found" }, 404);
    try {
        // Generate court document
        const pleadingData = {
            courtName: "In the High Court of Judicature",
            caseType: "Legal Pleading",
            petitioner: "Petitioner",
            respondent: "Respondent",
            grounds: [artifact.content.slice(0, 300) || "Grounds of petition"],
            prayers: ["Prayer for relief as set forth herein."],
        };
        if (format === "docx") {
            const docx = await generateCourtDocx(pleadingData);
            return new Response(docx, {
                headers: {
                    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "Content-Disposition": `attachment; filename="${artifact.title || "document"}.docx"`,
                },
            });
        }
        const pdf = await generateCourtPdf(pleadingData);
        return new Response(pdf, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${artifact.title || "document"}.pdf"`,
            },
        });
    }
    catch (err) {
        return c.json({ error: err.message }, 500);
    }
});
