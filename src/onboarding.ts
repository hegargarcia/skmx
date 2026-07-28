import type { PromptApi } from "@bunli/core";
import type { SyncedSkill } from "./config.ts";
import {
  ALL_DAYS,
  dayName,
  everyHour,
  formatTimeOfDay,
  TimeOfDay,
  type Schedule,
} from "./cron.ts";
import { agentName, sshUrl, type SkillGroup } from "./skills.ts";
import { SEPARATOR, WARN } from "./ui.ts";

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
  const divided = groups.filter((group) => !group.identical);
  if (divided.length > 0) {
    prompt.log.warn(
      `${WARN} ${divided.map((group) => group.name).join(", ")} ` +
        `${divided.length === 1 ? "is" : "are"} not the same everywhere — ` +
        `you will choose which copy to push`,
    );
  }

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

/**
 * Rows are drawn as one line in one colour, so the warning is carried by a glyph
 * rather than by red text that would arrive as escape codes.
 */
const describeCopies = ({ copies, identical }: SkillGroup) => {
  const agents = copies.map((copy) => agentName(copy.source)).join(SEPARATOR);
  return identical ? agents : `${agents}  ${WARN} contents differ`;
};

async function pickCopy(prompt: PromptApi, group: SkillGroup) {
  const [first, ...rest] = group.copies;
  if (rest.length === 0 || group.identical) return first!.path;

  return await prompt.select(`${WARN} Copies of ${group.name} differ — which one wins?`, {
    options: group.copies.map((copy) => ({
      value: copy.path,
      label: agentName(copy.source),
      hint: copy.path,
    })),
  });
}

/** Offered as one keystroke each; any other time can be typed instead. */
const SUGGESTED_TIMES = ["09:00", "00:00", "21:00"] as const;

const HOURLY = "hourly";
const PICK_DAYS = "pick";

/**
 * The handful of rhythms most schedules actually are, which is how calendars and job
 * monitors ask this: common shapes first, the day-by-day choice last.
 *
 * Hourly leads because it is what keeps several machines close together — the less
 * time between syncs, the less chance two of them edit the same skill in the gap.
 */
const CADENCES = [
  { value: "daily", label: "Every day", hint: "at a time you choose", days: [...ALL_DAYS] },
  { value: "weekdays", label: "Weekdays", hint: "Mon–Fri", days: [1, 2, 3, 4, 5] },
  { value: "weekends", label: "Weekends", hint: "Sat & Sun", days: [6, 0] },
] as const;

const sameDays = (one: number[], other: readonly number[]) =>
  one.length === other.length && [...one].sort().join() === [...other].sort().join();

/**
 * Asks when to sync: how often first, then the time for anything less than hourly.
 * Defaults to every hour, or to whatever is already scheduled.
 */
export async function pickSchedule(prompt: PromptApi, current = everyHour()) {
  const matching = CADENCES.find((cadence) => sameDays(current.days, cadence.days));

  const cadence = await prompt.select("How often should the skills sync?", {
    options: [
      { value: HOURLY, label: "Every hour", hint: "recommended, keeps machines in step" },
      ...CADENCES.map(({ value, label, hint }) => ({ value, label, hint })),
      { value: PICK_DAYS, label: "Pick days…", hint: "choose them one by one" },
    ],
    default: current.hour === null ? HOURLY : (matching?.value ?? PICK_DAYS),
  });

  // Every hour needs no time, which leaves the common answer a single keystroke.
  if (cadence === HOURLY) return everyHour();

  const days =
    cadence === PICK_DAYS
      ? await pickDays(prompt, current.days)
      : [...CADENCES.find(({ value }) => value === cadence)!.days];

  const answer = await prompt(`What time? ${SUGGESTED_TIMES.join(SEPARATOR)}`, {
    default: current.hour === null ? SUGGESTED_TIMES[1] : formatTimeOfDay({ hour: current.hour, minute: current.minute }),
    placeholder: SUGGESTED_TIMES[0],
    validate: (value) =>
      TimeOfDay.safeParse(value).success ||
      "use 24-hour HH:MM (03:00) or 12-hour (3am, 3:30pm)",
  });

  return { ...TimeOfDay.parse(answer), days } satisfies Schedule;
}

async function pickDays(prompt: PromptApi, current: number[]) {
  const days = await prompt.multiselect("Which days?", {
    options: ALL_DAYS.map((day) => ({ value: String(day), label: dayName(day) })),
    initialValues: current.map(String),
    min: 1,
  });

  return days.map(Number);
}

/** Asks which repo to sync to, offering to create one. `current` starts selected. */
export async function pickRepo(
  prompt: PromptApi,
  repos: RepoOption[],
  current?: string,
): Promise<RepoChoice> {
  const choice = await prompt.select("Which repo should the skills live in?", {
    options: [
      { value: CREATE, label: "Create a new repository…" },
      ...repos.map((repo) => ({
        value: repo.nameWithOwner,
        label: repo.nameWithOwner,
        hint:
          repo.nameWithOwner === current
            ? `${repo.visibility.toLowerCase()}${SEPARATOR}in use`
            : repo.visibility.toLowerCase(),
      })),
    ],
    default: current,
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
