import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verifySession } from "../services/auth/index.js";
export const SESSION_COOKIE_NAME = "soli_session";
/** Session token from `Authorization: Bearer`, `x-session-token`, or the `soli_session` cookie. */
export function sessionTokenFrom(c) {
    const header = c.req.header("authorization");
    if (header?.toLowerCase().startsWith("bearer "))
        return header.slice(7).trim() || null;
    const custom = c.req.header("x-session-token");
    if (custom)
        return custom.trim() || null;
    return getCookie(c, SESSION_COOKIE_NAME) || null;
}
/**
 * Requires a valid, unrevoked session (the JWT is checked against the sessions
 * table) and exposes the user as `c.get("user")`. Handlers must take the user
 * id from here and never from the request body or query string.
 */
export const requireAuth = createMiddleware(async (c, next) => {
    const token = sessionTokenFrom(c);
    const user = token ? await verifySession(token).catch(() => null) : null;
    if (!user)
        return c.json({ error: "Sign in required." }, 401);
    c.set("user", user);
    await next();
});
