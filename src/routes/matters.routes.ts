import { Hono } from "hono";
import {
  createMatter,
  deleteMatter,
  MATTER_STATUSES,
  setMatterStatus,
  getMatterForUser,
  listMatterEvents,
  listMatters,
  resolveMatterCheckpoint,
  type MatterIntake,
} from "../services/repo/index.js";
import { advanceCaseFile, getCaseFile } from "../services/casefile/index.js";
import { createNode, deleteNode, ensureSections, importCaseFile, listNodes, updateNode, type NodeInput } from "../services/casebrain/index.js";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";

export const mattersRoutes = new Hono<AuthEnv>();

mattersRoutes.use("*", requireAuth);

mattersRoutes.get("/", async (c) => c.json({ matters: await listMatters(c.get("user").id) }));

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** What the person told counsel at handover. Anything missing or malformed is dropped rather than trusted. */
function cleanIntake(value: unknown): MatterIntake | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const brief = text(raw.brief, 5000);
  if (!brief) return null;
  const urgency = raw.urgency === "urgent" || raw.urgency === "soon" ? raw.urgency : "routine";
  const keyDates = (Array.isArray(raw.keyDates) ? raw.keyDates : [])
    .slice(0, 12)
    .map((item) => ({ label: text((item as any)?.label, 120), date: text((item as any)?.date, 10) }))
    .filter((item) => item.label && isDate(item.date));
  const deadline = text(raw.deadline, 10);
  return {
    brief,
    caseType: text(raw.caseType, 80),
    oppositeParty: text(raw.oppositeParty, 200),
    keyDates,
    outcome: text(raw.outcome, 1000),
    urgency,
    deadline: isDate(deadline) ? deadline : "",
  };
}

mattersRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const title = text(body?.title, 200);
  if (!title) return c.json({ error: "A matter name is required." }, 400);
  const intake = cleanIntake(body?.intake);
  if (body?.intake && !intake) return c.json({ error: "Tell your counsel a little about the case first." }, 400);
  const nextDate = text(body?.nextDate, 32) || intake?.deadline || "";
  const matter = await createMatter({
    userId: c.get("user").id, // never taken from the request body
    title,
    client: text(body?.client, 200),
    court: text(body?.court, 200),
    nextDate,
    notes: text(body?.notes, 5000),
    intake,
  });
  return c.json({ matter }, 201);
});

/** One matter with its timeline. Someone else's matter is reported as not found. */
mattersRoutes.get("/:id", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  return c.json({ matter, events: await listMatterEvents(matter.id, userId) });
});

/** The case file built from this matter's documents (null until a build has been started). */
mattersRoutes.get("/:id/case-file", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  return c.json({ caseFile: await getCaseFile(userId, matter.id) });
});

/**
 * Starts building the case file, or carries on with a build in progress. Each call works for a short while and
 * returns; call again while the status is "building". `restart: true` throws away a finished one and reads again.
 */
mattersRoutes.post("/:id/case-file/build", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    return c.json({ caseFile: await advanceCaseFile(userId, matter.id, { restart: body?.restart === true }) });
  } catch {
    return c.json({ error: "The case file could not be built. Try again." }, 502);
  }
});

// ---------------- The case knowledge tree ----------------

/** The tree for this matter (its starting sections are created on first use). */
mattersRoutes.get("/:id/nodes", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  await ensureSections(userId, matter.id);
  return c.json({ nodes: await listNodes(userId, matter.id) });
});

mattersRoutes.post("/:id/nodes", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  const body = (await c.req.json().catch(() => null)) as NodeInput | null;
  const node = body ? await createNode(userId, matter.id, body) : null;
  if (!node) return c.json({ error: "A node needs a kind and a title, and its parent must be in this matter." }, 400);
  return c.json({ node }, 201);
});

/** Pulls what the papers say (parties, dates, facts, claims) into the tree as proposed nodes the lawyer can confirm. */
mattersRoutes.post("/:id/nodes/import", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  const { added } = await importCaseFile(userId, matter.id);
  return c.json({ added, nodes: await listNodes(userId, matter.id) });
});

mattersRoutes.patch("/:id/nodes/:nodeId", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  const body = (await c.req.json().catch(() => null)) as NodeInput | null;
  const node = body ? await updateNode(userId, matter.id, c.req.param("nodeId"), body) : null;
  if (!node) return c.json({ error: "That node was not found, or the change is not allowed." }, 404);
  return c.json({ node });
});

mattersRoutes.delete("/:id/nodes/:nodeId", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  if (!(await deleteNode(userId, matter.id, c.req.param("nodeId")))) return c.json({ error: "Node not found." }, 404);
  return c.json({ ok: true, nodes: await listNodes(userId, matter.id) });
});

/** Changes a matter's status: active, on_hold, closed or archived (archiving puts a matter away and can be undone). */
mattersRoutes.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const status = MATTER_STATUSES.find((s) => s === body?.status);
  if (!status) return c.json({ error: "Status must be active, on_hold, closed or archived." }, 400);
  const matter = await setMatterStatus(c.req.param("id"), c.get("user").id, status);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  return c.json({ matter });
});

/** Deletes a matter for good, with its timeline, case file and papers. Its chats are kept, detached from it. */
mattersRoutes.delete("/:id", async (c) => {
  const ok = await deleteMatter(c.req.param("id"), c.get("user").id);
  if (!ok) return c.json({ error: "Matter not found." }, 404);
  return c.json({ ok: true });
});

mattersRoutes.post("/:id/checkpoints/:eventId", async (c) => {
  const userId = c.get("user").id;
  const matter = await getMatterForUser(c.req.param("id"), userId);
  if (!matter) return c.json({ error: "Matter not found." }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const resolution = body?.resolution === "approved" || body?.resolution === "changes" ? body.resolution : null;
  if (!resolution) return c.json({ error: "Approve it or ask for changes." }, 400);
  const note = text(body?.note, 2000);
  if (resolution === "changes" && !note) return c.json({ error: "Say what should change." }, 400);
  const event = await resolveMatterCheckpoint(c.req.param("eventId"), matter.id, userId, resolution, note);
  if (!event) return c.json({ error: "That checkpoint is no longer waiting." }, 409);
  return c.json({ event, events: await listMatterEvents(matter.id, userId) });
});
