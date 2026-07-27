import { $ } from "bun";
import { z } from "zod";
import type { Config } from "./config.ts";

/** Identifies our entry in the OS scheduler: crontab, launchd, or Task Scheduler. */
const TITLE = "skill-sync";

/** The module Bun.cron runs; resolved relative to this file. */
const JOB_MODULE = "./scheduled.ts";

/** Accepts 24-hour `HH:MM` and 12-hour `9am` / `9:30pm`. */
export const TimeOfDay = z.string().trim().transform((raw, ctx) => {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2] ?? 0);
  const meridiem = match?.[3]?.toLowerCase();

  const valid = match && minute < 60 && (meridiem ? hour >= 1 && hour <= 12 : hour < 24);
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      message: `"${raw}" is not a time of day — use 24-hour HH:MM (03:00) or 12-hour (3am, 3:30pm)`,
    });
    return z.NEVER;
  }

  return {
    hour: meridiem === "pm" ? (hour % 12) + 12 : meridiem === "am" ? hour % 12 : hour,
    minute,
  };
});

export type TimeOfDay = z.output<typeof TimeOfDay>;

/** `paused` keeps the time on record after `stop`, so `start` can resume it. */
const ScheduleSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  paused: z.boolean().default(false),
});

export const formatTimeOfDay = ({ hour, minute }: TimeOfDay) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

export const cronExpression = ({ hour, minute }: TimeOfDay) => `${minute} ${hour} * * *`;

export const MIDNIGHT = { hour: 0, minute: 0 } as const;

export async function installSchedule(time: TimeOfDay, config: Config) {
  await Bun.cron(JOB_MODULE, cronExpression(time), TITLE);
  await writeSchedule(config, time, false);
}

/** Unregisters the job but keeps the time, so `start` can put it back. */
export async function pauseSchedule(config: Config) {
  const schedule = await readSchedule(config);
  if (schedule === null) return false;

  await Bun.cron.remove(TITLE);
  await writeSchedule(config, schedule, true);
  return true;
}

const writeSchedule = ({ schedulePath }: Config, { hour, minute }: TimeOfDay, paused: boolean) =>
  Bun.write(schedulePath, `${JSON.stringify({ hour, minute, paused })}\n`);

/** The time of day the sync was registered for, or null when it is not scheduled. */
export async function readSchedule(config: Config) {
  const file = Bun.file(config.schedulePath);
  if (!(await file.exists())) return null;

  const parsed = ScheduleSchema.safeParse(await file.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the OS scheduler still holds the entry. Bun.cron writes a marked crontab
 * line on Linux; elsewhere it uses launchd or Task Scheduler, which this does not
 * inspect, so the schedule is taken at its word.
 */
export async function isRegistered() {
  if (process.platform !== "linux") return true;

  const crontab = await $`crontab -l`.nothrow().quiet();
  return crontab.stdout.toString().includes(`# bun-cron: ${TITLE}`);
}

/**
 * The next local time the schedule fires. Bun.cron.parse resolves expressions in
 * UTC while the OS scheduler fires in local time, so this stays hand-rolled.
 */
export function nextRun(time: TimeOfDay, now = new Date()) {
  const next = new Date(now);
  next.setHours(time.hour, time.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}
