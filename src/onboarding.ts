import type { PromptApi } from "@bunli/core";
import type { SyncedSkill } from "./config.ts";
import { agentName, sshUrl, type SkillGroup } from "./skills.ts";

/** Sentinel for "none of the listed repos"; no repo name can collide with it. */
const CREATE = "\0create";

export type RepoChoice =
  | { repo: string }
  | { create: { name: string; visibility: "public" | "private" } };

export type RepoOption = { nameWithOwner: string; visibility: string };

/**
 * Asks which skills to sync, listing each one once with the agents that hold it.
 * Copies that hold the same files need no further question; when they differ, only
 * one can be the source, so that gets asked per skill.
 */
export async function pickSkills(
  prompt: PromptApi,
  groups: SkillGroup[],
  current: SyncedSkill[],
) {
  const selected = await prompt.multiselect("Which skills should be synced?", {
    options: groups.map((group) => ({
      value: group.name,
      label: group.name,
      hint: describeCopies(group),
    })),
    initialValues: current.map((skill) => skill.name),
    min: 1,
  });

  const chosen: SyncedSkill[] = [];
  for (const group of groups.filter((group) => selected.includes(group.name))) {
    chosen.push({ name: group.name, path: await pickCopy(prompt, group) });
  }

  return chosen;
}

const describeCopies = ({ copies, identical }: SkillGroup) => {
  const agents = copies.map((copy) => agentName(copy.source)).join(", ");
  return identical ? agents : `${agents} — contents differ`;
};

async function pickCopy(prompt: PromptApi, group: SkillGroup) {
  const [first, ...rest] = group.copies;
  if (rest.length === 0 || group.identical) return first!.path;

  return await prompt.select(`Which copy of ${group.name} should be pushed?`, {
    options: group.copies.map((copy) => ({
      value: copy.path,
      label: agentName(copy.source),
      hint: copy.path,
    })),
  });
}

/** Asks which repo to sync to, offering to create one. */
export async function pickRepo(prompt: PromptApi, repos: RepoOption[]): Promise<RepoChoice> {
  const choice = await prompt.select("Which repo should the skills live in?", {
    options: [
      { value: CREATE, label: "Create a new repository…" },
      ...repos.map((repo) => ({
        value: repo.nameWithOwner,
        label: repo.nameWithOwner,
        hint: repo.visibility.toLowerCase(),
      })),
    ],
  });
  if (choice !== CREATE) return { repo: sshUrl(choice) };

  const name = await prompt("Name for the new repository", {
    default: "skills",
    validate: (value) =>
      /^[\w.-]+$/.test(value.trim()) || "letters, numbers, dot, dash and underscore only",
  });
  const visibility = await prompt.select("Visibility", {
    options: [
      { value: "public" as const, label: "Public", hint: "skills.sh installs without credentials" },
      { value: "private" as const, label: "Private", hint: "needs git credentials to install" },
    ],
  });

  return { create: { name: name.trim(), visibility } };
}
