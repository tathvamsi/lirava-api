import { Hono } from "hono";
import {
  registerUser,
  loginUser,
  verifySession,
  logoutSession,
} from "../services/auth/index.js";

export const authRoutes = new Hono();

function extractToken(c: any): string | null {
  const authHeader = c.req.header("Authorization") || c.req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const customHeader = c.req.header("x-session-token") || c.req.header("x-soli-auth");
  if (customHeader) {
    return customHeader.trim();
  }
  return null;
}

// User Registration
authRoutes.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const result = await registerUser({
      name: body.name,
      email: body.email,
      password: body.password,
      inviteCode: body.inviteCode,
    });
    return c.json(result, 201);
  } catch (err: any) {
    const status = err.message.includes("already exists") ? 409 : 400;
    return c.json({ error: err.message || "Registration failed" }, status);
  }
});

// User Login
authRoutes.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const result = await loginUser({
      email: body.email,
      password: body.password,
    });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || "Invalid credentials" }, 401);
  }
});

// Current User Profile
authRoutes.get("/me", async (c) => {
  const token = extractToken(c);
  if (!token) {
    return c.json({ error: "Missing authorization token" }, 401);
  }

  const user = await verifySession(token);
  if (!user) {
    return c.json({ error: "Session expired or invalid" }, 401);
  }

  return c.json({ user });
});

// Verify Session Token
authRoutes.post("/verify", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const token = body.token || extractToken(c);
    if (!token) {
      return c.json({ error: "Token required" }, 400);
    }

    const user = await verifySession(token);
    if (!user) {
      return c.json({ valid: false, user: null }, 401);
    }

    return c.json({ valid: true, user });
  } catch (err: any) {
    return c.json({ valid: false, error: err.message }, 500);
  }
});

// User Logout
authRoutes.post("/logout", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const token = body.token || extractToken(c);
    if (token) {
      await logoutSession(token);
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
