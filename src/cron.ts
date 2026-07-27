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

/** Cron's day-of-week numbering, 0 being Sunday, ordered as a week is read. */
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

export const dayName = (day: number) => DAY_NAMES[day]!;

/**
 * When the sync runs. `paused` keeps the schedule on record after `stop`, so `start`
 * can resume it. `day` is how a single day used to be recorded, before a schedule
 * could name several.
 */
const ScheduleSchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    day: z.number().int().min(0).max(6).nullable().optional(),
    paused: z.boolean().default(false),
  })
  .transform(({ day, days, ...rest }) => ({
    ...rest,
    days: days ?? (day === undefined || day === null ? [...ALL_DAYS] : [day]),
  }));

export type Schedule = { hour: number; minute: number; days: number[] };

export const EVERY_DAY_AT_MIDNIGHT: Schedule = { hour: 0, minute: 0, days: [...ALL_DAYS] };

/** Monday first, as the week is read, rather than cron's Sunday-first numbering. */
const asRead = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

export const formatDays = (days: number[]) => {
  if (days.length >= ALL_DAYS.length) return "Every day";
  if (days.length === 1) return dayName(days[0]!);

  return asRead(days)
    .map((day) => dayName(day).slice(0, 3))
    .join(" · ");
};

export const formatSchedule = (schedule: Schedule) =>
  `${formatDays(schedule.days)} at ${formatTimeOfDay(schedule)}`;

export const formatTimeOfDay = ({ hour, minute }: TimeOfDay) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

export const cronExpression = ({ hour, minute, days }: Schedule) =>
  `${minute} ${hour} * * ${
    days.length >= ALL_DAYS.length
      ? "*"
      : [...days].sort((a, b) => a - b).join(",")
  }`;

export async function installSchedule(schedule: Schedule, config: Config) {
  await Bun.cron(JOB_MODULE, cronExpression(schedule), TITLE);
  await writeSchedule(config, schedule, false);
}

/** Unregisters the job but keeps the time, so `start` can put it back. */
export async function pauseSchedule(config: Config) {
  const schedule = await readSchedule(config);
  if (schedule === null) return false;

  await Bun.cron.remove(TITLE);
  await writeSchedule(config, schedule, true);
  return true;
}

const writeSchedule = (
  { schedulePath }: Config,
  { hour, minute, days }: Schedule,
  paused: boolean,
) => Bun.write(schedulePath, `${JSON.stringify({ hour, minute, days, paused })}\n`);

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
export function nextRun(schedule: Schedule, now = new Date()) {
  const candidates = schedule.days.map((day) => {
    const next = new Date(now);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    next.setDate(next.getDate() + ((day - next.getDay() + 7) % 7));
    if (next <= now) next.setDate(next.getDate() + 7);
    return next.getTime();
  });

  return new Date(Math.min(...candidates));
}
