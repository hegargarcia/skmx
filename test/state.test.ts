import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withLock } from "../src/lock.ts";
import { appendRun, readRuns, type RunRecord } from "../src/runs.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

describe("local run state", () => {
  it("prevents overlapping coordinators and releases the lock", async () => {
    const root = await tempRoot();
    const path = join(root, "sync.lock");
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = withLock(path, async () => {
      markStarted();
      await gate;
    });
    await started;
    await expect(withLock(path, async () => "second")).rejects.toThrow("already active");
    release();
    await first;
    await expect(withLock(path, async () => "next")).resolves.toBe("next");
  });

  it("does not steal a fresh incomplete lock and recovers it after the grace period", async () => {
    const root = await tempRoot();
    const path = join(root, "sync.lock");
    const broken = join(path, "broken-candidate");
    await mkdir(path);
    await writeFile(broken, JSON.stringify({ startedAt: "unknown" }));
    await expect(withLock(path, async () => "too soon")).rejects.toThrow("already active");
    const stale = new Date(Date.now() - 20_000);
    await utimes(broken, stale, stale);
    await expect(withLock(path, async () => "ok")).resolves.toBe("ok");
  });

  it("never overlaps contenders that concurrently clean the same stale owner", async () => {
    const root = await tempRoot();
    const path = join(root, "sync.lock");
    await mkdir(path);
    await writeFile(
      join(path, "stale-owner"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: "2026-08-09T00:00:00.000Z", token: "stale" }),
    );
    let running = 0;
    let maximum = 0;
    const operation = () => withLock(path, async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    });

    await Promise.allSettled([operation(), operation()]);
    expect(maximum).toBeLessThanOrEqual(1);
    await expect(withLock(path, async () => "next")).resolves.toBe("next");
  });

  it("reads newest valid structured runs and ignores damaged lines", async () => {
    const root = await tempRoot();
    const path = join(root, "runs.jsonl");
    const record: RunRecord = {
      startedAt: "2026-08-09T00:00:00.000Z",
      finishedAt: "2026-08-09T00:00:01.000Z",
      trigger: "manual",
      status: "ok",
      summary: "already in sync",
      commit: "abc1234",
    };
    await appendRun(path, record);
    await mkdir(root, { recursive: true });
    await writeFile(path, `${JSON.stringify(record)}\nnot-json\n${JSON.stringify({ bad: true })}\n`);
    await expect(readRuns(path)).resolves.toEqual([record]);
  });
});
