import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseDocument, isMap } from "yaml";

export async function validateManagedTree(repoDir: string) {
  const skillsDir = join(repoDir, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (skillNames.length === 0) throw new Error(`${skillsDir} contains no skills`);

  for (const name of skillNames) await validateSkill(join(skillsDir, name));
  for (const globalFile of ["AGENTS.md", "CLAUDE.md"]) await validateInstruction(repoDir, globalFile);
  return skillNames.sort();
}

async function validateInstruction(repoDir: string, name: string) {
  const path = join(repoDir, name);
  const entry = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return;
  if (entry.isFile()) return;
  if (!entry.isSymbolicLink()) throw new Error(`${path} must be a file`);

  const destination = await realpath(path).catch(() => null);
  if (destination === null) throw new Error(`${path} is a broken symlink`);
  const canonicalRepo = await realpath(repoDir);
  const nested = relative(canonicalRepo, destination);
  if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error(`${path} must resolve inside ${canonicalRepo}`);
  }
  const instructionPaths = new Set(["AGENTS.md", "CLAUDE.md"].map((file) => join(canonicalRepo, file)));
  if (!instructionPaths.has(destination)) {
    throw new Error(`${path} must resolve to AGENTS.md or CLAUDE.md at the repository root`);
  }
  if (!(await stat(destination)).isFile()) throw new Error(`${path} must resolve to a file`);
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
