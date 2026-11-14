import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../middleware/auth.js";
import { PREFERENCE_KEYS, getPreferences, setPreference } from "../services/preferences/index.js";

export const preferencesRoutes = new Hono<AuthEnv>();

preferencesRoutes.use("*", requireAuth);

preferencesRoutes.get("/", async (c) => c.json({ preferences: await getPreferences(c.get("user").id) }));

preferencesRoutes.put("/:key", async (c) => {
  const key = c.req.param("key");
  if (!PREFERENCE_KEYS.includes(key)) return c.json({ error: "Unknown preference." }, 404);
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  if (!(await setPreference(c.get("user").id, key, body?.value))) return c.json({ error: "Invalid value." }, 400);
  return c.json({ success: true });
});
