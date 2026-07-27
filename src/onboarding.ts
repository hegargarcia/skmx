import type { PromptApi } from "@bunli/core";
import type { SyncedSkill } from "./config.ts";
import { sshUrl, type DiscoveredSkill } from "./skills.ts";

/** Sentinel for "none of the listed repos"; no repo name can collide with it. */
const CREATE = "\0create";

export type RepoChoice =
  | { repo: string }
  | { create: { name: string; visibility: "public" | "private" } };

export type RepoOption = { nameWithOwner: string; visibility: string };

/**
 * Asks which of the discovered skills to sync. The same skill can appear in more
 * than one agent directory with different contents, so each copy is offered
 * separately, hinted with where it lives.
 */
export async function pickSkills(
  prompt: PromptApi,
  available: DiscoveredSkill[],
  current: SyncedSkill[],
) {
  const selected = await prompt.multiselect("Which skills should be synced?", {
    options: available.map((skill) => ({
      value: skill.path,
      label: skill.name,
      hint: skill.source,
    })),
    initialValues: current.map((skill) => skill.path),
    min: 1,
  });

  return available
    .filter((skill) => selected.includes(skill.path))
    .map(({ name, path }): SyncedSkill => ({ name, path }));
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
