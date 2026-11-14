import { pgData } from "../data/pg.js";

/**
 * Small per-user settings that used to live in the browser (so they were lost on a new device and could
 * leak between people sharing one). Only known keys are accepted, each with its own validation.
 */
type Validator = (value: unknown) => unknown | undefined;

const VALIDATORS: Record<string, Validator> = {
  /** When the user last read each Vakil's chats: { [vakilId]: epoch ms }. Drives the unread markers. */
  lastRead: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 200) return undefined;
    const clean: Record<string, number> = {};
    for (const [key, v] of entries) {
      if (typeof v !== "number" || !Number.isFinite(v) || key.length > 100) return undefined;
      clean[key] = v;
    }
    return clean;
  },
  /** Width in pixels of the document preview beside a chat. */
  artifactBoardWidth: (value) => (typeof value === "number" && Number.isFinite(value) && value >= 280 && value <= 2400 ? Math.round(value) : undefined),
};

export const PREFERENCE_KEYS = Object.keys(VALIDATORS);

export function validatePreference(key: string, value: unknown): unknown | undefined {
  return VALIDATORS[key]?.(value);
}

export async function getPreferences(userId: string): Promise<Record<string, unknown>> {
  if (!userId) return {};
  const sql = await pgData();
  const rows = await sql`SELECT key, value FROM user_preferences WHERE user_id = ${userId}`;
  const out: Record<string, unknown> = {};
  for (const row of rows) if (row.key in VALIDATORS) out[row.key as string] = row.value;
  return out;
}

export async function setPreference(userId: string, key: string, value: unknown): Promise<boolean> {
  const valid = validatePreference(key, value);
  if (!userId || valid === undefined) return false;
  const sql = await pgData();
  await sql`
    INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (${userId}, ${key}, ${sql.json(valid as never)}, ${Date.now()})
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
  return true;
}
