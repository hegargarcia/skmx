import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { readRuns } from "../src/runs.ts";
import { runSync } from "../src/sync.ts";
import { cleanupRoots, createRemote, deviceConfig, git, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

describe("Git synchronization", () => {
  it("clones, links, commits edits made through an agent path, and pushes them", async () => {
    const { remote } = await createRemote();
    const device = await deviceConfig(remote);
    const first = await runSync(device.config);
    expect(first.status, first.summary).toBe("ok");
    expect(first.summary).toContain("linked 5 targets");

    const linked = join(device.config.agentHome, ".claude", "skills", "writing", "SKILL.md");
    await writeFile(linked, `${await readFile(linked, "utf8")}\nLocal edit.\n`);
    const second = await runSync(await loadConfig(device.env));
    expect(second).toMatchObject({ status: "ok" });
    expect(second.summary).toContain("saved local changes");
    expect(second.summary).toContain("pushed 1 commit");

    const remoteContents = await git(device.root, "--git-dir", remote, "show", "main:skills/writing/SKILL.md");
    expect(remoteContents.stdout).toContain("Local edit.");
    expect(await readRuns(device.config.runsPath)).toHaveLength(2);
  });

  it("converges non-overlapping edits from two devices", async () => {
    const { remote } = await createRemote();
    const one = await deviceConfig(remote);
    const two = await deviceConfig(remote);
    await runSync(one.config);
    await runSync(two.config);

    const oneSkill = join(one.config.repoDir, "skills", "writing", "SKILL.md");
    const twoSkill = join(two.config.repoDir, "skills", "writing", "SKILL.md");
    await writeFile(oneSkill, (await readFile(oneSkill, "utf8")).replace("Write clearly", "Write exceptionally clearly"));
    await writeFile(twoSkill, (await readFile(twoSkill, "utf8")).replace("Keep it short.", "Keep it concise."));

    expect((await runSync(await loadConfig(one.env))).status).toBe("ok");
    const result = await runSync(await loadConfig(two.env));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("merged 1 remote commit");
    const contents = (await git(two.root, "--git-dir", remote, "show", "main:skills/writing/SKILL.md")).stdout;
    expect(contents).toContain("Write exceptionally clearly");
    expect(contents).toContain("Keep it concise.");
  });

  it("stops on overlapping edits, aborts the merge, and leaves the remote untouched", async () => {
    const { remote } = await createRemote();
    const one = await deviceConfig(remote);
    const two = await deviceConfig(remote);
    await runSync(one.config);
    await runSync(two.config);
    const oneSkill = join(one.config.repoDir, "skills", "writing", "SKILL.md");
    const twoSkill = join(two.config.repoDir, "skills", "writing", "SKILL.md");
    await writeFile(oneSkill, (await readFile(oneSkill, "utf8")).replace("Keep it clear.", "Device one."));
    await writeFile(twoSkill, (await readFile(twoSkill, "utf8")).replace("Keep it clear.", "Device two."));

    await runSync(await loadConfig(one.env));
    const result = await runSync(await loadConfig(two.env));
    expect(result.status).toBe("conflict");
    expect(result.summary).toContain("nothing was pushed");
    expect(result.summary).toContain("git merge origin/main");
    expect(await readFile(twoSkill, "utf8")).toContain("Device two.");
    expect(await readFile(twoSkill, "utf8")).not.toContain("<<<<<<<");
    const remoteContents = (await git(two.root, "--git-dir", remote, "show", "main:skills/writing/SKILL.md")).stdout;
    expect(remoteContents).toContain("Device one.");
    expect(remoteContents).not.toContain("Device two.");
  });

  it("rejects a clean merge that would leave no valid skills", async () => {
    const { remote } = await createRemote();
    const device = await deviceConfig(remote);
    await runSync(device.config);
    await writeFile(join(device.config.repoDir, "global", "AGENTS.md"), "local global edit\n");

    const other = join(await tempRoot(), "other");
    await git(join(other, ".."), "clone", remote, other);
    await git(other, "rm", "-r", "skills");
    await git(other, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "remove skills");
    await git(other, "push", "origin", "main");

    const result = await runSync(await loadConfig(device.env));
    expect(result.status).toBe("conflict");
    expect(result.summary).toContain("invalid managed content");
    expect(await readFile(join(device.config.repoDir, "skills", "writing", "SKILL.md"), "utf8")).toContain("# Writing");
  });

  it("does not commit unrelated files from the application-owned checkout", async () => {
    const { remote } = await createRemote();
    const device = await deviceConfig(remote);
    await runSync(device.config);
    await writeFile(join(device.config.repoDir, "notes.txt"), "private scratch\n");
    await writeFile(join(device.config.repoDir, "global", "AGENTS.md"), "managed edit\n");
    const result = await runSync(await loadConfig(device.env));
    expect(result.status).toBe("ok");
    await expect(git(device.root, "--git-dir", remote, "show", "main:notes.txt")).rejects.toThrow();
  });

  it("names managed files excluded by the repository's ignore rules", async () => {
    const { remote, seed } = await createRemote();
    await writeFile(join(seed, ".gitignore"), "*.log\n");
    await git(seed, "add", ".gitignore");
    await git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore logs");
    await git(seed, "push", "origin", "main");
    const device = await deviceConfig(remote);
    await runSync(device.config);
    await writeFile(join(device.config.repoDir, "skills", "writing", "notes.log"), "not synced\n");

    const result = await runSync(await loadConfig(device.env));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain(".gitignore excludes skills/writing/notes.log");
  });
});
