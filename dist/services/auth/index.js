import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../../config.js";
import { findUserByEmail, insertUser, insertSession, findValidSession, deleteSession, } from "../db/postgres.js";
const SALT_ROUNDS = 12;
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days
function encodeSecret() {
    return new TextEncoder().encode(config.sessionSecret);
}
export async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}
export async function verifyPassword(password, hash) {
    try {
        return await bcrypt.compare(password, hash);
    }
    catch {
        return false;
    }
}
export async function signSessionToken(input) {
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
export async function verifySessionToken(token) {
    try {
        const { payload } = await jwtVerify(token, encodeSecret(), {
            algorithms: ["HS256"],
        });
        if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
            return null;
        }
        return { userId: payload.sub, sessionId: payload.jti };
    }
    catch {
        return null;
    }
}
function toPublicUser(row) {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
export async function registerUser(input) {
    const email = (input.email || "").trim().toLowerCase();
    const name = (input.name || "").trim();
    const password = input.password || "";
    if (!email || !email.includes("@")) {
        throw new Error("Valid email is required.");
    }
    if (!name) {
        throw new Error("Full name is required.");
    }
    if (password.length < 8) {
        throw new Error("Password must be at least 8 characters long.");
    }
    // Check existing user
    const existing = await findUserByEmail(email);
    if (existing) {
        throw new Error("An account with this email already exists.");
    }
    // Determine role: admins configured via ADMIN_EMAILS
    const isAdmin = config.adminEmails.includes(email);
    const role = isAdmin ? "admin" : "user";
    const passwordHash = await hashPassword(password);
    const userRow = await insertUser({
        name,
        email,
        passwordHash,
        role,
    });
    // Create session
    const expiresAt = new Date(Date.now() + DEFAULT_MAX_AGE_SECONDS * 1000);
    const sessionRow = await insertSession({
        userId: userRow.id,
        expiresAt,
    });
    const token = await signSessionToken({
        userId: userRow.id,
        sessionId: sessionRow.id,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    });
    return {
        user: toPublicUser(userRow),
        token,
        expiresAt: expiresAt.toISOString(),
    };
}
export async function loginUser(input) {
    const email = (input.email || "").trim().toLowerCase();
    const password = input.password || "";
    if (!email || !password) {
        throw new Error("Email and password are required.");
    }
    const userRow = await findUserByEmail(email);
    if (!userRow) {
        throw new Error("Invalid email or password.");
    }
    const isValid = await verifyPassword(password, userRow.password_hash);
    if (!isValid) {
        throw new Error("Invalid email or password.");
    }
    // Create session
    const expiresAt = new Date(Date.now() + DEFAULT_MAX_AGE_SECONDS * 1000);
    const sessionRow = await insertSession({
        userId: userRow.id,
        expiresAt,
    });
    const token = await signSessionToken({
        userId: userRow.id,
        sessionId: sessionRow.id,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    });
    return {
        user: toPublicUser(userRow),
        token,
        expiresAt: expiresAt.toISOString(),
    };
}
export async function verifySession(token) {
    const claims = await verifySessionToken(token);
    if (!claims)
        return null;
    const valid = await findValidSession(claims.sessionId, claims.userId);
    if (!valid)
        return null;
    return toPublicUser(valid.user);
}
export async function logoutSession(token) {
    const claims = await verifySessionToken(token);
    if (!claims)
        return true;
    await deleteSession(claims.sessionId);
    return true;
}
