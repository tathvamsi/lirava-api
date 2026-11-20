import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { matterOwned } from "../services/data/pg.js";
import { MAX_NOTES, createNote, deleteNote, getNote, listNotes, updateNote } from "../services/notes/index.js";

export const notesRoutes = new Hono<AuthEnv>();

notesRoutes.use("*", requireAuth);

const fail = (c: { json: (b: unknown, s: 500) => Response }, err: unknown) => {
  console.error("[notes] failed:", err);
  return c.json({ error: "Could not reach your notes. Please try again." }, 500);
};

/** A matter id is accepted only when it is the user's own. Returns undefined when the value was not given. */
async function checkMatter(userId: string, value: unknown): Promise<string | null | undefined | "invalid"> {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  return (await matterOwned(value, userId)) ? value : "invalid";
}

notesRoutes.get("/", async (c) => {
  const matterId = c.req.query("matterId") || undefined;
  try {
    return c.json({ notes: await listNotes(c.get("user").id, matterId) });
  } catch (err) {
    return fail(c, err);
  }
});

notesRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => null)) as { title?: unknown; content?: unknown; matterId?: unknown } | null;
  try {
    const matterId = await checkMatter(userId, body?.matterId);
    if (matterId === "invalid") return c.json({ error: "Matter not found." }, 404);
    const note = await createNote(userId, { title: body?.title, content: body?.content, matterId: matterId ?? null });
    if (note === "full") return c.json({ error: `You can keep up to ${MAX_NOTES} notes. Delete one to add another.` }, 409);
    if (!note) return c.json({ error: "That note could not be saved." }, 400);
    return c.json({ note }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

notesRoutes.get("/:id", async (c) => {
  try {
    const note = await getNote(c.get("user").id, c.req.param("id"));
    return note ? c.json({ note }) : c.json({ error: "Note not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

notesRoutes.put("/:id", async (c) => {
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => null)) as { title?: unknown; content?: unknown; matterId?: unknown } | null;
  try {
    const matterId = await checkMatter(userId, body?.matterId);
    if (matterId === "invalid") return c.json({ error: "Matter not found." }, 404);
    const note = await updateNote(userId, c.req.param("id"), { title: body?.title, content: body?.content, matterId });
    return note ? c.json({ note }) : c.json({ error: "Note not found, or it could not be saved." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

notesRoutes.delete("/:id", async (c) => {
  try {
    return (await deleteNote(c.get("user").id, c.req.param("id"))) ? c.json({ success: true }) : c.json({ error: "Note not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});
