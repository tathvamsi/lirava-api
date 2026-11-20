import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { addMemory, clearMemories, deleteMemory, listMemories, updateMemory } from "../services/memories/index.js";

export const memoriesRoutes = new Hono<AuthEnv>();

memoriesRoutes.use("*", requireAuth);

const fail = (c: { json: (b: unknown, s: 500) => Response }, err: unknown) => {
  console.error("[memories] failed:", err);
  return c.json({ error: "Could not reach your memories. Please try again." }, 500);
};

memoriesRoutes.get("/", async (c) => {
  try {
    return c.json({ memories: await listMemories(c.get("user").id) });
  } catch (err) {
    return fail(c, err);
  }
});

memoriesRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
  try {
    const result = await addMemory(c.get("user").id, body?.content);
    if (result === "full") return c.json({ error: "You have reached the limit of 100 memories. Delete one to add another." }, 409);
    if (!result) return c.json({ error: "Write something to remember." }, 400);
    return c.json({ memory: result }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

memoriesRoutes.put("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
  try {
    const memory = await updateMemory(c.get("user").id, c.req.param("id"), body?.content);
    return memory ? c.json({ memory }) : c.json({ error: "Memory not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

memoriesRoutes.delete("/:id", async (c) => {
  try {
    return (await deleteMemory(c.get("user").id, c.req.param("id"))) ? c.json({ success: true }) : c.json({ error: "Memory not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

/** Forget everything. */
memoriesRoutes.delete("/", async (c) => {
  try {
    return c.json({ success: true, removed: await clearMemories(c.get("user").id) });
  } catch (err) {
    return fail(c, err);
  }
});
