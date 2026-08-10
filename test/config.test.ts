import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig, updateConfig } from "../src/config.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

describe("configuration", () => {
  it("stores only portable values and hydrates device paths", async () => {
    const root = await tempRoot();
    const env = { ...process.env, SKILL_SYNC_HOME: `${root}/state`, SKILL_SYNC_AGENT_HOME: `${root}/home` };
    const saved = await saveConfig(defaultConfig("owner/skills"), env);

    expect(saved.repoDir).toBe(`${root}/state/repo`);
    expect(saved.agentHome).toBe(`${root}/home`);
    expect(JSON.parse(await readFile(saved.configPath, "utf8"))).toEqual({
      repo: "owner/skills",
      branch: "main",
      intervalMinutes: 60,
      links: [],
    });
  });

  it("updates portable values without replacing hydrated paths", async () => {
    const root = await tempRoot();
    const env = { ...process.env, SKILL_SYNC_HOME: `${root}/state` };
    const config = await saveConfig(defaultConfig("one/repo"), env);
    const updated = await updateConfig(config, { ...defaultConfig("two/repo"), links: ["/tmp/link"] });

    expect(updated.repo).toBe("two/repo");
    expect(updated.repoDir).toBe(config.repoDir);
    expect((await loadConfig(env)).links).toEqual(["/tmp/link"]);
  });

  it("explains missing and invalid configuration", async () => {
    const root = await tempRoot();
    const env = { ...process.env, SKILL_SYNC_HOME: `${root}/state` };
    await expect(loadConfig(env)).rejects.toThrow("run `ss setup`");
    await saveConfig(defaultConfig("owner/repo"), env);
    await writeFile(`${root}/state/config.json`, "not json");
    await expect(loadConfig(env)).rejects.toThrow("not valid JSON");
  });
});
