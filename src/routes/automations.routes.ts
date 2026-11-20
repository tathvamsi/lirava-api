import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { matterOwned } from "../services/data/pg.js";
import {
  MAX_AUTOMATIONS,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listRuns,
  runNow,
  setActive,
  updateAutomation,
  type SaveResult,
} from "../services/automations/index.js";

export const automationsRoutes = new Hono<AuthEnv>();

automationsRoutes.use("*", requireAuth);

type Body = { name?: unknown; prompt?: unknown; matterId?: unknown; frequency?: unknown; time?: unknown; weekday?: unknown };

const fail = (c: { json: (b: unknown, s: 500) => Response }, err: unknown) => {
  console.error("[automations] failed:", err);
  return c.json({ error: "Could not reach your automations. Please try again." }, 500);
};

/** A matter id is accepted only when it is the user's own. undefined = not given, "invalid" = refused. */
async function checkMatter(userId: string, value: unknown): Promise<string | null | undefined | "invalid"> {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  return (await matterOwned(value, userId)) ? value : "invalid";
}

function respond(c: { json: (b: unknown, s?: 200 | 201 | 400 | 404 | 409) => Response }, result: SaveResult, created = false) {
  if (result === "invalid") return c.json({ error: "Give the automation a name, the prompt to run, and a valid schedule." }, 400);
  if (result === "full") return c.json({ error: `You can keep up to ${MAX_AUTOMATIONS} automations. Delete one to add another.` }, 409);
  if (result === "missing") return c.json({ error: "Automation not found." }, 404);
  return c.json({ automation: result }, created ? 201 : 200);
}

automationsRoutes.get("/", async (c) => {
  try {
    return c.json({ automations: await listAutomations(c.get("user").id) });
  } catch (err) {
    return fail(c, err);
  }
});

automationsRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Body;
  try {
    const matterId = await checkMatter(userId, body.matterId);
    if (matterId === "invalid") return c.json({ error: "Matter not found." }, 404);
    return respond(c, await createAutomation(userId, { ...body, matterId: matterId ?? null }), true);
  } catch (err) {
    return fail(c, err);
  }
});

automationsRoutes.get("/:id", async (c) => {
  try {
    const automation = await getAutomation(c.get("user").id, c.req.param("id"));
    return automation ? c.json({ automation }) : c.json({ error: "Automation not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

automationsRoutes.put("/:id", async (c) => {
  const userId = c.get("user").id;
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Body;
  try {
    const matterId = await checkMatter(userId, body.matterId);
    if (matterId === "invalid") return c.json({ error: "Matter not found." }, 404);
    return respond(c, await updateAutomation(userId, c.req.param("id"), { ...body, matterId }));
  } catch (err) {
    return fail(c, err);
  }
});

/** Pause or resume: { active: true | false }. */
automationsRoutes.post("/:id/active", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { active?: unknown } | null;
  if (typeof body?.active !== "boolean") return c.json({ error: "Say whether it should be active." }, 400);
  try {
    const automation = await setActive(c.get("user").id, c.req.param("id"), body.active);
    return automation ? c.json({ automation }) : c.json({ error: "Automation not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

/** Starts a run now, in the background. The result is the new run, still "running"; the chat appears when it finishes. */
automationsRoutes.post("/:id/run", async (c) => {
  try {
    const result = await runNow(c.get("user").id, c.req.param("id"));
    if (result === "missing") return c.json({ error: "Automation not found." }, 404);
    if (result === "busy") return c.json({ error: "This automation is already running." }, 409);
    return c.json({ run: result }, 202);
  } catch (err) {
    return fail(c, err);
  }
});

automationsRoutes.get("/:id/runs", async (c) => {
  const userId = c.get("user").id;
  try {
    if (!(await getAutomation(userId, c.req.param("id")))) return c.json({ error: "Automation not found." }, 404);
    return c.json({ runs: await listRuns(userId, c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

automationsRoutes.delete("/:id", async (c) => {
  try {
    return (await deleteAutomation(c.get("user").id, c.req.param("id"))) ? c.json({ success: true }) : c.json({ error: "Automation not found." }, 404);
  } catch (err) {
    return fail(c, err);
  }
});
