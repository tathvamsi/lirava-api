/**
 * Schedules for automations: daily, on weekdays, or weekly, at a time of day in Indian Standard Time.
 * IST is UTC+5:30 all year (no daylight saving), so plain arithmetic is exact. Nothing runs more than once a day.
 */

export type Frequency = "daily" | "weekdays" | "weekly";
export const FREQUENCIES: readonly Frequency[] = ["daily", "weekdays", "weekly"];
export const isFrequency = (value: unknown): value is Frequency => typeof value === "string" && (FREQUENCIES as readonly string[]).includes(value);

export interface Schedule {
  frequency: Frequency;
  /** "HH:MM" in 24-hour time, IST. */
  time: string;
  /** 0 (Sunday) to 6 (Saturday). Only used by "weekly". */
  weekday: number;
}

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A schedule from user input, or null when any part is unusable. */
export function parseSchedule(input: { frequency?: unknown; time?: unknown; weekday?: unknown }): Schedule | null {
  if (!isFrequency(input.frequency)) return null;
  if (typeof input.time !== "string" || !TIME_PATTERN.test(input.time)) return null;
  let weekday = 1;
  if (input.frequency === "weekly") {
    if (typeof input.weekday !== "number" || !Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) return null;
    weekday = input.weekday;
  }
  return { frequency: input.frequency, time: input.time, weekday };
}

/** The first moment strictly after `afterMs` that the schedule fires, as epoch milliseconds. */
export function nextRunAfter(schedule: Schedule, afterMs: number): number {
  const [hh, mm] = schedule.time.split(":").map(Number);
  const istNow = new Date(afterMs + IST_OFFSET_MS);
  const dayStart = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  for (let i = 0; i < 9; i++) {
    const day = dayStart + i * DAY_MS;
    const dow = new Date(day).getUTCDay();
    const matches = schedule.frequency === "daily" || (schedule.frequency === "weekdays" && dow >= 1 && dow <= 5) || (schedule.frequency === "weekly" && dow === schedule.weekday);
    if (!matches) continue;
    const at = day + (hh * 60 + mm) * 60 * 1000 - IST_OFFSET_MS;
    if (at > afterMs) return at;
  }
  // Unreachable for a valid schedule: every kind fires within eight days.
  return afterMs + DAY_MS;
}

function clock(time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  const hour = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

/** "Every weekday at 9:00 AM IST". */
export function describeSchedule(schedule: Schedule): string {
  const when = clock(schedule.time);
  if (schedule.frequency === "daily") return `Every day at ${when} IST`;
  if (schedule.frequency === "weekdays") return `Every weekday at ${when} IST`;
  return `Every ${WEEKDAY_NAMES[schedule.weekday]} at ${when} IST`;
}
