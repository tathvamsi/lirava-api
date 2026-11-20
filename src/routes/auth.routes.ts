import { Hono } from "hono";
import {
  AuthError,
  registerUser,
  loginUser,
  verifySession,
  verifySessionToken,
  logoutSession,
  updateProfile,
  changePassword,
} from "../services/auth/index.js";
import { sessionTokenFrom } from "../middleware/auth.js";
import { clientIp, rateLimit } from "../middleware/security.js";

export const authRoutes = new Hono();

function failure(c: { json: (body: unknown, status?: any) => Response }, err: unknown, fallback: string) {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  console.error("[auth]", err);
  return c.json({ error: fallback }, 500);
}

// Brute-force and signup-spam protection (per client address).
authRoutes.use("/login", rateLimit("login", 30, 15 * 60 * 1000));
authRoutes.use("/register", rateLimit("register", 10, 60 * 60 * 1000));
// A signed-in session could otherwise be used to guess the current password.
authRoutes.use("/password", rateLimit("password", 10, 15 * 60 * 1000));

// User Registration
authRoutes.post("/register", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await registerUser({
      name: typeof body.name === "string" ? body.name : "",
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
      inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : "",
    });
    return c.json(result, 201);
  } catch (err) {
    return failure(c, err, "Registration failed");
  }
});

// User Login
authRoutes.post("/login", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await loginUser({
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
      ip: clientIp(c),
    });
    return c.json(result);
  } catch (err) {
    return failure(c, err, "Sign-in failed");
  }
});

// Current User Profile
authRoutes.get("/me", async (c) => {
  const token = sessionTokenFrom(c);
  if (!token) {
    return c.json({ error: "Missing authorization token" }, 401);
  }

  const user = await verifySession(token).catch(() => null);
  if (!user) {
    return c.json({ error: "Session expired or invalid" }, 401);
  }

  return c.json({ user });
});

// Verify Session Token
authRoutes.post("/verify", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const token = (typeof body.token === "string" && body.token) || sessionTokenFrom(c);
    if (!token) {
      return c.json({ error: "Token required" }, 400);
    }

    const user = await verifySession(token);
    if (!user) {
      return c.json({ valid: false, user: null }, 401);
    }

    return c.json({ valid: true, user });
  } catch (err) {
    console.error("[auth] verify failed:", err);
    return c.json({ valid: false, error: "Verification failed" }, 500);
  }
});

/** The signed-in user and the id of the session they are using, or null. */
async function currentSession(c: Parameters<typeof sessionTokenFrom>[0]) {
  const token = sessionTokenFrom(c);
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims) return null;
  const user = await verifySession(token).catch(() => null);
  return user ? { user, sessionId: claims.sessionId } : null;
}

// Change display name
authRoutes.patch("/profile", async (c) => {
  const session = await currentSession(c);
  if (!session) return c.json({ error: "Sign in required." }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const user = await updateProfile(session.user.id, { name: typeof body.name === "string" ? body.name : "" });
    return c.json({ user });
  } catch (err) {
    return failure(c, err, "Could not update your profile.");
  }
});

// Change password (checks the current one, then signs out every other device)
authRoutes.post("/password", async (c) => {
  const session = await currentSession(c);
  if (!session) return c.json({ error: "Sign in required." }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await changePassword({
      email: session.user.email,
      currentSessionId: session.sessionId,
      currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : "",
      newPassword: typeof body.newPassword === "string" ? body.newPassword : "",
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    return failure(c, err, "Could not change your password.");
  }
});

// User Logout
authRoutes.post("/logout", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const token = (typeof body.token === "string" && body.token) || sessionTokenFrom(c);
    if (token) {
      await logoutSession(token);
    }
    return c.json({ success: true });
  } catch (err) {
    console.error("[auth] logout failed:", err);
    return c.json({ error: "Logout failed" }, 500);
  }
});
