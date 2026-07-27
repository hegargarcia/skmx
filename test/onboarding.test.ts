import { expect, test } from "bun:test";
import type { PromptApi } from "@bunli/core";
import { pickRepo, pickSkills } from "../src/onboarding.ts";
import type { SkillGroup } from "../src/skills.ts";

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

const copy = (agent: string, name: string) => ({
  name,
  path: `/home/me/.${agent}/skills/${name}`,
  source: `.${agent}/skills`,
});

/** showrunner is kept in two places with the same contents; notes differs. */
const groups: SkillGroup[] = [
  {
    name: "showrunner",
    copies: [copy("claude", "showrunner"), copy("agents", "showrunner")],
    identical: true,
  },
  {
    name: "notes",
    copies: [copy("claude", "notes"), copy("agents", "notes")],
    identical: false,
  },
];

test("lists each skill once, hinting which agents hold it", async () => {
  const prompt = fakePrompt([[]]);

  await pickSkills(prompt, groups, []);

  expect(prompt.asked[0]?.options).toMatchObject({
    options: [
      { label: "showrunner", hint: "claude, agents" },
      { label: "notes", hint: "claude, agents — contents differ" },
    ],
    min: 1,
  });
});

test("does not ask which copy to push when they hold the same files", async () => {
  const prompt = fakePrompt([["showrunner"]]);

  expect(await pickSkills(prompt, groups, [])).toEqual([
    { name: "showrunner", path: "/home/me/.claude/skills/showrunner" },
  ]);
  expect(prompt.asked).toHaveLength(1);
});

test("asks which copy to push when they differ", async () => {
  const prompt = fakePrompt([["notes"], "/home/me/.agents/skills/notes"]);

  expect(await pickSkills(prompt, groups, [])).toEqual([
    { name: "notes", path: "/home/me/.agents/skills/notes" },
  ]);
  expect(prompt.asked[1]).toMatchObject({
    message: "Which copy of notes should be pushed?",
    options: { options: [{ label: "claude" }, { label: "agents" }] },
  });
});

test("pre-selects the skills already being synced", async () => {
  const prompt = fakePrompt([[]]);
  const current = [{ name: "showrunner", path: "/home/me/.claude/skills/showrunner" }];

  await pickSkills(prompt, groups, current);

  expect(prompt.asked[0]?.options).toMatchObject({ initialValues: ["showrunner"] });
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
