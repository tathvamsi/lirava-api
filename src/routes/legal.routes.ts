import { Hono } from "hono";
import { searchStatutes } from "../services/legal/qdrant.js";
import { retrieveLegalContext } from "../services/legal/rag.js";
import { seedLegalCorpus } from "../services/legal/corpus-seeder.js";
import { generateCourtPdf, generateCourtDocx, type LegalPleadingData } from "../services/legal/court-engine.js";
import { config } from "../config.js";
import { OFFLINE_NOTICE } from "../services/legal/notice.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit, requireAdmin } from "../middleware/security.js";

export const legalRoutes = new Hono<AuthEnv>();

// Everything here uses the model, the vector store or document generation: sign-in is required.
legalRoutes.use("*", requireAuth);
legalRoutes.use("/answer", rateLimit("legal-answer", 40, 60 * 1000));
legalRoutes.use("/search", rateLimit("legal-search", 60, 60 * 1000));

// Semantic Statutory RAG Search
legalRoutes.get("/search", async (c) => {
  const query = c.req.query("q") || "";
  const act = c.req.query("act");
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 5) || 5, 1), 20);

  const results = await searchStatutes(query, limit, act);
  return c.json({ query, results });
});

// Full RAG Context Inspector
legalRoutes.get("/rag-context", requireAdmin, async (c) => {
  const query = c.req.query("q") || "";
  if (!query) return c.json({ error: "Query parameter 'q' is required" }, 400);

  const ragResult = await retrieveLegalContext(query);
  return c.json({ query, ragResult });
});

// Answer Legal Question (RAG + Inference)
legalRoutes.post("/answer", async (c) => {
  try {
    const body = await c.req.json();
    const question = (typeof body.question === "string" ? body.question : "").trim();
    if (!question) {
      return c.json({ error: "question is required" }, 400);
    }
    if (question.length > 4000) {
      return c.json({ error: "The question is too long." }, 413);
    }

    const ragResult = await retrieveLegalContext(question, 1400);
    let answer = "";

    try {
      const { getLlmClient } = await import("../services/agent/client.js");
      const client = getLlmClient();
      const prompt = ragResult?.contextText
        ? `Legal Context:\n${ragResult.contextText}\n\nQuestion: ${question}\n\nProvide an authoritative legal answer citing relevant provisions:`
        : question;

      const completion = await client.chat.completions.create({
        model: config.customLlmModel,
        messages: [
          {
            role: "system",
            content: "You are an expert Indian Legal Advocate and Senior Counsel. Answer accurately with statutory citations.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        // A reasoning model spends part of this thinking before it writes the answer.
        max_tokens: 3000,
      });
      answer = (completion.choices[0]?.message?.content || "").trim();
      // An empty reply (the model used its whole budget thinking) is a failure, not an answer.
      if (!answer) throw new Error("The model returned no answer text.");
    } catch {
      const { generateLegalResponse } = await import("../services/legal/knowledge.js");
      answer = OFFLINE_NOTICE + generateLegalResponse(question);
    }

    const citations = (ragResult?.sources || []).map((s) => ({
      documentId: s.act || "Statutory Act",
      documentTitle: s.title || `${s.act || "Law"} ${s.section || ""}`.trim(),
      chunkIndex: 0,
      text: s.source || s.title || "",
      score: s.score || 0.8,
    }));

    return c.json({
      answer,
      citations,
      confidence: citations.length > 0 ? 0.9 : 0.7,
      status: "complete",
    });
  } catch (err: any) {
    console.error("[legal] answer failed:", err);
    return c.json({ error: "Failed to answer legal question" }, 500);
  }
});

// Seed / Re-seed Legal Corpus
legalRoutes.post("/seed", requireAdmin, async (c) => {
  const force = c.req.query("force") === "true";
  const result = await seedLegalCorpus(force);
  return c.json(result);
});

// Generate Court PDF
legalRoutes.post("/generate-pdf", async (c) => {
  try {
    const data = await c.req.json() as LegalPleadingData;
    const pdfBytes = await generateCourtPdf(data);

    return new Response(pdfBytes as any, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="court_pleading.pdf"',
      },
    });
  } catch (err: any) {
    if (err?.name === "UnsupportedTextError" || err instanceof SyntaxError) return c.json({ error: err.message || "Invalid pleading data" }, 422);
    console.error("[legal] PDF generation failed:", err);
    return c.json({ error: "Failed to generate PDF" }, 500);
  }
});

// Generate Court Word DOCX
legalRoutes.post("/generate-docx", async (c) => {
  try {
    const data = await c.req.json() as LegalPleadingData;
    const docxBuffer = await generateCourtDocx(data);

    return new Response(docxBuffer as any, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="court_pleading.docx"',
      },
    });
  } catch (err: any) {
    if (err instanceof SyntaxError) return c.json({ error: "Invalid pleading data" }, 422);
    console.error("[legal] DOCX generation failed:", err);
    return c.json({ error: "Failed to generate DOCX" }, 500);
  }
});
