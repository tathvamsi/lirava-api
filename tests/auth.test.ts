import { test } from "node:test";
import assert from "node:assert";
import app from "../src/index.js";

test("Auth Flow: register, login, me, and logout via soli-backend", async () => {
  const testEmail = `test_${Date.now()}@example.com`;
  const testPassword = "Password123!Secure";
  const testName = "Advocate Test";

  // 1. Register new user
  const regRes = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: testName,
      email: testEmail,
      password: testPassword,
    }),
  });

  assert.strictEqual(regRes.status, 201, "Register should return 201 Created");
  const regBody = await regRes.json();
  assert.ok(regBody.token, "Should return session token");
  assert.strictEqual(regBody.user.email, testEmail.toLowerCase());
  assert.strictEqual(regBody.user.name, testName);

  // 2. Reject duplicate registration
  const dupRes = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: testName,
      email: testEmail,
      password: testPassword,
    }),
  });
  assert.strictEqual(dupRes.status, 409, "Duplicate registration should return 409");

  // 3. Login with credentials
  const loginRes = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
    }),
  });

  assert.strictEqual(loginRes.status, 200, "Login should return 200");
  const loginBody = await loginRes.json();
  assert.ok(loginBody.token, "Login should return session token");
  assert.strictEqual(loginBody.user.email, testEmail.toLowerCase());

  const token = loginBody.token;

  // 4. Verify session via /api/auth/me
  const meRes = await app.request("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(meRes.status, 200, "Should return 200 for valid token");
  const meBody = await meRes.json();
  assert.strictEqual(meBody.user.id, loginBody.user.id);
  assert.strictEqual(meBody.user.email, testEmail.toLowerCase());

  // 5. Verify token via /api/auth/verify
  const verifyRes = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.strictEqual(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.strictEqual(verifyBody.valid, true);

  // 6. Logout
  const logoutRes = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(logoutRes.status, 200);

  // 7. Verify session is revoked after logout
  const revokedRes = await app.request("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(revokedRes.status, 401, "Revoked session should return 401");

  const { closeSql } = await import("../src/services/db/postgres.js");
  await closeSql();
});
