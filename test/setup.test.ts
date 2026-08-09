import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

const mocks = vi.hoisted(() => ({
  installSchedule: vi.fn(),
  preflightTargets: vi.fn(async () => []),
  runSync: vi.fn(),
  uninstallSchedule: vi.fn(),
}));

vi.mock("../src/github.ts", () => ({
  assertPrerequisites: vi.fn(),
  resolveRepo: vi.fn(async (repo: string) => repo),
}));
vi.mock("../src/repository.ts", () => ({ prepareRepo: vi.fn() }));
vi.mock("../src/validation.ts", () => ({ validateManagedTree: vi.fn() }));
vi.mock("../src/targets.ts", () => ({ preflightTargets: mocks.preflightTargets }));
vi.mock("../src/scheduler.ts", () => ({
  installSchedule: mocks.installSchedule,
  uninstallSchedule: mocks.uninstallSchedule,
}));
vi.mock("../src/sync.ts", () => ({ runSync: mocks.runSync }));

import { setup } from "../src/setup.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.installSchedule.mockResolvedValue("cron");
  mocks.uninstallSchedule.mockResolvedValue(true);
});
afterEach(cleanupRoots);

describe("repeat setup", () => {
  it("preserves link ownership and removes an old schedule when the first sync fails", async () => {
    const root = await tempRoot();
    const env = {
      ...process.env,
      SKILL_SYNC_HOME: join(root, "state"),
      SKILL_SYNC_AGENT_HOME: join(root, "agent-home"),
    };
    await saveConfig(
      { repo: "/repo", branch: "main", intervalMinutes: 60, links: [join(root, "owned-link")] },
      env,
    );
    mocks.runSync.mockResolvedValue({
      startedAt: "2026-08-09T00:00:00.000Z",
      finishedAt: "2026-08-09T00:00:01.000Z",
      trigger: "setup",
      status: "error",
      summary: "push failed",
      commit: null,
    });

    const result = await setup({ repo: "/repo", branch: "main", intervalMinutes: 15 }, env);
    expect(result.scheduler).toBeNull();
    expect(mocks.runSync).toHaveBeenCalledWith(
      expect.objectContaining({ links: [join(root, "owned-link")], intervalMinutes: 15 }),
      "setup",
    );
    expect(mocks.preflightTargets).toHaveBeenCalledWith(
      join(root, "state", "repo"),
      join(root, "agent-home"),
      [join(root, "owned-link")],
    );
    expect(mocks.uninstallSchedule).toHaveBeenCalledOnce();
    expect(mocks.installSchedule).not.toHaveBeenCalled();
    expect((await loadConfig(env)).links).toEqual([join(root, "owned-link")]);
  });
});
