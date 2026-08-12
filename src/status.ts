import type { Config } from "./config.ts";
import { readRuns, type RunRecord } from "./runs.ts";
import { registeredScheduler } from "./scheduler.ts";

type HealthKind = "ok" | "pending" | "stale" | "problem" | "missing-schedule" | "not-scheduled";

export type Health = {
  kind: HealthKind;
  message: string;
  unhealthy: boolean;
};

export type Status = {
  config: Config;
  scheduler: "cron" | "launchd" | null;
  lastRun: RunRecord | null;
  health: Health;
};

export async function readStatus(config: Config): Promise<Status> {
  const [scheduler, runs] = await Promise.all([
    registeredScheduler(config),
    readRuns(config.runsPath, 1),
  ]);
  const lastRun = runs[0] ?? null;
  return {
    config,
    scheduler,
    lastRun,
    health: assessHealth(scheduler, lastRun, config.intervalMinutes, Date.now(), config.links.length > 0),
  };
}

export function assessHealth(
  scheduler: Status["scheduler"],
  lastRun: RunRecord | null,
  intervalMinutes: number,
  now = Date.now(),
  scheduleExpected = false,
): Health {
  if (scheduler === null) {
    if (scheduleExpected) {
      return {
        kind: "missing-schedule",
        message: "missing from the OS scheduler — run `skmx setup` again",
        unhealthy: true,
      };
    }
    return { kind: "not-scheduled", message: "not scheduled", unhealthy: false };
  }
  if (lastRun === null) {
    return {
      kind: "pending",
      message: "pending — scheduled but has not run yet",
      unhealthy: false,
    };
  }
  if (lastRun.status !== "ok") {
    return {
      kind: "problem",
      message: `${lastRun.status} — see last sync`,
      unhealthy: true,
    };
  }

  const graceMinutes = Math.max(5, Math.ceil(intervalMinutes * 0.1));
  const staleAfterMinutes = intervalMinutes + graceMinutes;
  const finishedAt = Date.parse(lastRun.finishedAt);
  if (!Number.isFinite(finishedAt) || now - finishedAt > staleAfterMinutes * 60_000) {
    return {
      kind: "stale",
      message: `stale — no successful sync in the last ${staleAfterMinutes} minutes`,
      unhealthy: true,
    };
  }
  return { kind: "ok", message: "ok", unhealthy: false };
}
