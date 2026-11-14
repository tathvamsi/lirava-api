process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import app from "../src/index.js";
import { createTestAdmin, createTestUser, type TestUser } from "./helpers.js";
import { deleteAct, pointId } from "../src/services/admin/corpus.js";
import { upsertProvisions } from "../src/services/legal/provisions.js";

const RUN = Date.now();
const ACT = `Test Act ${RUN}`;

describe("corpus and user tools for the admin app", () => {
  let admin: TestUser;
  let member: TestUser;
  const call = (u: TestUser, path: string, init: RequestInit = {}) => app.request(`/api/admin${path}`, { ...init, headers: { ...u.headers, ...(init.headers || {}) } });

  before(async () => {
    admin = await createTestAdmin("corpus_admin");
    member = await createTestUser("corpus_member");
    await upsertProvisions({
      act: ACT,
      year: 2024,
      source: "test",
      sections: [
        { section: "1", title: "Short title", text: "This Act may be called the Test Act and applies to the whole of India." },
        { section: "2", title: "Definitions", text: "In this Act the word zebracrossing means a marked pedestrian crossing." },
      ],
    });
  });

  after(async () => {
    await deleteAct(ACT);
  });

  it("is closed to people who are not administrators", async () => {
    for (const path of ["/corpus/stats", "/corpus/acts", "/users", "/system"]) {
      assert.equal((await call(member, path)).status, 403, path);
    }
    assert.equal((await app.request("/api/admin/corpus/stats")).status, 401);
  });

  it("lists Acts and sections, and edits and removes a section", async () => {
    const acts = (await (await call(admin, "/corpus/acts")).json()).acts as Array<{ act: string; sections: number; indexed: number }>;
    const mine = acts.find((a) => a.act === ACT);
    assert.equal(mine?.sections, 2);
    assert.equal(mine?.indexed, 0, "not in the vector index yet");

    const list = await (await call(admin, `/corpus/provisions?act=${encodeURIComponent(ACT)}`)).json();
    assert.equal(list.total, 2);
    const second = list.provisions.find((p: any) => p.section === "Section 2");

    const searched = await (await call(admin, `/corpus/provisions?q=zebracrossing`)).json();
    assert.ok(searched.provisions.some((p: any) => p.id === second.id));

    const edited = await call(admin, `/corpus/provisions/${second.id}`, { method: "PATCH", body: JSON.stringify({ title: "Meanings", text: "In this Act a zebracrossing is a marked crossing for walkers." }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).provision.title, "Meanings");
    assert.equal((await call(admin, `/corpus/provisions/${second.id}`, { method: "PATCH", body: JSON.stringify({ text: "x" }) })).status, 400, "too short");

    assert.equal((await call(admin, `/corpus/provisions/${second.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await call(admin, `/corpus/provisions/${second.id}`)).status, 404);
  });

  it("shows how a file would be split without storing it", async () => {
    const text = "CHAPTER I\n1. Short title. This Act may be called the Sample Act and extends to the whole of India.\n2. Definitions. In this Act, unless the context otherwise requires, the words used have the meanings given here.\n";
    const form = new FormData();
    form.append("file", new File([text], "sample.txt", { type: "text/plain" }));
    const res = await app.request("/api/admin/corpus/preview", { method: "POST", headers: { Authorization: admin.headers.Authorization }, body: form });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.equal(body.sections[0].section, "1");
    const acts = (await (await call(admin, "/corpus/acts")).json()).acts as Array<{ act: string }>;
    assert.ok(!acts.some((a) => /Sample Act/.test(a.act)), "nothing was stored");
  });

  it("lists users with counts, and signs a user out everywhere", async () => {
    const users = (await (await call(admin, `/users?q=${encodeURIComponent(member.email)}`)).json()).users as Array<{ id: string; email: string; activeSessions: number }>;
    const me = users.find((u) => u.email === member.email);
    assert.ok(me && me.activeSessions >= 1);
    assert.equal(JSON.stringify(users).includes("password"), false, "no password data");

    const revoke = await call(admin, `/users/${me!.id}/revoke-sessions`, { method: "POST" });
    assert.equal((await revoke.json()).revoked >= 1, true);
    assert.equal((await app.request("/api/auth/me", { headers: member.headers })).status, 401, "their session no longer works");
  });

  it("reports the provider without exposing keys", async () => {
    const body = await (await call(admin, "/system")).json();
    assert.ok(["own server", "NVIDIA NIM"].includes(body.provider));
    const text = JSON.stringify(body);
    assert.equal(text.includes(process.env.NVIDIA_API_KEY || "no-key-set"), false);
  });

  it("gives every provision a stable vector id", () => {
    assert.equal(pointId("abc"), pointId("abc"));
    assert.notEqual(pointId("abc"), pointId("abd"));
    assert.match(pointId("abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
