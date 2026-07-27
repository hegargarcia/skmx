import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { Config } from "../src/config.ts";
import { runSync } from "../src/sync.ts";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

let root: string;
let config: Config;
/** A second clone of the remote, standing in for another machine. */
let other: string;

const localSkill = (name: string) => Bun.file(join(config.skillsDir, name, "SKILL.md"));
const otherSkill = (name: string) => Bun.file(join(other, "skills", name, "SKILL.md"));

async function pushFromOther(name: string, body: string) {
  await Bun.write(otherSkill(name), body);
  await $`git -C ${other} add -A`.quiet();
  await $`git ${GIT_ID} -C ${other} commit -m ${`edit ${name}`}`.quiet();
  await $`git -C ${other} push origin main`.quiet();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-sync-test-"));
  const remote = join(root, "remote.git");
  const skillsDir = join(root, "skills");
  const stateDir = join(root, "state");

  config = {
    repo: remote,
    branch: "main",
    skillsDir,
    configPath: join(root, "config.json"),
    stateDir,
    clonePath: join(stateDir, "repo"),
    statePath: join(stateDir, "state.json"),
    schedulePath: join(stateDir, "schedule.json"),
    backupsDir: join(stateDir, "backups"),
    cronLogPath: join(stateDir, "cron.log"),
  };

  await $`git init --bare --initial-branch=main ${remote}`.quiet();
  other = join(root, "other");
  await $`git clone ${remote} ${other}`.quiet();
  await $`git -C ${other} checkout -B main`.quiet();
  await pushFromOther("alpha", "alpha v1\n");

  // The local skills directory starts out matching the remote.
  await mkdir(skillsDir, { recursive: true });
  await $`rsync -a ${`${join(other, "skills")}/`} ${`${skillsDir}/`}`.quiet();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("pushes local skill edits to the remote", async () => {
  await runSync(config);
  await Bun.write(localSkill("alpha"), "alpha v2\n");
  await Bun.write(localSkill("beta"), "beta v1\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(record.summary).toContain("pushed");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherSkill("alpha").text()).toBe("alpha v2\n");
  expect(await otherSkill("beta").text()).toBe("beta v1\n");
});

test("adopts skills from both sides on a first sync", async () => {
  await Bun.write(localSkill("beta"), "beta v1\n");
  await pushFromOther("gamma", "gamma v1\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(await localSkill("gamma").text()).toBe("gamma v1\n");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherSkill("beta").text()).toBe("beta v1\n");
});

test("brings remote skill changes into the local skills directory", async () => {
  await pushFromOther("gamma", "gamma v1\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(await localSkill("gamma").text()).toBe("gamma v1\n");
  expect(await readdir(config.backupsDir)).toHaveLength(1);
});

test("merges edits made on both sides since the last sync", async () => {
  await runSync(config);
  await Bun.write(localSkill("beta"), "beta v1\n");
  await pushFromOther("gamma", "gamma v1\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(await localSkill("gamma").text()).toBe("gamma v1\n");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherSkill("beta").text()).toBe("beta v1\n");
});

test("refuses the first sync when the same skill differs on both sides", async () => {
  await Bun.write(localSkill("alpha"), "local edit\n");
  await pushFromOther("alpha", "remote edit\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "diverged", commit: null });
  expect(record.summary).toContain("alpha/SKILL.md");
  expect(await localSkill("alpha").text()).toBe("local edit\n");
});

test("keeps refusing a diverged first sync, leaving the remote intact", async () => {
  await Bun.write(localSkill("alpha"), "local edit\n");
  await pushFromOther("alpha", "remote edit\n");

  expect(await runSync(config)).toMatchObject({ status: "diverged" });
  // The clone now exists, which must not be mistaken for a synced base.
  expect(await runSync(config)).toMatchObject({ status: "diverged" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherSkill("alpha").text()).toBe("remote edit\n");
});

test("reports a conflict and leaves the local skills directory untouched", async () => {
  await runSync(config);
  await Bun.write(localSkill("alpha"), "local edit\n");
  await pushFromOther("alpha", "remote edit\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "conflict", commit: null });
  expect(record.summary).toContain("skills/alpha/SKILL.md");
  expect(await localSkill("alpha").text()).toBe("local edit\n");
});

test("propagates a locally deleted skill once a base sync exists", async () => {
  await runSync(config);
  await rm(join(config.skillsDir, "alpha"), { recursive: true });

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherSkill("alpha").exists()).toBe(false);
});

test("treats a timestamp-only difference as in sync", async () => {
  const backdated = new Date("2020-01-01T00:00:00Z");
  await utimes(join(config.skillsDir, "alpha", "SKILL.md"), backdated, backdated);

  expect(await runSync(config)).toMatchObject({ status: "ok" });
});

test("reports already in sync when nothing changed", async () => {
  await runSync(config);

  expect(await runSync(config)).toMatchObject({ status: "ok", summary: "already in sync" });
});

test("populates a remote that has never been pushed to", async () => {
  const empty = join(root, "empty.git");
  await $`git init --bare --initial-branch=main ${empty}`.quiet();

  const record = await runSync({ ...config, repo: empty, clonePath: join(root, "empty-clone") });

  expect(record).toMatchObject({ status: "ok" });
  const pushed = await $`git ls-remote ${empty} refs/heads/main`.quiet();
  expect(pushed.stdout.toString()).toContain("refs/heads/main");
});

test("reports git's own reason when a command fails", async () => {
  const record = await runSync({ ...config, repo: join(root, "does-not-exist.git") });

  expect(record.status).toBe("error");
  expect(record.summary).toContain("does not exist");
});

test("reports a missing skills directory instead of syncing", async () => {
  await rm(config.skillsDir, { recursive: true });

  expect(await runSync(config)).toMatchObject({ status: "error" });
});
