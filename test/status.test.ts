import { describe, expect, it } from "vitest";
import { assessHealth } from "../src/status.ts";
import type { RunRecord } from "../src/runs.ts";

const now = Date.parse("2026-08-12T12:00:00.000Z");

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: "2026-08-12T11:59:00.000Z",
    finishedAt: "2026-08-12T11:59:30.000Z",
    trigger: "scheduled",
    status: "ok",
    summary: "already in sync",
    commit: null,
    ...overrides,
  };
}

describe("status health", () => {
  it("treats an intentionally absent schedule and a pending first run as non-failures", () => {
    expect(assessHealth(null, run(), 15, now)).toMatchObject({
      kind: "not-scheduled",
      unhealthy: false,
    });
    expect(assessHealth("cron", null, 15, now)).toMatchObject({
      kind: "pending",
      unhealthy: false,
    });
  });

  it("reports a missing scheduler for an active configuration", () => {
    expect(assessHealth(null, run(), 15, now, true)).toEqual({
      kind: "missing-schedule",
      message: "missing from the OS scheduler — run `skmx setup` again",
      unhealthy: true,
    });
  });

  it("reports the latest failed run as unhealthy", () => {
    expect(assessHealth("launchd", run({ status: "conflict" }), 15, now)).toEqual({
      kind: "problem",
      message: "conflict — see last sync",
      unhealthy: true,
    });
  });

  it("uses the configured interval when deciding whether a successful run is stale", () => {
    expect(assessHealth("cron", run(), 15, now)).toMatchObject({ kind: "ok", unhealthy: false });
    expect(assessHealth(
      "cron",
      run({ finishedAt: "2026-08-12T11:39:59.000Z" }),
      15,
      now,
    )).toEqual({
      kind: "stale",
      message: "stale — no successful sync in the last 20 minutes",
      unhealthy: true,
    });
  });
});
