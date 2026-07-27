import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  CronExpression,
  cronExpression,
  formatSchedule,
  formatTimeOfDay,
  nextRun,
  readSchedule,
  TimeOfDay,
} from "../src/cron.ts";

test.each([
  ["03:00", { hour: 3, minute: 0 }],
  ["23:45", { hour: 23, minute: 45 }],
  ["0:05", { hour: 0, minute: 5 }],
  ["3am", { hour: 3, minute: 0 }],
  ["12am", { hour: 0, minute: 0 }],
  ["12pm", { hour: 12, minute: 0 }],
  ["3:30pm", { hour: 15, minute: 30 }],
  [" 11PM ", { hour: 23, minute: 0 }],
])("parses %p as a time of day", (input, expected) => {
  expect(TimeOfDay.parse(input)).toEqual(expected);
});

test.each(["", "24:00", "12:60", "13pm", "0am", "midnight", "3:5"])(
  "rejects %p",
  (input) => {
    expect(TimeOfDay.safeParse(input).success).toBe(false);
  },
);

test("formats a time of day back into HH:MM", () => {
  expect(formatTimeOfDay({ hour: 3, minute: 5 })).toBe("03:05");
});

test.each([
  [{ hour: 3, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] }, "0 3 * * *"],
  [{ hour: 15, minute: 30, days: [1, 2, 3, 4, 5, 6, 0] }, "30 15 * * *"],
  [{ hour: 3, minute: 0, days: [1] }, "0 3 * * 1"],
  [{ hour: 23, minute: 45, days: [0] }, "45 23 * * 0"],
])("turns %o into a cron expression", (schedule, expected) => {
  expect(cronExpression(schedule)).toBe(expected);
});

test.each([
  [[1, 2, 3, 4, 5, 6, 0], "Every day at 03:05"],
  [[1], "Mondays at 03:05"],
  [[0], "Sundays at 03:05"],
  [[1, 2, 3, 4, 5], "Weekdays at 03:05"],
  [[6, 0], "Weekends at 03:05"],
  // Listed as the week is read, not in cron's Sunday-first order.
  [[5, 0, 1], "Mon · Fri · Sun at 03:05"],
])("describes days %p as a schedule", (days, expected) => {
  expect(formatSchedule({ hour: 3, minute: 5, days })).toBe(expected);
});

test.each([
  ["0 9 * * *", { hour: 9, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] }],
  ["30 21 * * 1", { hour: 21, minute: 30, days: [1] }],
  ["0 9 * * 1-5", { hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }],
  ["0 9 * * 1,3,5", { hour: 9, minute: 0, days: [1, 3, 5] }],
  ["0 9 * * 6,0", { hour: 9, minute: 0, days: [6, 0] }],
  // Cron counts Sunday as both 0 and 7.
  ["0 9 * * 7", { hour: 9, minute: 0, days: [0] }],
  ["  0   9 * * 1-2,4  ", { hour: 9, minute: 0, days: [1, 2, 4] }],
])("reads %p as a schedule", (expression, expected) => {
  expect(CronExpression.parse(expression)).toEqual(expected);
});

test.each([
  ["0 9 * *", "five-field"],
  ["0 9 1 * *", "day-of-month and month"],
  ["0 9 * JAN *", "day-of-month and month"],
  ["60 9 * * *", "minute or hour"],
  ["0 24 * * *", "minute or hour"],
  ["*/15 * * * *", "minute or hour"],
  ["0 9 * * 8", "day of week"],
  ["0 9 * * MON", "day of week"],
])("refuses %p rather than scheduling something else", (expression, reason) => {
  const result = CronExpression.safeParse(expression);

  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toContain(reason);
});

test("round-trips a schedule through its cron expression", () => {
  const schedule = { hour: 9, minute: 30, days: [1, 3, 5] };

  expect(CronExpression.parse(cronExpression(schedule))).toEqual(schedule);
});

test("puts several days into one cron expression, lowest first", () => {
  expect(cronExpression({ hour: 3, minute: 0, days: [5, 0, 1] })).toBe("0 3 * * 0,1,5");
});

test("next run is the soonest of the chosen days", () => {
  // 2026-07-27 is a Monday; Tuesday comes before Friday.
  const now = new Date("2026-07-27T04:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [5, 2] }, now)).toEqual(
    new Date("2026-07-28T03:00:00"),
  );
});

test("reads back the recorded schedule", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "skill-sync-schedule-"));
  const config = { schedulePath: join(stateDir, "schedule.json") } as Config;

  expect(await readSchedule(config)).toBeNull();

  // A schedule written before days and pausing existed runs daily, unpaused.
  await Bun.write(config.schedulePath, JSON.stringify({ hour: 3, minute: 30 }));
  expect(await readSchedule(config)).toEqual({
    hour: 3,
    minute: 30,
    days: [1, 2, 3, 4, 5, 6, 0],
    paused: false,
  });

  // A single day, as it was recorded before a schedule could name several.
  await Bun.write(config.schedulePath, JSON.stringify({ hour: 3, minute: 30, day: 2 }));
  expect(await readSchedule(config)).toEqual({
    hour: 3,
    minute: 30,
    days: [2],
    paused: false,
  });

  await Bun.write(
    config.schedulePath,
    JSON.stringify({ hour: 3, minute: 30, days: [1, 5], paused: true }),
  );
  expect(await readSchedule(config)).toEqual({
    hour: 3,
    minute: 30,
    days: [1, 5],
    paused: true,
  });

  await Bun.write(config.schedulePath, "not json");
  expect(await readSchedule(config)).toBeNull();

  await rm(stateDir, { recursive: true, force: true });
});

test("next daily run is today when the time is still ahead", () => {
  const now = new Date("2026-07-27T01:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] }, now)).toEqual(new Date("2026-07-27T03:00:00"));
});

test("next daily run rolls to tomorrow once the time has passed", () => {
  const now = new Date("2026-07-27T04:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] }, now)).toEqual(new Date("2026-07-28T03:00:00"));
});

test("next weekly run is later this week when the day is still ahead", () => {
  // 2026-07-27 is a Monday, so Thursday is three days out.
  const now = new Date("2026-07-27T04:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [4] }, now)).toEqual(new Date("2026-07-30T03:00:00"));
});

test("next weekly run is today when the day matches and the time is ahead", () => {
  const now = new Date("2026-07-27T01:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [1] }, now)).toEqual(new Date("2026-07-27T03:00:00"));
});

test("next weekly run rolls a week on once the day has passed", () => {
  const now = new Date("2026-07-27T04:00:00");
  expect(nextRun({ hour: 3, minute: 0, days: [1] }, now)).toEqual(new Date("2026-08-03T03:00:00"));
});
