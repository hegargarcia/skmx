import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManagedTree } from "../src/validation.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

describe("managed repository validation", () => {
  it("accepts skills plus optional global instructions", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await writeFile(join(root, "skills", "one", "SKILL.md"), "---\nname: one\n---\n# One\n");
    await writeFile(join(root, "CLAUDE.md"), "# Claude\n");
    await expect(validateManagedTree(root)).resolves.toEqual(["one"]);
  });

  it("accepts an instruction alias that resolves inside the repository", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await writeFile(join(root, "skills", "one", "SKILL.md"), "# One\n");
    await writeFile(join(root, "AGENTS.md"), "# Shared\n");
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));

    await expect(validateManagedTree(root)).resolves.toEqual(["one"]);
  });

  it("rejects broken and checkout-escaping instruction aliases", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await writeFile(join(root, "skills", "one", "SKILL.md"), "# One\n");
    await symlink("missing.md", join(root, "CLAUDE.md"));
    await expect(validateManagedTree(root)).rejects.toThrow("broken symlink");

    const other = await tempRoot();
    await writeFile(join(other, "instructions.md"), "# External\n");
    await symlink(join(other, "instructions.md"), join(root, "AGENTS.md"));
    await expect(validateManagedTree(root)).rejects.toThrow("must resolve inside");
  });

  it("rejects an instruction alias to unmanaged repository content", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await writeFile(join(root, "skills", "one", "SKILL.md"), "# One\n");
    await writeFile(join(root, "notes.txt"), "not managed\n");
    await symlink("notes.txt", join(root, "CLAUDE.md"));

    await expect(validateManagedTree(root)).rejects.toThrow(
      "must resolve to AGENTS.md or CLAUDE.md at the repository root",
    );
  });

  it("stops on duplicate YAML keys before agents can read them", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "broken"), { recursive: true });
    await writeFile(join(root, "skills", "broken", "SKILL.md"), "---\nname: one\nname: two\n---\n");
    await expect(validateManagedTree(root)).rejects.toThrow("invalid YAML frontmatter");
  });

  it("requires at least one complete skill", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills"));
    await expect(validateManagedTree(root)).rejects.toThrow("contains no skills");
  });
});
