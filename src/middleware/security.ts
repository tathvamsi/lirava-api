import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { config } from "../config.js";
import type { AuthEnv } from "./auth.js";

/** Only the web app calls this service, so its forwarded client address can be trusted when configured. */
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";

export function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress || "unknown";
}

// ---------------- Rate limiting ----------------

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter held in memory. Good for a single backend instance; run more than
 * one instance and the limits become per-instance (move the counters to Postgres/Redis then).
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private limit: number,
    private windowMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.sweeper.unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }

  /** Records a hit and returns whether the caller is still within the limit. */
  hit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return { allowed: bucket.count <= this.limit, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  /** Whether the key is over the limit, without counting a new hit. */
  isBlocked(key: string): { blocked: boolean; retryAfterSec: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= Date.now()) return { blocked: false, retryAfterSec: 0 };
    return { blocked: bucket.count >= this.limit, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) };
  }

  reset(key: string) {
    this.buckets.delete(key);
  }
}

/** Rate-limits a route group by client address. */
export function rateLimit(name: string, limit: number, windowMs: number) {
  const limiter = new RateLimiter(limit, windowMs);
  return createMiddleware(async (c, next) => {
    if (config.nodeEnv === "test") return next();
    const result = limiter.hit(`${name}:${clientIp(c)}`);
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.json({ error: "Too many requests. Please try again shortly." }, 429);
    }
    await next();
  });
}

// ---------------- Authorization ----------------

/** Use after requireAuth: only administrators may continue. */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") return c.json({ error: "Administrator access required." }, 403);
  await next();
});

// ---------------- CORS ----------------

/** Browsers may call this service only from configured origins (and loopback in development). */
export function corsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const clean = origin.replace(/\/$/, "");
  if (config.corsOrigins.includes(clean)) return origin;
  if (config.nodeEnv !== "production") {
    try {
      const host = new URL(clean).hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return origin;
    } catch {
      return null;
    }
  }
  return null;
}
