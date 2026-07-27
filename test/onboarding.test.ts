import { expect, test } from "bun:test";
import type { PromptApi } from "@bunli/core";
import { pickRepo, pickSchedule, pickSkills } from "../src/onboarding.ts";
import type { SkillGroup } from "../src/skills.ts";

type Asked = { message: string; options?: unknown };

/**
 * A prompt that answers from a script instead of a terminal, recording what it was
 * asked so the choices offered can be checked.
 */
function fakePrompt(answers: unknown[]) {
  const asked: Asked[] = [];
  const warnings: string[] = [];
  const next = (message: string, options?: unknown) => {
    asked.push({ message, options });
    return Promise.resolve(answers[asked.length - 1]);
  };

  const prompt = ((message: string, options?: unknown) => next(message, options)) as PromptApi & {
    asked: Asked[];
    warnings: string[];
  };
  prompt.asked = asked;
  prompt.warnings = warnings;
  prompt.multiselect = next as PromptApi["multiselect"];
  prompt.select = next as PromptApi["select"];
  prompt.log = {
    warn: (message: string) => void warnings.push(message),
    info: () => {},
    success: () => {},
    error: () => {},
  } as PromptApi["log"];
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
      { label: "showrunner", hint: "claude · agents" },
      { label: "notes", hint: "claude · agents  ⚠ contents differ" },
    ],
    min: 1,
  });
});

test("warns up front about the skills that are not the same everywhere", async () => {
  const prompt = fakePrompt([[]]);

  await pickSkills(prompt, groups, []);

  expect(prompt.warnings).toHaveLength(1);
  expect(prompt.warnings[0]).toContain("⚠ notes is not the same everywhere");
});

test("says nothing up front when every copy matches", async () => {
  const prompt = fakePrompt([[]]);

  await pickSkills(prompt, [groups[0]!], []);

  expect(prompt.warnings).toEqual([]);
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
    message: "⚠ Copies of notes differ — which one wins?",
    options: { options: [{ label: "claude" }, { label: "agents" }] },
  });
});

test("pre-selects the skills already being synced", async () => {
  const prompt = fakePrompt([[]]);
  const current = [{ name: "showrunner", path: "/home/me/.claude/skills/showrunner" }];

  await pickSkills(prompt, groups, current);

  expect(prompt.asked[0]?.options).toMatchObject({ initialValues: ["showrunner"] });
});

const EVERY_DAY = ["1", "2", "3", "4", "5", "6", "0"];

test("asks for the days before the time, every day at midnight by default", async () => {
  const prompt = fakePrompt([EVERY_DAY, "00:00"]);

  expect(await pickSchedule(prompt)).toEqual({ hour: 0, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] });
  expect(prompt.asked.map((asked) => asked.message)).toEqual([
    "Which days should the skills sync?",
    "What time? 09:00 · 00:00 · 21:00",
  ]);
  expect(prompt.asked[0]?.options).toMatchObject({ initialValues: EVERY_DAY, min: 1 });
  expect(prompt.asked[1]?.options).toMatchObject({ default: "00:00" });
});

test("ticks every day of the week, read Monday first", async () => {
  const prompt = fakePrompt([EVERY_DAY, "00:00"]);

  await pickSchedule(prompt);

  expect(
    (prompt.asked[0]?.options as { options: { label: string }[] }).options.map((o) => o.label),
  ).toEqual([
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
    "Sundays",
  ]);
});

test("keeps the chosen days and a typed time", async () => {
  const prompt = fakePrompt([["1", "4"], "3:30pm"]);

  expect(await pickSchedule(prompt)).toEqual({ hour: 15, minute: 30, days: [1, 4] });
});

test("starts from the schedule already in place", async () => {
  const prompt = fakePrompt([["2"], "06:15"]);

  await pickSchedule(prompt, { hour: 6, minute: 15, days: [2] });

  expect(prompt.asked[0]?.options).toMatchObject({ initialValues: ["2"] });
  expect(prompt.asked[1]?.options).toMatchObject({ default: "06:15" });
});

test("rejects a time it cannot read", async () => {
  const prompt = fakePrompt([EVERY_DAY, "00:00"]);

  await pickSchedule(prompt);
  const { validate } = prompt.asked[1]?.options as { validate: (value: string) => true | string };

  expect(validate("3:30pm")).toBe(true);
  expect(validate("9am")).toBe(true);
  expect(validate("25:00")).toContain("24-hour");
});

test("turns a chosen repo into the ssh url git needs", async () => {
  const prompt = fakePrompt(["HegarGarcia/skills"]);

  expect(await pickRepo(prompt, [{ nameWithOwner: "HegarGarcia/skills", visibility: "PUBLIC" }]))
    .toEqual({ repo: "git@github.com:HegarGarcia/skills.git" });
});

test("starts on the repo already in use, and says which one it is", async () => {
  const prompt = fakePrompt(["HegarGarcia/skills"]);
  const repos = [
    { nameWithOwner: "HegarGarcia/other", visibility: "PUBLIC" },
    { nameWithOwner: "HegarGarcia/skills", visibility: "PUBLIC" },
  ];

  await pickRepo(prompt, repos, "HegarGarcia/skills");

  expect(prompt.asked[0]?.options).toMatchObject({
    default: "HegarGarcia/skills",
    options: [
      { label: "Create a new repository…" },
      { label: "HegarGarcia/other", hint: "public" },
      { label: "HegarGarcia/skills", hint: "public · in use" },
    ],
  });
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
