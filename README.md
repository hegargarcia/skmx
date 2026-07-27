# skill-sync

Keeps your agent skills in a git repo and pushes them every night. The repo is cloned
under `~/.config/skill-sync/repos/`, and every agent directory links to that clone —
so Claude, Codex and the rest read the same files, and editing a skill through any of
them edits the repo.

## Setup

```bash
bun install
bun src/index.ts setup
```

`setup` is interactive. It finds every skill with a `SKILL.md` under
`~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills` and asks which to sync,
listing each skill **once** with the agents that hold it:

```
WARN ⚠ personal-code-style is not the same everywhere — you will choose which copy to push

? Which skills should be synced?
> [ ] personal-code-style (claude · agents  ⚠ contents differ)
  [ ] showrunner (claude · agents)
```

Copies are compared by content, not by path, so a skill kept in two places appears
as one choice. When the copies do differ only one can be the source, so `setup` asks
which of them wins.

Prompt rows are drawn as a single line in a single colour, so the `⚠` carries the
warning inside the list; the red belongs to the warning line above it.

It then lists your repos through the `gh` CLI — including an option to create one —
and asks where the skills should live. There is no OAuth flow of its own; `gh` holds
the credentials.

Both answers are written to `~/.config/skill-sync/config.json`, which lives outside
the checkout so the CLI behaves the same wherever you run it from.

The repo holds the skills the way
[HegarGarcia/skills](https://github.com/HegarGarcia/skills) does:

```
skills/
  <skill-name>/
    SKILL.md        # its frontmatter `description` controls when the agent triggers it
    ...             # optional CHANGELOG.md, references/, agents/, etc.
```

A brand-new empty repo works and gets populated on the first sync. Both cloning and
pushing run unattended, so the machine needs credentials that work without a prompt —
an SSH key without a passphrase, or a git credential helper. A public repo is also
worth considering if you want [skills.sh](https://skills.sh) to install these skills
on machines that do not run skill-sync.

## Commands

```bash
bun src/index.ts setup         # onboarding: pick skills and a repo, then schedule
bun src/index.ts start         # resume after a stop
bun src/index.ts stop          # pause, keeping the configuration
bun src/index.ts status        # schedule, last sync, and whether it is healthy
bun src/index.ts sync          # sync now
bun src/index.ts --help        # also --version, and --help on any command
```

`setup` takes `--at` for the time of day and `--repo` to skip the repo picker:

```bash
bun src/index.ts setup --repo git@github.com:you/skills.git --at 3:30am
```

`--at` accepts 24-hour `HH:MM` and 12-hour `3am` / `3:30pm`, and **defaults to
midnight** on a first setup. Leaving it out later keeps the time already scheduled.

**Run `setup` again to change any of it.** It asks the same questions with your
current answers filled in — the skills you sync are ticked, and the repo you are using
is selected and hinted `in use` — so it doubles as the edit screen. Picking skills
needs a terminal, so `setup` refuses to do that non-interactively rather than
guessing; `setup --at 5am` on an already configured machine asks nothing and works
from a script.

`stop` is a pause: it unregisters the job but keeps the time on record, so `start`
puts it back where it was. `start` on an unconfigured machine falls back to
onboarding, and with a repo but no schedule it registers one at midnight.

`status` exits non-zero whenever the sync is not going to run as intended — never
set up, missing from the OS scheduler, a failed or conflicted last run, or no
successful run in the last 26 hours. A deliberate pause exits zero.

To call it as `skill-sync` from anywhere, run `bun link` in this directory.

The commands are defined with [`@bunli/core`](https://bunli.dev) in
`src/commands.ts`, which supplies help, `--version`, and unknown-command errors.
Bunli prints its own help and errors as JSON when stdout is not a TTY; the
commands' own output is plain text either way.

## Development

The `bunli` toolchain is wired to package.json scripts:

```bash
bun run dev      # hot-reload the CLI
bun run test     # run the test suite
bun run build    # bundle the CLI into dist/index.js
bun run release  # version, tag, and publish (not exercised here)
```

`git` work goes through [`simple-git`](https://github.com/steveukx/git-js), and repo
listing and creation through the `gh` CLI. `rsync` is invoked with `Bun.$`, and the
links are made with `node:fs`.

## How a sync works

The repo is cloned to `~/.config/skill-sync/repos/<owner>/<repo>`, and **the clone is
the source of truth**. Each agent directory gets a symlink per synced skill:

```
~/.claude/skills/showrunner  ->  ~/.config/skill-sync/repos/you/skills/skills/showrunner
~/.agents/skills/showrunner  ->  (the same)
~/.codex/skills/showrunner   ->  (the same)
```

So a sync is: commit whatever changed in the clone — which is whatever you edited
through any agent — merge the repo, push, and make sure the links are in place. The
first sync for a skill is the exception: it has nothing to work from, so the folder
you picked is copied in to seed it.

The clone stays parked on the commit of the last successful sync, marked by the
`refs/skill-sync/base` ref. That commit is the common ancestor, so commits made to
the repo from another machine are merged rather than overwritten.

- **A merge conflict stops the sync.** Nothing is pushed and `status` reports the
  conflicting paths. Resolve them in the clone, commit, and sync again.
- **A picked folder that is not a link and still differs from the clone** cannot be
  resolved automatically — either side may hold the edit worth keeping. That is
  reported as `diverged` and nothing is changed. This is what you see when a skill
  already exists in the repo with different contents than your copy.
- **A directory in the way of a link is only replaced when it already holds exactly
  what the clone holds.** Otherwise it has content that was never pushed, so it is
  left alone and named in the summary.
- **Skills the repo has that you did not select are left alone**, and never linked.

State lives under `${XDG_STATE_HOME:-~/.local/state}/skill-sync`: `state.json`
holds the last sync record, `schedule.json` the time `start` registered, and
`cron.log` a line per scheduled run.

## Scheduling

`setup` and `start` register the job with the OS scheduler through `Bun.cron`, so it
survives reboots and works on Linux (crontab), macOS (launchd), and Windows (Task
Scheduler). The job itself is `src/scheduled.ts`.

Because there is no API to list registered jobs, the time is recorded in
`schedule.json`, along with whether it is paused, for `status` to report. On Linux
`status` also confirms the crontab entry is still there and says so when it has gone
missing while not paused.

## Configuration

Settings come from `~/.config/skill-sync/config.json` — written by `setup`, or by hand —
and each one can be overridden by an environment variable, which is useful for
trying the tool against a throwaway repo. Unknown keys in the file are rejected so
typos do not pass silently.

| Key | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `repo` | `SKILL_SYNC_REPO` | — | git remote URL of the skills repo (required) |
| `skills` | — | `[]` | the skills to sync, as `{ "name", "path" }` entries |
| `branch` | `SKILL_SYNC_BRANCH` | `main` | branch to sync |

`setup` writes `skills` for you, but it is plain JSON and `path` accepts a leading
`~`, so a skill kept outside the standard agent directories can be added by hand:

```json
{
  "repo": "git@github.com:you/skills.git",
  "skills": [{ "name": "showrunner", "path": "~/.claude/skills/showrunner" }]
}
```

`SKILL_SYNC_HOME` moves the config directory itself, which also moves the clones;
it defaults to `${XDG_CONFIG_HOME:-~/.config}/skill-sync`. `XDG_STATE_HOME` moves the
state directory. `status` prints the config, clone and state paths.

## Tests

```bash
bun test
```

The sync tests run against a throwaway bare repo in a temp directory, so they
need no network access or configuration.
