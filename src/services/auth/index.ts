import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config, isProduction } from "../../config.js";
import { clearLoginFailures, isLoginBlocked, recordLoginFailure } from "./attempts.js";
import {
  findUserByEmail,
  insertUser,
  insertSession,
  findValidSession,
  deleteSession,
  type UserRow,
} from "../db/postgres.js";

const SALT_ROUNDS = 12;
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

export class AuthError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

function encodeSecret(): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export async function signSessionToken(input: {
  userId: string;
  sessionId: string;
  maxAgeSeconds?: number;
}): Promise<string> {
  const maxAge = input.maxAgeSeconds || DEFAULT_MAX_AGE_SECONDS;
  const expiresInSeconds = Math.floor(Date.now() / 1000) + maxAge;

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setJti(input.sessionId)
    .setIssuedAt()
    .setExpirationTime(expiresInSeconds)
    .sign(encodeSecret());
}

export async function verifySessionToken(token: string): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(), {
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.jti };
  } catch {
    return null;
  }
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Constant-time check of a signup invite code against the configured list. */
function inviteCodeValid(code: string): boolean {
  const given = Buffer.from(code.trim());
  return config.signupInviteCodes.some((valid) => {
    const expected = Buffer.from(valid);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

/** Whether a signup gate (invite code or email domain) is configured at all. */
export function signupGateConfigured(): boolean {
  return config.signupInviteCodes.length > 0 || config.signupAllowedDomains.length > 0;
}

function assertSignupAllowed(email: string, inviteCode: string) {
  if (config.signupInviteCodes.length > 0) {
    if (!inviteCodeValid(inviteCode)) throw new AuthError(403, "A valid invite code is required to create an account.");
    return;
  }
  if (config.signupAllowedDomains.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!config.signupAllowedDomains.includes(domain)) {
      throw new AuthError(403, "Accounts are limited to approved firm email domains.");
    }
  }
}

function assertPasswordStrong(password: string) {
  if (password.length < 8) throw new AuthError(400, "Password must be at least 8 characters long.");
  if (password.length > 128) throw new AuthError(400, "Password must be at most 128 characters long.");
  if (!/[A-Za-z]/.test(password)) throw new AuthError(400, "Password must contain at least one letter.");
  if (!/[0-9]/.test(password)) throw new AuthError(400, "Password must contain at least one number.");
}

async function startSession(userRow: UserRow): Promise<AuthSessionResult> {
  const expiresAt = new Date(Date.now() + DEFAULT_MAX_AGE_SECONDS * 1000);
  const sessionRow = await insertSession({ userId: userRow.id, expiresAt });
  const token = await signSessionToken({
    userId: userRow.id,
    sessionId: sessionRow.id,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  });
  return { user: toPublicUser(userRow), token, expiresAt: expiresAt.toISOString() };
}

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  inviteCode?: string;
}): Promise<AuthSessionResult> {
  const email = (input.email || "").trim().toLowerCase();
  const name = (input.name || "").trim();
  const password = input.password || "";

  if (!EMAIL_RE.test(email) || email.length > 254) throw new AuthError(400, "Valid email is required.");
  if (name.length < 2 || name.length > 100) throw new AuthError(400, "Name must be between 2 and 100 characters.");
  assertPasswordStrong(password);
  assertSignupAllowed(email, input.inviteCode || "");

  const existing = await findUserByEmail(email);
  if (existing) {
    throw new AuthError(409, "An account with this email already exists.");
  }

  // ADMIN_EMAILS grants the admin role at signup. Email addresses are not verified, so in
  // production that only applies when signup is gated (invite code or approved domain).
  const isAdmin = config.adminEmails.includes(email) && (signupGateConfigured() || !isProduction);
  const role: "admin" | "user" = isAdmin ? "admin" : "user";

  const passwordHash = await hashPassword(password);
  const userRow = await insertUser({ name, email, passwordHash, role });
  return startSession(userRow);
}

// A real bcrypt hash compared when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomUUID(), SALT_ROUNDS);

export async function loginUser(input: {
  email: string;
  password: string;
  /** The visitor's address, so a guesser is blocked without locking the real owner out. */
  ip?: string;
}): Promise<AuthSessionResult> {
  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";

  if (!email || !password || password.length > 128) {
    throw new AuthError(400, "Email and password are required.");
  }

  const ip = input.ip || "unknown";
  if (await isLoginBlocked(email, ip)) {
    throw new AuthError(429, "Too many failed sign-in attempts. Please try again in a few minutes.");
  }

  const userRow = await findUserByEmail(email);
  const isValid = await verifyPassword(password, userRow ? userRow.password_hash : DUMMY_HASH);
  if (!userRow || !isValid) {
    await recordLoginFailure(email, ip);
    throw new AuthError(401, "Invalid email or password.");
  }

  await clearLoginFailures(email, ip);
  return startSession(userRow);
}

export async function verifySession(token: string): Promise<PublicUser | null> {
  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const valid = await findValidSession(claims.sessionId, claims.userId);
  if (!valid) return null;

  return toPublicUser(valid.user);
}

export async function logoutSession(token: string): Promise<boolean> {
  const claims = await verifySessionToken(token);
  if (!claims) return true;

  await deleteSession(claims.sessionId);
  return true;
}
