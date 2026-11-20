process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";

const OLD = "Password123!Secure";
const NEW = "BrandNew2026pass";

const send = (user: Pick<TestUser, "headers">, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: user.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const signIn = (email: string, password: string) =>
  app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });

describe("account: profile", () => {
  it("changes the display name, and refuses a name that is too short or missing", async () => {
    const user = await createTestUser("acct_name");
    const ok = await send(user, "PATCH", "/api/auth/profile", { name: "  Adv. Meera Rao " });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.name, "Adv. Meera Rao");

    const me = await (await send(user, "GET", "/api/auth/me")).json();
    assert.equal(me.user.name, "Adv. Meera Rao");

    assert.equal((await send(user, "PATCH", "/api/auth/profile", { name: "A" })).status, 400);
    assert.equal((await send(user, "PATCH", "/api/auth/profile", { name: "x".repeat(101) })).status, 400);
    assert.equal((await send(user, "PATCH", "/api/auth/profile", {})).status, 400);
  });

  it("needs a signed-in session", async () => {
    const res = await app.request("/api/auth/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nobody" }) });
    assert.equal(res.status, 401);
    const bad = await app.request("/api/auth/profile", { method: "PATCH", headers: { Authorization: "Bearer not-a-token", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nobody" }) });
    assert.equal(bad.status, 401);
  });
});

describe("account: password", () => {
  it("checks the current password and the strength of the new one before changing anything", async () => {
    const user = await createTestUser("acct_pw_checks");
    // A wrong current password is a 403 (not 401), so the browser does not treat it as an expired session.
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: "wrong-password1", newPassword: NEW })).status, 403);
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: "short1" })).status, 400);
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: "alllettersnonumber" })).status, 400);
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: "1234567890123" })).status, 400);
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: OLD })).status, 400);
    assert.equal((await send(user, "POST", "/api/auth/password", { currentPassword: "", newPassword: NEW })).status, 400);
    assert.equal((await send(user, "POST", "/api/auth/password", {})).status, 400);

    // Nothing above changed the password.
    assert.equal((await signIn(user.email, OLD)).status, 200);
  });

  it("changes it, keeps this session, and signs every other device out", async () => {
    const user = await createTestUser("acct_pw_change");
    const other = await (await signIn(user.email, OLD)).json();
    const otherHeaders = { headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" } };
    assert.equal((await send(otherHeaders, "GET", "/api/auth/me")).status, 200, "the other device is signed in");

    const res = await send(user, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: NEW });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.otherSessionsEnded, 1);

    assert.equal((await send(user, "GET", "/api/auth/me")).status, 200, "this session stays signed in");
    assert.equal((await send(otherHeaders, "GET", "/api/auth/me")).status, 401, "the other device is signed out");
    assert.equal((await signIn(user.email, OLD)).status, 401, "the old password no longer works");
    assert.equal((await signIn(user.email, NEW)).status, 200, "the new password works");
  });

  it("needs a signed-in session, and never changes someone else's password", async () => {
    const alice = await createTestUser("acct_pw_alice");
    const bob = await createTestUser("acct_pw_bob");
    const anon = await app.request("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: OLD, newPassword: NEW }) });
    assert.equal(anon.status, 401);

    // Bob's session can only ever act on Bob, even if the request names Alice's email.
    assert.equal((await send(bob, "POST", "/api/auth/password", { currentPassword: OLD, newPassword: NEW, email: alice.email })).status, 200);
    assert.equal((await signIn(alice.email, OLD)).status, 200);
    assert.equal((await signIn(bob.email, NEW)).status, 200);
  });
});
