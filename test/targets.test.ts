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
  await mkdir(join(repo, "global"));
  await writeFile(join(repo, "skills", "writing", "SKILL.md"), "# Writing\n");
  await writeFile(join(repo, "global", "AGENTS.md"), "# Agents\n");
  await writeFile(join(repo, "global", "CLAUDE.md"), "# Claude\n");
  return { root, repo, home };
}

describe("target projection", () => {
  it("links each skill and global instruction into supported agent homes", async () => {
    const { repo, home } = await fixture();
    const result = await reconcileTargets(repo, home);

    expect(result.blocked).toEqual([]);
    expect(result.links).toHaveLength(6);
    expect(await readlink(join(home, ".claude", "skills", "writing"))).toBe(join(repo, "skills", "writing"));
    expect(await readlink(join(home, ".agents", "AGENTS.md"))).toBe(join(repo, "global", "AGENTS.md"));
    expect(await readlink(join(home, ".claude", "CLAUDE.md"))).toBe(join(repo, "global", "CLAUDE.md"));
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
