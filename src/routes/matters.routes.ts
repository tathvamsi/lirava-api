import { Hono } from "hono";
import { createMatter, listMatters } from "../services/repo/index.js";

export const mattersRoutes = new Hono();

mattersRoutes.get("/", (c) => c.json({ matters: listMatters(c.req.query("userId") || "") }));

mattersRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.userId !== "string" || typeof body.title !== "string" || !body.title.trim()) {
    return c.json({ error: "userId and title are required" }, 400);
  }
  const matter = createMatter({
    userId: body.userId,
    title: body.title,
    client: typeof body.client === "string" ? body.client : "",
    court: typeof body.court === "string" ? body.court : "",
    nextDate: typeof body.nextDate === "string" ? body.nextDate : "",
    notes: typeof body.notes === "string" ? body.notes : "",
  });
  return c.json({ matter }, 201);
});
