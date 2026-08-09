import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightTargets, reconcileTargets, removeOwnedTargets } from "../src/targets.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

async function fixture() {
  const root = await tempRoot();
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(join(repo, "skills", "writing"), { recursive: true });
  await writeFile(join(repo, "skills", "writing", "SKILL.md"), "# Writing\n");
  await writeFile(join(repo, "AGENTS.md"), "# Agents\n");
  await writeFile(join(repo, "CLAUDE.md"), "# Claude\n");
  return { root, repo, home };
}

describe("target projection", () => {
  it("links each skill and global instruction into supported agent homes", async () => {
    const { repo, home } = await fixture();
    const result = await reconcileTargets(repo, home);

    expect(result.blocked).toEqual([]);
    expect(result.links).toHaveLength(6);
    expect(await readlink(join(home, ".claude", "skills", "writing"))).toBe(join(repo, "skills", "writing"));
    expect(await readlink(join(home, ".agents", "AGENTS.md"))).toBe(join(repo, "AGENTS.md"));
    expect(await readlink(join(home, ".claude", "CLAUDE.md"))).toBe(join(repo, "CLAUDE.md"));
  });

  it("uses AGENTS.md as Claude's shared instructions when CLAUDE.md is absent", async () => {
    const { repo, home } = await fixture();
    await rm(join(repo, "CLAUDE.md"));

    await reconcileTargets(repo, home);

    expect(await readlink(join(home, ".claude", "CLAUDE.md"))).toBe(join(repo, "AGENTS.md"));
  });

  it("repoints an owned Claude link when dedicated instructions are added or removed", async () => {
    const { repo, home } = await fixture();
    await rm(join(repo, "CLAUDE.md"));
    const shared = await reconcileTargets(repo, home);
    const target = join(home, ".claude", "CLAUDE.md");
    expect(await readlink(target)).toBe(join(repo, "AGENTS.md"));

    await writeFile(join(repo, "CLAUDE.md"), "# Dedicated Claude\n");
    expect(await preflightTargets(repo, home, shared.links)).toEqual([]);
    const dedicated = await reconcileTargets(repo, home, shared.links);
    expect(dedicated.blocked).toEqual([]);
    expect(await readlink(target)).toBe(join(repo, "CLAUDE.md"));

    await rm(join(repo, "CLAUDE.md"));
    expect(await preflightTargets(repo, home, dedicated.links)).toEqual([]);
    const fallback = await reconcileTargets(repo, home, dedicated.links);
    expect(fallback.blocked).toEqual([]);
    expect(await readlink(target)).toBe(join(repo, "AGENTS.md"));
  });

  it("reports all different existing content before changing any target", async () => {
    const { repo, home } = await fixture();
    await mkdir(join(home, ".claude", "skills", "writing"), { recursive: true });
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "writing", "SKILL.md"), "local work\n");
    await writeFile(join(home, ".agents", "AGENTS.md"), "local instructions\n");

    const blocked = await preflightTargets(repo, home);
    const result = await reconcileTargets(repo, home);
    expect(blocked).toHaveLength(2);
    expect(result.blocked).toHaveLength(2);
    expect(await readFile(join(home, ".claude", "skills", "writing", "SKILL.md"), "utf8")).toBe("local work\n");
    await expect(lstat(join(home, ".agents", "skills", "writing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts identical content but only removes links it still owns", async () => {
    const { repo, home } = await fixture();
    const target = join(home, ".agents", "AGENTS.md");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(target, "# Agents\n");
    const result = await reconcileTargets(repo, home);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    await removeOwnedTargets(repo, result.links);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(target, "user replacement\n");
    expect(await removeOwnedTargets(repo, [target])).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("user replacement\n");
  });

  it("repoints byte-identical symlinks and leaves unrelated links alone", async () => {
    const { root, repo, home } = await fixture();
    const previous = join(root, "previous");
    const previousSkill = join(previous, "skills", "writing");
    const target = join(home, ".claude", "skills", "writing");
    const unrelatedSource = join(previous, "skills", "gh-stack");
    const unrelatedTarget = join(home, ".claude", "skills", "gh-stack");
    await mkdir(previousSkill, { recursive: true });
    await mkdir(unrelatedSource, { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await writeFile(join(previousSkill, "SKILL.md"), "# Writing\n");
    await writeFile(join(unrelatedSource, "SKILL.md"), "# gh-stack\n");
    await symlink(previousSkill, target, "dir");
    await symlink(unrelatedSource, unrelatedTarget, "dir");

    const result = await reconcileTargets(repo, home);

    expect(result.blocked).toEqual([]);
    expect(await readlink(target)).toBe(join(repo, "skills", "writing"));
    expect(await readlink(unrelatedTarget)).toBe(unrelatedSource);
    expect(await readFile(join(previousSkill, "SKILL.md"), "utf8")).toBe("# Writing\n");
  });

  it("stops before repointing any symlink when one target has different content", async () => {
    const { root, repo, home } = await fixture();
    const previous = join(root, "previous");
    const matching = join(previous, "matching");
    const different = join(previous, "different");
    const matchingTarget = join(home, ".claude", "skills", "writing");
    const differentTarget = join(home, ".agents", "skills", "writing");
    await mkdir(matching, { recursive: true });
    await mkdir(different, { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await writeFile(join(matching, "SKILL.md"), "# Writing\n");
    await writeFile(join(different, "SKILL.md"), "local work\n");
    await symlink(matching, matchingTarget, "dir");
    await symlink(different, differentTarget, "dir");

    const result = await reconcileTargets(repo, home);

    expect(result.blocked.map((item) => item.target)).toContain(differentTarget);
    expect(await readlink(matchingTarget)).toBe(matching);
    expect(await readlink(differentTarget)).toBe(different);
    await expect(lstat(join(home, ".codex", "skills", "writing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats nested symlinks as content when checking for collisions", async () => {
    const { repo, home } = await fixture();
    const target = join(home, ".claude", "skills", "writing");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# Writing\n");
    await symlink("SKILL.md", join(target, "local-reference"));

    const result = await reconcileTargets(repo, home);
    expect(result.blocked.map((item) => item.target)).toContain(target);
    expect(await readlink(join(target, "local-reference"))).toBe("SKILL.md");
  });

  it("cannot confuse file contents with the metadata for a second file", async () => {
    const { repo, home } = await fixture();
    const source = join(repo, "skills", "writing");
    const target = join(home, ".claude", "skills", "writing");
    await rm(join(source, "SKILL.md"));
    await writeFile(join(source, "a"), "Xfile:0:b\0Y");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "a"), "X");
    await writeFile(join(target, "b"), "Y");

    const result = await reconcileTargets(repo, home);
    expect(result.blocked.map((item) => item.target)).toContain(target);
    expect(await readFile(join(target, "b"), "utf8")).toBe("Y");
  });
});
