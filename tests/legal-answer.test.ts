import { test } from "node:test";
import assert from "node:assert";
import app from "../src/index.js";

test("Legal Answer API via soli-backend", async () => {
  const res = await app.request("/api/legal/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "What is Section 482 of BNSS?",
    }),
  });

  assert.strictEqual(res.status, 200, "Should return 200 OK");
  const data = await res.json();
  assert.ok(data.answer, "Should contain answer text");
  assert.ok(Array.isArray(data.citations), "Should contain citations array");
  assert.ok(data.confidence > 0, "Should have positive confidence");
});
