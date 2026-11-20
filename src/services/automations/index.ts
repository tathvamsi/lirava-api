/**
 * Automations: a saved prompt that runs by itself on a schedule ("every weekday at 9:00, summarise today's hearings").
 * Each run opens a new chat for its owner (inside a matter if one is chosen) and asks the assistant, exactly as if
 * the owner had typed the prompt, so it has the same access and nothing more. Scoped to the owning user.
 */
import crypto from "node:crypto";
import { getSql } from "../db/postgres.js";
import { withSchemaLock } from "../db/schema-lock.js";
import { createConversation } from "../chats/store.js";
import { sendMessage } from "../agent/runtime.js";
import { describeSchedule, nextRunAfter, parseSchedule, type Frequency, type Schedule } from "./schedule.js";

export const MAX_AUTOMATIONS = 20;
export const MAX_NAME_CHARS = 80;
export const MAX_PROMPT_CHARS = 4000;
export const RUN_HISTORY = 20;
/** A run that has been "running" this long was cut off (for example by a restart). */
export const STALE_RUN_MS = 15 * 60 * 1000;
const DEFAULT_VAKIL = "soli_master";
const TICK_MS = 30_000;
const DUE_BATCH = 5;

export type RunStatus = "running" | "success" | "error";
export type RunTrigger = "schedule" | "manual";

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  matterId: string | null;
  frequency: Frequency;
  time: string;
  weekday: number;
  /** "Every weekday at 9:00 AM IST". */
  schedule: string;
  active: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: RunStatus | null;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: string;
  automationId: string;
  conversationId: string | null;
  status: RunStatus;
  error: string | null;
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number | null;
}

/** The stored automation including its owner, for the scheduler. Never sent to the browser. */
interface Stored extends Automation {
  userId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  matter_id   TEXT,
  frequency   TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  weekday     INT NOT NULL DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at BIGINT,
  next_run_at BIGINT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS automations_user_idx ON automations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automations_due_idx ON automations (next_run_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS automation_runs (
  id              TEXT PRIMARY KEY,
  automation_id   TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  trigger         TEXT NOT NULL,
  started_at      BIGINT NOT NULL,
  finished_at     BIGINT
);
CREATE INDEX IF NOT EXISTS automation_runs_auto_idx ON automation_runs (automation_id, started_at DESC);
`;

let ready: Promise<void> | null = null;
async function pg() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured.");
  if (!ready) {
    ready = withSchemaLock(sql, async (tx) => {
      await tx.unsafe(SCHEMA);
    }).catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  return sql;
}

type Row = {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  matter_id: string | null;
  frequency: Frequency;
  time_of_day: string;
  weekday: number;
  is_active: boolean;
  last_run_at: string | number | null;
  next_run_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
  last_status?: RunStatus | null;
};

const num = (v: string | number | null) => (v === null ? null : Number(v));
const scheduleOf = (r: Row): Schedule => ({ frequency: r.frequency, time: r.time_of_day, weekday: Number(r.weekday) });

function toStored(r: Row): Stored {
  const schedule = scheduleOf(r);
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    prompt: r.prompt,
    matterId: r.matter_id,
    frequency: schedule.frequency,
    time: schedule.time,
    weekday: schedule.weekday,
    schedule: describeSchedule(schedule),
    active: r.is_active,
    lastRunAt: num(r.last_run_at),
    nextRunAt: num(r.next_run_at),
    lastStatus: r.last_status ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toPublic(stored: Stored): Automation {
  const { userId: _owner, ...rest } = stored;
  void _owner;
  return rest;
}

type RunRow = { id: string; automation_id: string; conversation_id: string | null; status: RunStatus; error: string | null; trigger: RunTrigger; started_at: string | number; finished_at: string | number | null };
const toRun = (r: RunRow): Run => ({
  id: r.id,
  automationId: r.automation_id,
  conversationId: r.conversation_id,
  status: r.status,
  error: r.error,
  trigger: r.trigger,
  startedAt: Number(r.started_at),
  finishedAt: num(r.finished_at),
});

export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
  return name || null;
}

export function cleanPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prompt = value.trim().slice(0, MAX_PROMPT_CHARS);
  return prompt || null;
}

const SELECT_WITH_STATUS = `
  SELECT a.*, (SELECT r.status FROM automation_runs r WHERE r.automation_id = a.id ORDER BY r.started_at DESC LIMIT 1) AS last_status
  FROM automations a`;

export async function listAutomations(userId: string): Promise<Automation[]> {
  if (!userId) return [];
  const sql = await pg();
  const rows = await sql.unsafe<Row[]>(`${SELECT_WITH_STATUS} WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT ${MAX_AUTOMATIONS}`, [userId]);
  return rows.map((r) => toPublic(toStored(r)));
}

async function loadStored(userId: string, id: string): Promise<Stored | null> {
  if (!userId) return null;
  const sql = await pg();
  const rows = await sql.unsafe<Row[]>(`${SELECT_WITH_STATUS} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function getAutomation(userId: string, id: string): Promise<Automation | null> {
  const stored = await loadStored(userId, id);
  return stored ? toPublic(stored) : null;
}

export type SaveResult = Automation | "invalid" | "full" | "missing";

export async function createAutomation(
  userId: string,
  input: { name?: unknown; prompt?: unknown; matterId?: string | null; frequency?: unknown; time?: unknown; weekday?: unknown },
): Promise<SaveResult> {
  const name = cleanName(input.name);
  const prompt = cleanPrompt(input.prompt);
  const schedule = parseSchedule(input);
  if (!userId || !name || !prompt || !schedule) return "invalid";
  const sql = await pg();
  const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM automations WHERE user_id = ${userId}`;
  if (Number(count) >= MAX_AUTOMATIONS) return "full";
  const now = Date.now();
  const id = `auto_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await sql`
    INSERT INTO automations (id, user_id, name, prompt, matter_id, frequency, time_of_day, weekday, is_active, next_run_at, created_at, updated_at)
    VALUES (${id}, ${userId}, ${name}, ${prompt}, ${input.matterId ?? null}, ${schedule.frequency}, ${schedule.time}, ${schedule.weekday}, TRUE, ${nextRunAfter(schedule, now)}, ${now}, ${now})`;
  return (await getAutomation(userId, id)) ?? "missing";
}

export async function updateAutomation(
  userId: string,
  id: string,
  patch: { name?: unknown; prompt?: unknown; matterId?: string | null; frequency?: unknown; time?: unknown; weekday?: unknown },
): Promise<SaveResult> {
  const current = await loadStored(userId, id);
  if (!current) return "missing";
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const prompt = patch.prompt === undefined ? current.prompt : cleanPrompt(patch.prompt);
  const schedule = parseSchedule({
    frequency: patch.frequency === undefined ? current.frequency : patch.frequency,
    time: patch.time === undefined ? current.time : patch.time,
    weekday: patch.weekday === undefined ? current.weekday : patch.weekday,
  });
  if (!name || !prompt || !schedule) return "invalid";
  const matterId = patch.matterId === undefined ? current.matterId : patch.matterId;
  const now = Date.now();
  const next = current.active ? nextRunAfter(schedule, now) : null;
  const sql = await pg();
  await sql`
    UPDATE automations SET name = ${name}, prompt = ${prompt}, matter_id = ${matterId}, frequency = ${schedule.frequency},
      time_of_day = ${schedule.time}, weekday = ${schedule.weekday}, next_run_at = ${next}, updated_at = ${now}
    WHERE id = ${id} AND user_id = ${userId}`;
  return (await getAutomation(userId, id)) ?? "missing";
}

/** Pauses or resumes. Resuming schedules the next run from now, so a long pause never causes a burst of runs. */
export async function setActive(userId: string, id: string, active: boolean): Promise<Automation | null> {
  const current = await loadStored(userId, id);
  if (!current) return null;
  const now = Date.now();
  const next = active ? nextRunAfter({ frequency: current.frequency, time: current.time, weekday: current.weekday }, now) : null;
  const sql = await pg();
  await sql`UPDATE automations SET is_active = ${active}, next_run_at = ${next}, updated_at = ${now} WHERE id = ${id} AND user_id = ${userId}`;
  return getAutomation(userId, id);
}

export async function deleteAutomation(userId: string, id: string): Promise<boolean> {
  if (!userId) return false;
  const sql = await pg();
  const rows = await sql`DELETE FROM automations WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}

export async function listRuns(userId: string, automationId: string, limit = RUN_HISTORY): Promise<Run[]> {
  if (!userId) return [];
  const sql = await pg();
  const rows = await sql<RunRow[]>`
    SELECT id, automation_id, conversation_id, status, error, trigger, started_at, finished_at FROM automation_runs
    WHERE automation_id = ${automationId} AND user_id = ${userId} ORDER BY started_at DESC LIMIT ${limit}`;
  return rows.map(toRun);
}

// ---------------- Running ----------------

async function beginRun(auto: Stored, trigger: RunTrigger): Promise<Run> {
  const sql = await pg();
  const id = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const startedAt = Date.now();
  await sql`
    INSERT INTO automation_runs (id, automation_id, user_id, status, trigger, started_at)
    VALUES (${id}, ${auto.id}, ${auto.userId}, 'running', ${trigger}, ${startedAt})`;
  return { id, automationId: auto.id, conversationId: null, status: "running", error: null, trigger, startedAt, finishedAt: null };
}

/** Opens a chat and asks the assistant the saved prompt. Records how it ended; never throws. */
async function performRun(auto: Stored, run: Run): Promise<Run> {
  const sql = await pg();
  let conversationId: string | null = null;
  let status: RunStatus = "success";
  let error: string | null = null;
  try {
    const day = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    const conversation = await createConversation(DEFAULT_VAKIL, `${auto.name} · ${day}`.slice(0, 120), auto.userId, undefined, auto.matterId);
    conversationId = conversation.id;
    await sendMessage(DEFAULT_VAKIL, auto.prompt, auto.userId, conversation.id);
  } catch (err) {
    status = "error";
    error = (err instanceof Error ? err.message : "The run failed.").slice(0, 300);
    console.error("[automations] run failed:", auto.id, error);
  }
  const finishedAt = Date.now();
  await sql`
    UPDATE automation_runs SET status = ${status}, error = ${error}, conversation_id = ${conversationId}, finished_at = ${finishedAt}
    WHERE id = ${run.id}`.catch((err) => console.error("[automations] could not record the run:", err));
  return { ...run, status, error, conversationId, finishedAt };
}

async function executeRun(auto: Stored, trigger: RunTrigger): Promise<Run> {
  return performRun(auto, await beginRun(auto, trigger));
}

/**
 * "Run now": starts a run in the background and returns it at once, still "running".
 * Refuses while a run of the same automation is already going.
 */
export async function runNow(userId: string, id: string): Promise<Run | "missing" | "busy"> {
  const auto = await loadStored(userId, id);
  if (!auto) return "missing";
  const sql = await pg();
  const busy = await sql`SELECT 1 FROM automation_runs WHERE automation_id = ${id} AND status = 'running' AND started_at > ${Date.now() - STALE_RUN_MS}`;
  if (busy.length) return "busy";
  const run = await beginRun(auto, "manual");
  void performRun(auto, run);
  return run;
}

type Runner = (auto: Stored, trigger: RunTrigger) => Promise<unknown>;

/**
 * Runs what is due. Each automation is claimed with a compare-and-swap on its next-run time, so two server
 * processes (or two overlapping checks) can never run the same one twice. After a long outage a missed
 * automation runs once and is then set to its next future time, not once per missed day.
 */
export async function runDueAutomations(now = Date.now(), runner: Runner = executeRun, only: { userId?: string } = {}): Promise<number> {
  const sql = await pg();
  // `only.userId` lets tests look at one user's automations and nobody else's.
  const owner = only.userId ?? null;
  const due = await sql<Row[]>`
    SELECT * FROM automations WHERE is_active AND next_run_at IS NOT NULL AND next_run_at <= ${now}
      AND (${owner}::text IS NULL OR user_id = ${owner})
    ORDER BY next_run_at LIMIT ${DUE_BATCH}`;
  let ran = 0;
  for (const row of due) {
    const stored = toStored(row);
    const next = nextRunAfter(scheduleOf(row), now);
    const claimed = await sql`
      UPDATE automations SET next_run_at = ${next}, last_run_at = ${now}
      WHERE id = ${row.id} AND is_active AND next_run_at = ${row.next_run_at}
      RETURNING id`;
    if (!claimed.length) continue;
    ran++;
    try {
      await runner(stored, "schedule");
    } catch (err) {
      console.error("[automations] scheduled run failed:", row.id, err);
    }
  }
  return ran;
}

/** Marks runs that were still "running" long ago (a restart cut them off) as failed. */
export async function recoverInterruptedRuns(now = Date.now()): Promise<number> {
  const sql = await pg();
  const rows = await sql`
    UPDATE automation_runs SET status = 'error', error = 'Interrupted before it finished.', finished_at = ${now}
    WHERE status = 'running' AND started_at < ${now - STALE_RUN_MS} RETURNING id`;
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** Starts checking for due automations every half minute. Called once by the server, never by tests. */
export function startAutomationScheduler(): () => void {
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (timer) return stop;
  void recoverInterruptedRuns().catch((err) => console.error("[automations] recovery failed:", err));
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    runDueAutomations()
      .catch((err) => console.error("[automations] scheduler check failed:", err))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref();
  console.log("[automations] scheduler started");
  return stop;
}
