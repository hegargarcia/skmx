import { expect, test } from "bun:test";
import type { PromptApi } from "@bunli/core";
import { pickRepo, pickSkills } from "../src/onboarding.ts";
import type { DiscoveredSkill } from "../src/skills.ts";

type Asked = { message: string; options?: unknown };

/**
 * A prompt that answers from a script instead of a terminal, recording what it was
 * asked so the choices offered can be checked.
 */
function fakePrompt(answers: unknown[]) {
  const asked: Asked[] = [];
  const next = (message: string, options?: unknown) => {
    asked.push({ message, options });
    return Promise.resolve(answers[asked.length - 1]);
  };

  const prompt = ((message: string, options?: unknown) => next(message, options)) as PromptApi & {
    asked: Asked[];
  };
  prompt.asked = asked;
  prompt.multiselect = next as PromptApi["multiselect"];
  prompt.select = next as PromptApi["select"];
  return prompt;
}

const available: DiscoveredSkill[] = [
  { name: "showrunner", path: "/home/me/.claude/skills/showrunner", source: ".claude/skills" },
  { name: "showrunner", path: "/home/me/.agents/skills/showrunner", source: ".agents/skills" },
  { name: "release-notes", path: "/home/me/.codex/skills/release-notes", source: ".codex/skills" },
];

test("returns the name and path of each selected skill", async () => {
  const prompt = fakePrompt([
    ["/home/me/.claude/skills/showrunner", "/home/me/.codex/skills/release-notes"],
  ]);

  expect(await pickSkills(prompt, available, [])).toEqual([
    { name: "showrunner", path: "/home/me/.claude/skills/showrunner" },
    { name: "release-notes", path: "/home/me/.codex/skills/release-notes" },
  ]);
});

test("offers each copy of a skill separately, hinted with its agent directory", async () => {
  const prompt = fakePrompt([[]]);

  await pickSkills(prompt, available, []);

  expect(prompt.asked[0]?.options).toMatchObject({
    options: [
      { label: "showrunner", hint: ".claude/skills" },
      { label: "showrunner", hint: ".agents/skills" },
      { label: "release-notes", hint: ".codex/skills" },
    ],
    min: 1,
  });
});

test("pre-selects the skills already being synced", async () => {
  const prompt = fakePrompt([[]]);
  const current = [{ name: "release-notes", path: "/home/me/.codex/skills/release-notes" }];

  await pickSkills(prompt, available, current);

  expect(prompt.asked[0]?.options).toMatchObject({
    initialValues: ["/home/me/.codex/skills/release-notes"],
  });
});

test("turns a chosen repo into the ssh url git needs", async () => {
  const prompt = fakePrompt(["HegarGarcia/skills"]);

  expect(await pickRepo(prompt, [{ nameWithOwner: "HegarGarcia/skills", visibility: "PUBLIC" }]))
    .toEqual({ repo: "git@github.com:HegarGarcia/skills.git" });
});

test("lists creating a repo ahead of the existing ones", async () => {
  const prompt = fakePrompt(["HegarGarcia/skills"]);

  await pickRepo(prompt, [{ nameWithOwner: "HegarGarcia/skills", visibility: "PRIVATE" }]);

  expect(prompt.asked[0]?.options).toMatchObject({
    options: [
      { label: "Create a new repository…" },
      { label: "HegarGarcia/skills", hint: "private" },
    ],
  });
});

test("asks for a name and visibility when creating a repo", async () => {
  const prompt = fakePrompt(["\0create", " my-skills ", "public"]);

  expect(await pickRepo(prompt, [])).toEqual({
    create: { name: "my-skills", visibility: "public" },
  });
  expect(prompt.asked[1]?.options).toMatchObject({ default: "skills" });
});

test("rejects a repository name git could not use", async () => {
  const prompt = fakePrompt(["\0create", "my skills", "public"]);

  await pickRepo(prompt, []);
  const { validate } = prompt.asked[1]?.options as { validate: (value: string) => true | string };

  expect(validate("my-skills")).toBe(true);
  expect(validate("my skills")).toContain("letters, numbers");
});
