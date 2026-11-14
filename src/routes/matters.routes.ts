import { Hono } from "hono";
import { createMatter, listMatters } from "../services/repo/index.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";

export const mattersRoutes = new Hono<AuthEnv>();

mattersRoutes.use("*", requireAuth);

mattersRoutes.get("/", async (c) => c.json({ matters: await listMatters(c.get("user").id) }));

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

mattersRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const title = text(body?.title, 200);
  if (!title) return c.json({ error: "A matter name is required." }, 400);
  const matter = await createMatter({
    userId: c.get("user").id, // never taken from the request body
    title,
    client: text(body?.client, 200),
    court: text(body?.court, 200),
    nextDate: text(body?.nextDate, 32),
    notes: text(body?.notes, 5000),
  });
  return c.json({ matter }, 201);
});
