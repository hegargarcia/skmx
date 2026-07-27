import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { cronExpression, formatTimeOfDay, nextRun, readSchedule, TimeOfDay } from "../src/cron.ts";

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
  [{ hour: 3, minute: 0 }, "0 3 * * *"],
  [{ hour: 15, minute: 30 }, "30 15 * * *"],
])("turns %o into a daily cron expression", (time, expected) => {
  expect(cronExpression(time)).toBe(expected);
});

test("reads back the recorded schedule", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "skill-sync-schedule-"));
  const config = { schedulePath: join(stateDir, "schedule.json") } as Config;

  expect(await readSchedule(config)).toBeNull();

  // A schedule written before pausing existed is running, not paused.
  await Bun.write(config.schedulePath, JSON.stringify({ hour: 3, minute: 30 }));
  expect(await readSchedule(config)).toEqual({ hour: 3, minute: 30, paused: false });

  await Bun.write(config.schedulePath, JSON.stringify({ hour: 3, minute: 30, paused: true }));
  expect(await readSchedule(config)).toEqual({ hour: 3, minute: 30, paused: true });

  await Bun.write(config.schedulePath, "not json");
  expect(await readSchedule(config)).toBeNull();

  await rm(stateDir, { recursive: true, force: true });
});

test("next run is today when the time is still ahead", () => {
  const now = new Date("2026-07-27T01:00:00");
  expect(nextRun({ hour: 3, minute: 0 }, now)).toEqual(new Date("2026-07-27T03:00:00"));
});

test("next run rolls to tomorrow once the time has passed", () => {
  const now = new Date("2026-07-27T04:00:00");
  expect(nextRun({ hour: 3, minute: 0 }, now)).toEqual(new Date("2026-07-28T03:00:00"));
});
