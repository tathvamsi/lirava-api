import { pgData } from "../data/pg.js";
const VALIDATORS = {
    /** When the user last read each Vakil's chats: { [vakilId]: epoch ms }. Drives the unread markers. */
    lastRead: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const entries = Object.entries(value);
        if (entries.length > 200)
            return undefined;
        const clean = {};
        for (const [key, v] of entries) {
            if (typeof v !== "number" || !Number.isFinite(v) || key.length > 100)
                return undefined;
            clean[key] = v;
        }
        return clean;
    },
    /** Width in pixels of the document preview beside a chat. */
    artifactBoardWidth: (value) => (typeof value === "number" && Number.isFinite(value) && value >= 280 && value <= 2400 ? Math.round(value) : undefined),
};
export const PREFERENCE_KEYS = Object.keys(VALIDATORS);
export function validatePreference(key, value) {
    return VALIDATORS[key]?.(value);
}
export async function getPreferences(userId) {
    if (!userId)
        return {};
    const sql = await pgData();
    const rows = await sql `SELECT key, value FROM user_preferences WHERE user_id = ${userId}`;
    const out = {};
    for (const row of rows)
        if (row.key in VALIDATORS)
            out[row.key] = row.value;
    return out;
}
export async function setPreference(userId, key, value) {
    const valid = validatePreference(key, value);
    if (!userId || valid === undefined)
        return false;
    const sql = await pgData();
    await sql `
    INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (${userId}, ${key}, ${sql.json(valid)}, ${Date.now()})
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
    return true;
}
