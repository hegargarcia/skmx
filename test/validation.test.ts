import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManagedTree } from "../src/validation.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterEach(cleanupRoots);

describe("managed repository validation", () => {
  it("accepts skills plus optional global instructions", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await mkdir(join(root, "global"));
    await writeFile(join(root, "skills", "one", "SKILL.md"), "---\nname: one\n---\n# One\n");
    await writeFile(join(root, "global", "CLAUDE.md"), "# Claude\n");
    await expect(validateManagedTree(root)).resolves.toEqual(["one"]);
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
