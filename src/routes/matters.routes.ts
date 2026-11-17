import { Hono } from "hono";
import {
  createMatter,
  getMatterForUser,
  listMatterEvents,
  listMatters,
  resolveMatterCheckpoint,
  type MatterIntake,
} from "../services/repo/index.js";
import { advanceCaseFile, getCaseFile } from "../services/casefile/index.js";
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
