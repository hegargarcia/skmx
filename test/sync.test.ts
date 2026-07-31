import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { Config } from "../src/config.ts";
import { runSync } from "../src/sync.ts";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

let root: string;
let config: Config;
/**
 * The agent directory the skills are picked from. It is inside the agent home, as it
 * is in reality, so a synced skill becomes a link into the clone.
 */
let skillsHome: string;
/** A second clone of the remote, standing in for another machine. */
let other: string;

const localFile = (skill: string, file = "SKILL.md") =>
  Bun.file(join(skillsHome, skill, file));
const otherFile = (skill: string, file = "SKILL.md") =>
  Bun.file(join(other, "skills", skill, file));

/** Puts a skill under this machine's control and tells skill-sync to sync it. */
async function selectSkill(name: string) {
  await mkdir(join(skillsHome, name), { recursive: true });
  config = { ...config, skills: [...config.skills, { name, path: join(skillsHome, name) }] };
}

async function pushFromOther(skill: string, body: string, file = "SKILL.md") {
  // The other machine catches up first, as it would in life: skill-sync itself pushes
  // commits of its own, so this clone is usually behind by the time it is used.
  await $`git -C ${other} pull --ff-only`.nothrow().quiet();
  await Bun.write(otherFile(skill, file), body);
  await $`git -C ${other} add -A`.quiet();
  await $`git ${GIT_ID} -C ${other} commit -m ${`edit ${skill}`}`.quiet();
  await $`git -C ${other} push origin main`.quiet();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-sync-test-"));
  const remote = join(root, "remote.git");
  const stateDir = join(root, "state");
  const agentHome = join(root, "agent-home");
  skillsHome = join(agentHome, ".claude", "skills");

  config = {
    repo: remote,
    branch: "main",
    skills: [],
    configPath: join(root, "config.json"),
    checkout: undefined,
    reposDir: join(root, "repos"),
    agentHome,
    stateDir,
    statePath: join(stateDir, "state.json"),
    schedulePath: join(stateDir, "schedule.json"),
    cronLogPath: join(stateDir, "cron.log"),
  };

  await $`git init --bare --initial-branch=main ${remote}`.quiet();
  other = join(root, "other");
  await $`git clone ${remote} ${other}`.quiet();
  await $`git -C ${other} checkout -B main`.quiet();
  await pushFromOther("alpha", "alpha v1\n");

  // This machine's copy of alpha starts out matching the remote.
  await selectSkill("alpha");
  await Bun.write(localFile("alpha"), "alpha v1\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("pushes local skill edits to the remote", async () => {
  await runSync(config);
  await Bun.write(localFile("alpha"), "alpha v2\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(record.summary).toContain("pushed");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("alpha v2\n");
});

test("pushes a newly selected skill", async () => {
  await selectSkill("beta");
  await Bun.write(localFile("beta"), "beta v1\n");

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("beta").text()).toBe("beta v1\n");
});

test("leaves skills the repo has but this machine does not sync", async () => {
  await pushFromOther("gamma", "gamma v1\n");

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("gamma").text()).toBe("gamma v1\n");
});

test("merges commits made to the repo elsewhere", async () => {
  await runSync(config);
  await Bun.write(localFile("alpha"), "alpha v2\n");
  await pushFromOther("gamma", "gamma v1\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  expect(record.summary).toContain("merged 1 commit from origin");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("alpha v2\n");
});

test("refuses the first sync when a selected skill differs on both sides", async () => {
  await Bun.write(localFile("alpha"), "local edit\n");
  await pushFromOther("alpha", "remote edit\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "diverged", commit: null });
  expect(record.summary).toContain("alpha/SKILL.md");
  expect(await localFile("alpha").text()).toBe("local edit\n");
});

test("refuses the first sync when pushing would delete a file from the repo", async () => {
  await pushFromOther("alpha", "extra\n", "reference.md");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "diverged" });
  expect(record.summary).toContain("alpha/reference.md");
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha", "reference.md").exists()).toBe(true);
});

test("keeps refusing a diverged first sync, leaving the remote intact", async () => {
  await Bun.write(localFile("alpha"), "local edit\n");
  await pushFromOther("alpha", "remote edit\n");

  expect(await runSync(config)).toMatchObject({ status: "diverged" });
  // The clone now exists, which must not be mistaken for a synced base.
  expect(await runSync(config)).toMatchObject({ status: "diverged" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("remote edit\n");
});

test("keeps rules added on two machines instead of stopping on them", async () => {
  await runSync(config);
  await Bun.write(localFile("alpha"), "alpha v1\n- rule from here\n");
  await pushFromOther("alpha", "alpha v1\n- rule from the other machine\n");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "ok" });
  const merged = await localFile("alpha").text();
  expect(merged).toContain("- rule from here");
  expect(merged).toContain("- rule from the other machine");
});

test("still reports a conflict for a file union cannot merge", async () => {
  await runSync(config);
  await Bun.write(localFile("alpha", "settings.json"), '{ "from": "here" }\n');
  await runSync(config);
  await Bun.write(localFile("alpha", "settings.json"), '{ "from": "here, edited" }\n');
  await pushFromOther("alpha", '{ "from": "the other machine" }\n', "settings.json");

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "conflict", commit: null });
  expect(record.summary).toContain("skills/alpha/settings.json");
  // The merge is aborted, so the way out is to run it again by hand — say so.
  expect(record.summary).toContain("git merge origin/main");
});

test("no agent ever sees conflict markers in a skill", async () => {
  await runSync(config);
  await Bun.write(localFile("alpha", "settings.json"), '{ "from": "here" }\n');
  await runSync(config);
  await Bun.write(localFile("alpha", "settings.json"), '{ "from": "here, edited" }\n');
  await pushFromOther("alpha", '{ "from": "the other machine" }\n', "settings.json");

  expect(await runSync(config)).toMatchObject({ status: "conflict" });

  for (const agent of [".claude", ".agents", ".codex"]) {
    for (const file of ["SKILL.md", "settings.json"]) {
      const text = await Bun.file(join(config.agentHome, agent, "skills", "alpha", file)).text();
      expect(text).not.toContain("<<<<<<<");
    }
  }
});

test("pushes everything a skill holds, not just its markdown", async () => {
  await Bun.write(localFile("alpha", "references/deep.md"), "deep\n");
  await Bun.write(localFile("alpha", "settings.json"), '{ "on": true }\n');
  await Bun.write(localFile("alpha", ".hidden"), "hidden\n");
  const script = join(skillsHome, "alpha", "run.sh");
  await Bun.write(script, "#!/bin/sh\necho hi\n");
  await $`chmod +x ${script}`.quiet();

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  for (const file of ["references/deep.md", "settings.json", ".hidden", "run.sh"]) {
    expect(await otherFile("alpha", file).exists()).toBe(true);
  }
  // The executable bit survives, so a script in a skill still runs on the next machine.
  const modes = await $`git -C ${other} ls-files --stage skills/alpha/run.sh`.quiet();
  expect(modes.stdout.toString()).toContain("100755");
});

test("keeps pushing non-markdown files as they change", async () => {
  await Bun.write(localFile("alpha", "settings.json"), '{ "on": true }\n');
  await runSync(config);
  await Bun.write(localFile("alpha", "settings.json"), '{ "on": false }\n');

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha", "settings.json").text()).toBe('{ "on": false }\n');
});

test("names the skill files the repo's own gitignore leaves behind", async () => {
  await runSync(config);
  // The rule has to be in place before the file appears: git only ignores what it
  // does not already track.
  await pushFromOther("alpha", "*.log\n", "../../.gitignore");
  await runSync(config);
  await Bun.write(localFile("alpha", "notes.log"), "debug\n");

  const record = await runSync(config);

  expect(record.status).toBe("ok");
  expect(record.summary).toContain("skills/alpha/notes.log");
  expect(record.summary).toContain(".gitignore skipped");
});

test("adds the union attribute once, keeping what the repo already had", async () => {
  const attributes = join(config.reposDir, "remote", ".gitattributes");
  await runSync(config);

  expect(await Bun.file(attributes).text()).toContain("skills/**/*.md merge=union");

  await Bun.write(localFile("alpha"), "alpha v2\n");
  await runSync(config);
  const lines = (await Bun.file(attributes).text()).split("\n");

  expect(lines.filter((line) => line.includes("merge=union"))).toHaveLength(1);
});

test("takes the other machine's work and retries when a push is refused once", async () => {
  await runSync(config);
  const hook = join(root, "remote.git", "hooks", "pre-receive");
  await Bun.write(
    hook,
    ['#!/bin/sh', 'f="$GIT_DIR/refused"', 'if [ ! -f "$f" ]; then touch "$f"; exit 1; fi', "exit 0"].join(
      "\n",
    ),
  );
  await $`chmod +x ${hook}`.quiet();
  await Bun.write(localFile("alpha"), "alpha v2\n");

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("alpha v2\n");
});

test("propagates a file deleted from a skill once a base sync exists", async () => {
  await Bun.write(localFile("alpha", "reference.md"), "notes\n");
  await runSync(config);
  await rm(join(skillsHome, "alpha", "reference.md"));

  expect(await runSync(config)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha", "reference.md").exists()).toBe(false);
});

test("links the pushed skill into the agent directories", async () => {
  const record = await runSync(config);

  expect(record.summary).toContain("linked 3 skills");
  const clone = join(config.reposDir, "remote", "skills", "alpha");
  for (const agent of [".claude", ".agents", ".codex"]) {
    const target = join(config.agentHome, agent, "skills", "alpha");
    expect(await readlink(target)).toBe(clone);
    expect(await Bun.file(join(target, "SKILL.md")).text()).toBe("alpha v1\n");
  }
});

test("keeps syncing once a skill's path resolves into the clone", async () => {
  await runSync(config);
  // The agents now read the clone, so edit through one of their links.
  const linked = join(config.agentHome, ".claude", "skills", "alpha");
  await Bun.write(join(linked, "SKILL.md"), "edited through the link\n");

  const record = await runSync({ ...config, skills: [{ name: "alpha", path: linked }] });

  expect(record).toMatchObject({ status: "ok" });
  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("edited through the link\n");
});

test("treats a timestamp-only difference as in sync", async () => {
  const backdated = new Date("2020-01-01T00:00:00Z");
  await utimes(join(skillsHome, "alpha", "SKILL.md"), backdated, backdated);

  expect(await runSync(config)).toMatchObject({ status: "ok" });
});

test("reports already in sync when nothing changed", async () => {
  await runSync(config);

  expect(await runSync(config)).toMatchObject({ status: "ok", summary: "already in sync" });
});

test("populates a remote that has never been pushed to", async () => {
  const empty = join(root, "empty.git");
  await $`git init --bare --initial-branch=main ${empty}`.quiet();

  const record = await runSync({ ...config, repo: empty });

  expect(record).toMatchObject({ status: "ok" });
  const pushed = await $`git ls-remote ${empty} refs/heads/main`.quiet();
  expect(pushed.stdout.toString()).toContain("refs/heads/main");
});

test("reports git's own reason when a command fails", async () => {
  const record = await runSync({ ...config, repo: join(root, "does-not-exist.git") });

  expect(record.status).toBe("error");
  expect(record.summary).toContain("does not exist");
});

test("works out of a checkout you already keep, instead of cloning its own", async () => {
  const checkout = join(root, "mine");
  await $`git clone ${join(root, "remote.git")} ${checkout}`.quiet();
  // The skill is taken straight from that checkout, which makes it the source.
  const inCheckout = join(checkout, "skills", "alpha");
  const mine = { ...config, checkout, skills: [{ name: "alpha", path: inCheckout }] };
  await Bun.write(join(inCheckout, "SKILL.md"), "edited in my own checkout\n");
  // This machine keeps its skills in the checkout, so the agent directory is free.
  await rm(join(skillsHome, "alpha"), { recursive: true });

  expect(await runSync(mine)).toMatchObject({ status: "ok" });

  await $`git -C ${other} pull --ff-only`.quiet();
  expect(await otherFile("alpha").text()).toBe("edited in my own checkout\n");
  // Nothing was cloned behind your back, and the agents read your checkout.
  expect(await Bun.file(join(config.reposDir, "remote", ".git", "HEAD")).exists()).toBe(false);
  expect(await readlink(join(config.agentHome, ".claude", "skills", "alpha"))).toBe(inCheckout);
});

test("leaves unfinished work in your checkout alone", async () => {
  const checkout = join(root, "mine");
  await $`git clone ${join(root, "remote.git")} ${checkout}`.quiet();
  const mine = {
    ...config,
    checkout,
    skills: [{ name: "alpha", path: join(checkout, "skills", "alpha") }],
  };
  // A draft of something else in the repo, and a scratch file, neither committed.
  await Bun.write(join(checkout, "README.md"), "half-written\n");
  await Bun.write(join(checkout, "notes-to-self.txt"), "keep me\n");

  expect(await runSync(mine)).toMatchObject({ status: "ok" });

  expect(await Bun.file(join(checkout, "README.md")).text()).toBe("half-written\n");
  expect(await Bun.file(join(checkout, "notes-to-self.txt")).text()).toBe("keep me\n");
});

test("refuses a checkout that is not a git repo, rather than clearing it", async () => {
  const notARepo = join(root, "not-a-repo");
  await Bun.write(join(notARepo, "precious.txt"), "do not delete me\n");

  const record = await runSync({ ...config, checkout: notARepo });

  expect(record).toMatchObject({ status: "error" });
  expect(record.summary).toContain("is not a git checkout");
  expect(await Bun.file(join(notARepo, "precious.txt")).exists()).toBe(true);
});

test("refuses a checkout of a different repo", async () => {
  const elsewhere = join(root, "elsewhere.git");
  const checkout = join(root, "wrong");
  await $`git init --bare --initial-branch=main ${elsewhere}`.quiet();
  await $`git clone ${elsewhere} ${checkout}`.quiet();

  const record = await runSync({ ...config, checkout });

  expect(record).toMatchObject({ status: "error" });
  expect(record.summary).toContain("not");
});

test("reports a skill that is no longer where it was selected from", async () => {
  await rm(join(skillsHome, "alpha"), { recursive: true });

  const record = await runSync(config);

  expect(record).toMatchObject({ status: "error" });
  expect(record.summary).toContain("alpha");
});

test("reports having nothing selected to sync", async () => {
  const record = await runSync({ ...config, skills: [] });

  expect(record).toMatchObject({ status: "error" });
  expect(record.summary).toContain("no skills selected");
});
