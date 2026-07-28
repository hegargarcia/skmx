import { hostname } from "node:os";
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
    hour: z.number().int().min(0).max(23).nullable(),
    minute: z.number().int().min(0).max(59),
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    day: z.number().int().min(0).max(6).nullable().optional(),
    paused: z.boolean().default(false),
  })
  .transform(({ day, days, ...rest }) => ({
    ...rest,
    days: days ?? (day === undefined || day === null ? [...ALL_DAYS] : [day]),
  }));

/** A null `hour` means every hour, which is how the sync runs by default. */
export type Schedule = { hour: number | null; minute: number; days: number[] };

/**
 * Machines syncing to one repo want to avoid arriving together, so the minute is
 * derived from the hostname: stable across runs, but different per machine.
 */
export const stableMinute = (seed = hostname()) => Number(BigInt(Bun.hash(seed)) % 60n);

export const everyHour = (seed?: string): Schedule => ({
  hour: null,
  minute: stableMinute(seed),
  days: [...ALL_DAYS],
});

/** Monday first, as the week is read, rather than cron's Sunday-first numbering. */
const asRead = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

const named = (days: number[], others: number[]) =>
  days.length === others.length && [...days].sort().join() === [...others].sort().join();

export const formatDays = (days: number[]) => {
  if (named(days, [...ALL_DAYS])) return "Every day";
  if (named(days, [1, 2, 3, 4, 5])) return "Weekdays";
  if (named(days, [6, 0])) return "Weekends";
  if (days.length === 1) return dayName(days[0]!);

  return asRead(days)
    .map((day) => dayName(day).slice(0, 3))
    .join(" · ");
};

export const formatSchedule = (schedule: Schedule) => {
  const days = formatDays(schedule.days);
  if (schedule.hour === null) {
    const minute = String(schedule.minute).padStart(2, "0");
    return days === "Every day" ? `Every hour at :${minute}` : `${days}, every hour at :${minute}`;
  }

  return `${days} at ${formatTimeOfDay({ hour: schedule.hour, minute: schedule.minute })}`;
};

export const formatTimeOfDay = ({ hour, minute }: TimeOfDay) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/**
 * The other half of `cronExpression`, for `--cron`. Only what a schedule can hold is
 * accepted: a minute, an hour and days of the week. Anything else is refused rather
 * than registered as something `status` would then describe wrongly.
 */
export const CronExpression = z.string().trim().transform((raw, ctx): Schedule => {
  const reject = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    return reject(`"${raw}" is not a five-field cron expression like "0 9 * * 1-5"`);
  }

  const [minuteField = "", hourField = "", dayOfMonth, month, dayOfWeek = ""] = fields;
  if (dayOfMonth !== "*" || month !== "*") {
    return reject("day of month and month are not supported, so both must be *");
  }

  const minute = wholeNumber(minuteField, 59);
  const hour = hourField === "*" ? null : wholeNumber(hourField, 23);
  if (minute === null || (hour === null && hourField !== "*")) {
    return reject(
      /^\d+$/.test(minuteField) && /^\d+$/.test(hourField)
        ? `"${raw}" needs a minute of 0-59 and an hour of 0-23`
        : `"${raw}" needs a plain minute, and an hour that is a number or * for every hour — ` +
            "lists, ranges and steps like */15 only work for the day of week",
    );
  }

  const days = dayOfWeek === "*" ? [...ALL_DAYS] : weekdays(dayOfWeek);
  if (days === null) {
    return reject(
      `"${raw}" needs a day of week that is *, a number from 0-7, a list like 1,3,5 or a range like 1-5`,
    );
  }

  return { hour, minute, days };
});

function wholeNumber(field: string, max: number) {
  const value = Number(field);
  return /^\d+$/.test(field) && value <= max ? value : null;
}

/** Cron counts Sunday as both 0 and 7. */
function weekdays(field: string) {
  const days = new Set<number>();

  for (const part of field.split(",")) {
    const [from, to = from] = part.split("-");
    const start = wholeNumber(from ?? "", 7);
    const end = wholeNumber(to ?? "", 7);
    if (start === null || end === null || start > end) return null;

    for (let day = start; day <= end; day++) days.add(day % 7);
  }

  return days.size > 0 ? [...days] : null;
}

export const cronExpression = ({ hour, minute, days }: Schedule) =>
  `${minute} ${hour ?? "*"} * * ${
    days.length >= ALL_DAYS.length ? "*" : [...days].sort((a, b) => a - b).join(",")
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
  if (schedule.hour === null) {
    const next = new Date(now);
    next.setMinutes(schedule.minute, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    // Walk on an hour at a time until it lands on a day the schedule runs.
    while (!schedule.days.includes(next.getDay())) next.setHours(next.getHours() + 1);
    return next;
  }

  const candidates = schedule.days.map((day) => {
    const next = new Date(now);
    next.setHours(schedule.hour!, schedule.minute, 0, 0);
    next.setDate(next.getDate() + ((day - next.getDay() + 7) % 7));
    if (next <= now) next.setDate(next.getDate() + 7);
    return next.getTime();
  });

  return new Date(Math.min(...candidates));
}
