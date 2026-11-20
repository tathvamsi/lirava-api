process.env.NODE_ENV = "test";

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createTestUser, type TestUser } from "./helpers.js";
import { createMatter } from "../src/services/repo/index.js";
import { getSql } from "../src/services/db/postgres.js";
import { MAX_AUTOMATIONS, runDueAutomations } from "../src/services/automations/index.js";
import { describeSchedule, nextRunAfter, parseSchedule } from "../src/services/automations/schedule.js";

const json = (user: TestUser, method: string, body?: unknown) => ({ method, headers: user.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ist = (iso: string) => Date.parse(`${iso}+05:30`);
const daily = { frequency: "daily" as const, time: "09:00", weekday: 1 };

describe("schedules (Indian Standard Time)", () => {
  it("finds the next daily run, strictly after the given moment", () => {
    assert.equal(nextRunAfter(daily, ist("2024-01-05T08:30:00")), ist("2024-01-05T09:00:00"));
    assert.equal(nextRunAfter(daily, ist("2024-01-05T09:30:00")), ist("2024-01-06T09:00:00"));
    assert.equal(nextRunAfter(daily, ist("2024-01-05T09:00:00")), ist("2024-01-06T09:00:00"), "exactly at the time means the next one");
  });

  it("skips the weekend for weekdays, and finds the right day for weekly", () => {
    // 2024-01-05 is a Friday.
    assert.equal(nextRunAfter({ ...daily, frequency: "weekdays" }, ist("2024-01-05T10:00:00")), ist("2024-01-08T09:00:00"));
    assert.equal(nextRunAfter({ ...daily, frequency: "weekdays" }, ist("2024-01-04T10:00:00")), ist("2024-01-05T09:00:00"));
    assert.equal(nextRunAfter({ frequency: "weekly", time: "18:30", weekday: 0 }, ist("2024-01-05T10:00:00")), ist("2024-01-07T18:30:00"));
    assert.equal(nextRunAfter({ frequency: "weekly", time: "09:00", weekday: 5 }, ist("2024-01-05T10:00:00")), ist("2024-01-12T09:00:00"), "same weekday but already past: next week");
  });

  it("gets the date right when IST and UTC are on different days", () => {
    // 00:15 IST is 18:45 UTC the evening before.
    assert.equal(nextRunAfter({ ...daily, time: "00:15" }, Date.parse("2024-01-05T18:50:00Z")), Date.parse("2024-01-06T18:45:00Z"));
    assert.equal(nextRunAfter({ ...daily, time: "23:30" }, Date.parse("2024-01-05T17:00:00Z")), Date.parse("2024-01-05T18:00:00Z"));
  });

  it("accepts only complete, valid schedules", () => {
    assert.deepEqual(parseSchedule({ frequency: "daily", time: "07:05" }), { frequency: "daily", time: "07:05", weekday: 1 });
    assert.deepEqual(parseSchedule({ frequency: "weekly", time: "10:00", weekday: 6 }), { frequency: "weekly", time: "10:00", weekday: 6 });
    assert.equal(parseSchedule({ frequency: "weekly", time: "10:00" }), null, "weekly needs a weekday");
    assert.equal(parseSchedule({ frequency: "weekly", time: "10:00", weekday: 7 }), null);
    assert.equal(parseSchedule({ frequency: "hourly", time: "10:00" }), null, "nothing more often than daily");
    assert.equal(parseSchedule({ frequency: "daily", time: "24:00" }), null);
    assert.equal(parseSchedule({ frequency: "daily", time: "9:00" }), null);
    assert.equal(parseSchedule({ frequency: "daily" }), null);
  });

  it("describes a schedule in plain words", () => {
    assert.equal(describeSchedule(daily), "Every day at 9:00 AM IST");
    assert.equal(describeSchedule({ frequency: "weekdays", time: "13:05", weekday: 1 }), "Every weekday at 1:05 PM IST");
    assert.equal(describeSchedule({ frequency: "weekly", time: "00:00", weekday: 0 }), "Every Sunday at 12:00 AM IST");
  });
});

describe("automations over HTTP", () => {
  let alice: TestUser;
  let bob: TestUser;
  before(async () => {
    alice = await createTestUser("auto_alice");
    bob = await createTestUser("auto_bob");
  });

  const make = async (user: TestUser, extra: Record<string, unknown> = {}) => {
    const res = await app.request("/api/automations", json(user, "POST", { name: "Morning brief", prompt: "Hello what is your name?", ...daily, ...extra }));
    assert.equal(res.status, 201);
    return (await res.json()).automation as { id: string; nextRunAt: number | null; active: boolean; schedule: string };
  };

  it("creates an automation scheduled for a future time, and lists it with a plain-words schedule", async () => {
    const a = await make(alice);
    assert.equal(a.active, true);
    assert.equal(a.schedule, "Every day at 9:00 AM IST");
    assert.ok(a.nextRunAt && a.nextRunAt > Date.now(), "the next run is in the future");
    const list = (await (await app.request("/api/automations", json(alice, "GET"))).json()).automations;
    assert.ok(list.some((x: { id: string }) => x.id === a.id));
  });

  it("refuses a missing name or prompt and any schedule that is not valid", async () => {
    const bad = (body: Record<string, unknown>) => app.request("/api/automations", json(alice, "POST", { name: "x", prompt: "y", ...daily, ...body }));
    assert.equal((await bad({ name: "  " })).status, 400);
    assert.equal((await bad({ prompt: "" })).status, 400);
    assert.equal((await bad({ frequency: "hourly" })).status, 400);
    assert.equal((await bad({ time: "25:00" })).status, 400);
    assert.equal((await bad({ frequency: "weekly", weekday: undefined })).status, 400, "weekly without a weekday");
    assert.equal((await bad({ frequency: "weekly", weekday: 9 })).status, 400);
  });

  it("changes the schedule and recalculates the next run; pausing clears it and resuming sets it again", async () => {
    const a = await make(alice);
    const edited = await app.request(`/api/automations/${a.id}`, json(alice, "PUT", { frequency: "weekly", time: "18:30", weekday: 3 }));
    assert.equal(edited.status, 200);
    const e = (await edited.json()).automation;
    assert.equal(e.schedule, "Every Wednesday at 6:30 PM IST");
    assert.ok(e.nextRunAt > Date.now());
    assert.equal(e.name, "Morning brief", "fields that were not sent are left alone");

    const paused = (await (await app.request(`/api/automations/${a.id}/active`, json(alice, "POST", { active: false }))).json()).automation;
    assert.equal(paused.active, false);
    assert.equal(paused.nextRunAt, null);
    const resumed = (await (await app.request(`/api/automations/${a.id}/active`, json(alice, "POST", { active: true }))).json()).automation;
    assert.equal(resumed.active, true);
    assert.ok(resumed.nextRunAt > Date.now());
    assert.equal((await app.request(`/api/automations/${a.id}/active`, json(alice, "POST", { active: "yes" }))).status, 400);
  });

  it("ties an automation to the user's own matter only", async () => {
    const matter = await createMatter({ userId: alice.id, title: "Rajesh v. State" });
    const a = await make(alice, { matterId: matter.id });
    assert.equal((await (await app.request(`/api/automations/${a.id}`, json(alice, "GET"))).json()).automation.matterId, matter.id);
    assert.equal((await app.request("/api/automations", json(bob, "POST", { name: "x", prompt: "y", ...daily, matterId: matter.id }))).status, 404);
    assert.equal((await app.request(`/api/automations/${a.id}`, json(alice, "PUT", { matterId: "no-such-matter" }))).status, 404);
  });

  it("keeps automations private to their owner", async () => {
    const a = await make(alice);
    for (const [method, path, body] of [
      ["GET", `/api/automations/${a.id}`, undefined],
      ["PUT", `/api/automations/${a.id}`, { name: "hijack" }],
      ["POST", `/api/automations/${a.id}/active`, { active: false }],
      ["POST", `/api/automations/${a.id}/run`, undefined],
      ["GET", `/api/automations/${a.id}/runs`, undefined],
      ["DELETE", `/api/automations/${a.id}`, undefined],
    ] as const) {
      assert.equal((await app.request(path, json(bob, method, body))).status, 404, `${method} ${path}`);
    }
    assert.equal((await (await app.request("/api/automations", json(bob, "GET"))).json()).automations.length, 0);
    assert.equal((await app.request(`/api/automations/${a.id}`, json(alice, "GET"))).status, 200, "still there for its owner");
  });

  it("deletes an automation", async () => {
    const a = await make(alice);
    assert.equal((await app.request(`/api/automations/${a.id}`, json(alice, "DELETE"))).status, 200);
    assert.equal((await app.request(`/api/automations/${a.id}`, json(alice, "GET"))).status, 404);
  });

  it("runs now: opens a chat for the owner, asks the assistant, and records the run", async () => {
    const user = await createTestUser("auto_run");
    const a = await make(user, { name: "Greeting check" });
    const started = await app.request(`/api/automations/${a.id}/run`, json(user, "POST"));
    assert.equal(started.status, 202);
    assert.equal((await started.json()).run.status, "running");

    let run: { status: string; conversationId: string | null; trigger: string } | undefined;
    for (let i = 0; i < 40 && run?.status !== "success" && run?.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      run = (await (await app.request(`/api/automations/${a.id}/runs`, json(user, "GET"))).json()).runs[0];
    }
    assert.equal(run?.status, "success");
    assert.equal(run?.trigger, "manual");
    assert.ok(run?.conversationId);

    const chat = await (await app.request(`/api/conversations/${run!.conversationId}`, json(user, "GET"))).json();
    assert.match(chat.conversation.title, /^Greeting check · /);
    assert.equal(chat.messages[0].text, "Hello what is your name?");
    assert.match(chat.messages.at(-1).text, /I'm Lirava/);
  });

  it("limits how many automations one person can keep", async () => {
    const user = await createTestUser("auto_limit");
    for (let i = 0; i < MAX_AUTOMATIONS; i++) await make(user, { name: `Auto ${i}` });
    const over = await app.request("/api/automations", json(user, "POST", { name: "One too many", prompt: "y", ...daily }));
    assert.equal(over.status, 409);
  });
});

describe("scheduled runs", () => {
  let user: TestUser;
  before(async () => {
    user = await createTestUser("auto_due");
  });

  const make = async (name: string) => {
    const res = await app.request("/api/automations", json(user, "POST", { name, prompt: "Hello what is your name?", ...daily }));
    return (await res.json()).automation as { id: string };
  };
  const setNext = async (id: string, at: number) => {
    await getSql()!`UPDATE automations SET next_run_at = ${at} WHERE id = ${id}`;
  };
  const get = async (id: string) => (await (await app.request(`/api/automations/${id}`, json(user, "GET"))).json()).automation as { nextRunAt: number | null; lastRunAt: number | null };

  it("runs what is due exactly once, and moves it to its next future time", async () => {
    const a = await make("Due now");
    const now = Date.now();
    await setNext(a.id, now - 60_000);
    const seen: string[] = [];
    const runner = async (auto: { id: string }) => void seen.push(auto.id);

    assert.equal(await runDueAutomations(now, runner, { userId: user.id }), 1);
    assert.deepEqual(seen, [a.id]);
    const after = await get(a.id);
    assert.ok(after.nextRunAt! > now, "rescheduled into the future");
    assert.equal(after.lastRunAt, now);

    assert.equal(await runDueAutomations(now, runner, { userId: user.id }), 0, "a second check does not run it again");
    assert.deepEqual(seen, [a.id]);
  });

  it("does not run something that is not due yet, or paused", async () => {
    const later = await make("Not yet");
    const paused = await make("Paused");
    await app.request(`/api/automations/${paused.id}/active`, json(user, "POST", { active: false }));
    await getSql()!`UPDATE automations SET next_run_at = ${Date.now() - 60_000} WHERE id = ${paused.id}`; // overdue, but paused
    const seen: string[] = [];
    await runDueAutomations(Date.now(), async (auto: { id: string }) => void seen.push(auto.id), { userId: user.id });
    assert.ok(!seen.includes(later.id));
    assert.ok(!seen.includes(paused.id));
  });

  it("after a long outage runs once, not once per missed day", async () => {
    const a = await make("Missed ten days");
    const now = Date.now();
    await setNext(a.id, now - 10 * 24 * 60 * 60 * 1000);
    let runs = 0;
    assert.equal(await runDueAutomations(now, async () => void runs++, { userId: user.id }), 1);
    assert.equal(runs, 1);
    assert.equal(await runDueAutomations(now, async () => void runs++, { userId: user.id }), 0);
    assert.ok((await get(a.id)).nextRunAt! > now);
  });

  it("keeps going when one run fails", async () => {
    const first = await make("Fails");
    const second = await make("Fine");
    const now = Date.now();
    await setNext(first.id, now - 120_000);
    await setNext(second.id, now - 60_000);
    const ok: string[] = [];
    const ran = await runDueAutomations(
      now,
      async (auto: { id: string }) => {
        if (auto.id === first.id) throw new Error("boom");
        ok.push(auto.id);
      },
      { userId: user.id },
    );
    assert.equal(ran, 2);
    assert.deepEqual(ok, [second.id]);
  });
});
