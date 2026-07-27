import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentName,
  discoverSkills,
  githubSlug,
  groupSkills,
  linkSkills,
  repoDirName,
  sshUrl,
} from "../src/skills.ts";

let home: string;

const addSkill = async (agentDir: string, name: string, withSkillFile = true) => {
  const path = join(home, agentDir, name);
  await mkdir(path, { recursive: true });
  if (withSkillFile) await Bun.write(join(path, "SKILL.md"), `# ${name}\n`);
  return path;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "skill-sync-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("finds skills across every agent directory", async () => {
  const claude = await addSkill(".claude/skills", "showrunner");
  const agents = await addSkill(".agents/skills", "personal-code-style");
  const codex = await addSkill(".codex/skills", "release-notes");

  expect(await discoverSkills(home)).toEqual([
    { name: "showrunner", path: claude, source: ".claude/skills" },
    { name: "personal-code-style", path: agents, source: ".agents/skills" },
    { name: "release-notes", path: codex, source: ".codex/skills" },
  ]);
});

test("lists the same skill once per directory it appears in", async () => {
  await addSkill(".claude/skills", "showrunner");
  await addSkill(".agents/skills", "showrunner");

  const found = await discoverSkills(home);

  expect(found).toHaveLength(2);
  expect(found.map((skill) => skill.source)).toEqual([".claude/skills", ".agents/skills"]);
});

test("ignores directories without a SKILL.md and missing agent directories", async () => {
  await addSkill(".claude/skills", "not-a-skill", false);

  expect(await discoverSkills(home)).toEqual([]);
});

test("groups the copies of one skill into a single entry", async () => {
  await addSkill(".claude/skills", "showrunner");
  await addSkill(".agents/skills", "showrunner");
  await addSkill(".codex/skills", "release-notes");

  const grouped = await groupSkills(await discoverSkills(home));

  expect(grouped.map((group) => group.name)).toEqual(["showrunner", "release-notes"]);
  expect(grouped[0]?.copies).toHaveLength(2);
  expect(grouped[0]?.identical).toBe(true);
});

test("marks a skill whose copies hold different contents", async () => {
  await addSkill(".claude/skills", "showrunner");
  const other = await addSkill(".agents/skills", "showrunner");
  await Bun.write(join(other, "SKILL.md"), "# showrunner, edited\n");

  const [group] = await groupSkills(await discoverSkills(home));

  expect(group?.identical).toBe(false);
});

test("counts an extra file as a difference between copies", async () => {
  await addSkill(".claude/skills", "showrunner");
  const other = await addSkill(".agents/skills", "showrunner");
  await Bun.write(join(other, "reference.md"), "notes\n");

  const [group] = await groupSkills(await discoverSkills(home));

  expect(group?.identical).toBe(false);
});

test("ignores timestamps when comparing copies", async () => {
  const claude = await addSkill(".claude/skills", "showrunner");
  await addSkill(".agents/skills", "showrunner");
  const backdated = new Date("2020-01-01T00:00:00Z");
  await utimes(join(claude, "SKILL.md"), backdated, backdated);

  const [group] = await groupSkills(await discoverSkills(home));

  expect(group?.identical).toBe(true);
});

test.each([
  [".claude/skills", "claude"],
  [".agents/skills", "agents"],
  [".codex/skills", "codex"],
])("names the agent behind %p", (source, expected) => {
  expect(agentName(source)).toBe(expected);
});

test.each([
  ["git@github.com:HegarGarcia/skills.git", "HegarGarcia/skills"],
  ["https://github.com/HegarGarcia/skills.git", "HegarGarcia/skills"],
  ["https://github.com/HegarGarcia/skills", "HegarGarcia/skills"],
  ["HegarGarcia/skills", "HegarGarcia/skills"],
])("reads the skills.sh slug out of %p", (repo, expected) => {
  expect(githubSlug(repo)).toBe(expected);
});

test.each(["/tmp/local/remote.git", "git@gitlab.com:me/skills.git", "", "one/two/three"])(
  "has no slug for %p, so no install is triggered",
  (repo) => {
    expect(githubSlug(repo)).toBeNull();
  },
);

test("builds the ssh url a git remote needs", () => {
  expect(sshUrl("HegarGarcia/skills")).toBe("git@github.com:HegarGarcia/skills.git");
});

test.each([
  ["git@github.com:HegarGarcia/skills.git", "HegarGarcia/skills"],
  ["/tmp/somewhere/remote.git", "remote"],
  ["https://gitlab.com/me/my-skills.git", "my-skills"],
])("clones %p into %p", (repo, expected) => {
  expect(repoDirName(repo)).toBe(expected);
});

/** A clone to link against, holding one skill. */
async function clone(name: string, body = "# showrunner\n") {
  const path = join(home, "repos", "owner", "repo");
  await Bun.write(join(path, "skills", name, "SKILL.md"), body);
  return path;
}

test("links a skill into every agent directory", async () => {
  const clonePath = await clone("showrunner");

  const { linked, blocked } = await linkSkills(clonePath, ["showrunner"], home);

  expect(blocked).toEqual([]);
  expect(linked.map((outcome) => outcome.agent)).toEqual(["claude", "agents", "codex"]);
  for (const agent of [".claude", ".agents", ".codex"]) {
    const target = join(home, agent, "skills", "showrunner");
    expect(await readlink(target)).toBe(join(clonePath, "skills", "showrunner"));
    expect(await Bun.file(join(target, "SKILL.md")).text()).toBe("# showrunner\n");
  }
});

test("leaves links that already point at the clone alone", async () => {
  const clonePath = await clone("showrunner");
  await linkSkills(clonePath, ["showrunner"], home);

  expect(await linkSkills(clonePath, ["showrunner"], home)).toEqual({ linked: [], blocked: [] });
});

test("repoints a link that went somewhere else", async () => {
  const clonePath = await clone("showrunner");
  const target = join(home, ".claude", "skills", "showrunner");
  await mkdir(dirname(target), { recursive: true });
  await symlink(join(home, "elsewhere"), target);

  await linkSkills(clonePath, ["showrunner"], home);

  expect(await readlink(target)).toBe(join(clonePath, "skills", "showrunner"));
});

test("replaces a real directory that already holds what the clone holds", async () => {
  const clonePath = await clone("showrunner");
  await Bun.write(join(home, ".claude", "skills", "showrunner", "SKILL.md"), "# showrunner\n");

  const { blocked } = await linkSkills(clonePath, ["showrunner"], home);

  expect(blocked).toEqual([]);
  expect(await readlink(join(home, ".claude", "skills", "showrunner"))).toContain("repos");
});

test("leaves a real directory whose contents were never pushed", async () => {
  const clonePath = await clone("showrunner");
  const target = join(home, ".claude", "skills", "showrunner");
  await Bun.write(join(target, "SKILL.md"), "# unpushed edits\n");

  const { linked, blocked } = await linkSkills(clonePath, ["showrunner"], home);

  expect(blocked).toEqual([{ skill: "showrunner", agent: "claude", path: target }]);
  expect(linked.map((outcome) => outcome.agent)).toEqual(["agents", "codex"]);
  expect(await Bun.file(join(target, "SKILL.md")).text()).toBe("# unpushed edits\n");
});
