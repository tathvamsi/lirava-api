import { Hono } from "hono";
import { getSql } from "../services/db/postgres.js";
import { withSchemaLock } from "../services/db/schema-lock.js";
import { rateLimit } from "../middleware/security.js";
/** Unauthenticated forms from the marketing site. Validated, size-limited and rate-limited per address. */
export const publicRoutes = new Hono();
publicRoutes.use("*", rateLimit("public-forms", 12, 60 * 60 * 1000));
let ready = null;
async function sql() {
    const client = getSql();
    if (!client)
        throw new Error("DATABASE_URL is not configured.");
    if (!ready) {
        ready = withSchemaLock(client, (tx) => tx.unsafe(`CREATE TABLE IF NOT EXISTS waitlist_signups (
           id          BIGSERIAL PRIMARY KEY,
           email       TEXT NOT NULL UNIQUE,
           name        TEXT NOT NULL,
           firm        TEXT NOT NULL,
           role        TEXT NOT NULL,
           practice_area TEXT,
           team_size   TEXT NOT NULL,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE TABLE IF NOT EXISTS survey_responses (
           id            BIGSERIAL PRIMARY KEY,
           practice_area TEXT NOT NULL,
           time_lost     TEXT NOT NULL,
           tools         TEXT,
           pilot         TEXT NOT NULL,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );`))
            .then(() => undefined)
            .catch((err) => {
            ready = null;
            throw err;
        });
    }
    await ready;
    return client;
}
const str = (value, min, max) => {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEAM_SIZES = new Set(["1", "2–10", "11–50", "51+"]);
const PILOT = new Set(["Yes", "Maybe", "Not currently"]);
publicRoutes.post("/waitlist", async (c) => {
    const body = (await c.req.json().catch(() => null));
    const name = str(body?.name, 2, 100);
    const email = str(body?.email, 3, 254)?.toLowerCase() ?? null;
    const firm = str(body?.firm, 2, 160);
    const role = str(body?.role, 2, 100);
    const practiceArea = body?.practiceArea == null || body.practiceArea === "" ? null : str(body.practiceArea, 1, 120);
    const teamSize = typeof body?.teamSize === "string" && TEAM_SIZES.has(body.teamSize) ? body.teamSize : null;
    if (!name || !email || !EMAIL_RE.test(email) || !firm || !role || !teamSize || (body?.practiceArea && !practiceArea)) {
        return c.json({ error: "Please complete all required fields with valid details." }, 400);
    }
    try {
        const db = await sql();
        await db `
      INSERT INTO waitlist_signups (email, name, firm, role, practice_area, team_size)
      VALUES (${email}, ${name}, ${firm}, ${role}, ${practiceArea}, ${teamSize})
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, firm = EXCLUDED.firm, role = EXCLUDED.role,
        practice_area = EXCLUDED.practice_area, team_size = EXCLUDED.team_size`;
        return c.json({ message: "Thank you. We will be in touch about early access." }, 201);
    }
    catch (err) {
        console.error("[public] waitlist save failed:", err);
        return c.json({ error: "We could not save your details. Please try again shortly." }, 503);
    }
});
publicRoutes.post("/survey", async (c) => {
    const body = (await c.req.json().catch(() => null));
    const practiceArea = str(body?.practiceArea, 1, 200);
    const timeLost = str(body?.timeLost, 1, 2000);
    const tools = body?.tools == null || body.tools === "" ? null : str(body.tools, 1, 500);
    const pilot = typeof body?.pilot === "string" && PILOT.has(body.pilot) ? body.pilot : null;
    if (!practiceArea || !timeLost || !pilot || (body?.tools && !tools)) {
        return c.json({ error: "Please complete all required fields." }, 400);
    }
    try {
        const db = await sql();
        await db `INSERT INTO survey_responses (practice_area, time_lost, tools, pilot) VALUES (${practiceArea}, ${timeLost}, ${tools}, ${pilot})`;
        return c.json({ message: "Thank you for sharing your perspective." }, 201);
    }
    catch (err) {
        console.error("[public] survey save failed:", err);
        return c.json({ error: "We could not save your answers. Please try again shortly." }, 503);
    }
});
