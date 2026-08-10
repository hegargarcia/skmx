import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, isMap } from "yaml";

export async function validateManagedTree(repoDir: string) {
  const skillsDir = join(repoDir, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (skillNames.length === 0) throw new Error(`${skillsDir} contains no skills`);

  for (const name of skillNames) await validateSkill(join(skillsDir, name));
  for (const globalFile of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(repoDir, "global", globalFile);
    const info = await stat(path).catch(() => null);
    if (info !== null && !info.isFile()) throw new Error(`${path} must be a file`);
  }
  return skillNames.sort();
}

async function validateSkill(directory: string) {
  const path = join(directory, "SKILL.md");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(`${directory} has no readable SKILL.md`);
  }
  if (contents.trim() === "") throw new Error(`${path} is empty`);
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) return;

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (frontmatter?.[1] === undefined) throw new Error(`${path} has unclosed YAML frontmatter`);
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    const detail = document.errors[0]?.message ?? "frontmatter must be a YAML mapping";
    throw new Error(`${path} has invalid YAML frontmatter: ${detail}`);
  }
}
