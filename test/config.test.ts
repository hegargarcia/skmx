import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const MANAGED = [
  "SKILL_SYNC_HOME",
  "SKILL_SYNC_REPO",
  "SKILL_SYNC_SKILLS_DIR",
  "SKILL_SYNC_BRANCH",
] as const;

let home: string;
let saved: Record<string, string | undefined>;

const writeConfigFile = (contents: unknown) =>
  Bun.write(join(home, "config.json"), JSON.stringify(contents));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "skill-sync-config-"));
  // Ambient SKILL_SYNC_* variables outrank the config file, so set them aside.
  saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  process.env.SKILL_SYNC_HOME = home;
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

test("falls back to the defaults when there is no config file", async () => {
  const config = await loadConfig();

  expect(config.repo).toBeUndefined();
  expect(config.branch).toBe("main");
  expect(config.skillsDir).toBe(join(homedir(), ".claude", "skills"));
  expect(config.configPath).toBe(join(home, "config.json"));
});

test("reads settings from the config file", async () => {
  await writeConfigFile({ repo: "git@example.com:me/skills.git", branch: "trunk" });

  const config = await loadConfig();

  expect(config.repo).toBe("git@example.com:me/skills.git");
  expect(config.branch).toBe("trunk");
});

test("expands a leading ~ in the skills directory", async () => {
  await writeConfigFile({ skillsDir: "~/elsewhere/skills" });

  expect((await loadConfig()).skillsDir).toBe(join(homedir(), "elsewhere", "skills"));
});

test("lets environment variables override the config file", async () => {
  await writeConfigFile({ repo: "git@example.com:me/from-file.git", branch: "trunk" });
  process.env.SKILL_SYNC_REPO = "git@example.com:me/from-env.git";

  const config = await loadConfig();

  expect(config.repo).toBe("git@example.com:me/from-env.git");
  expect(config.branch).toBe("trunk");
});

test("rejects an unknown key so typos do not pass silently", async () => {
  await writeConfigFile({ rebo: "git@example.com:me/skills.git" });

  expect(loadConfig()).rejects.toThrow(/rebo/);
});

test("rejects a config file that is not valid JSON", async () => {
  await Bun.write(join(home, "config.json"), "{ repo: nope }");

  expect(loadConfig()).rejects.toThrow(/not valid JSON/);
});
