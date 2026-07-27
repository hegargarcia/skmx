# skill-sync

Pushes your agent skills to a git repo every night, then lets
[skills.sh](https://skills.sh) install them back across your agents.

## Setup

```bash
bun install
bun src/index.ts setup
```

`setup` is interactive. It finds every skill with a `SKILL.md` under
`~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills` and asks which to sync,
listing each skill **once** with the agents that hold it:

```
◻ personal-code-style   claude, agents — contents differ
◻ showrunner            claude, agents
```

Copies are compared by content, not by path, so a skill kept in two places appears
as one choice. When the copies do differ only one can be the source, so `setup` asks
which of them to push.

It then lists your repos through the `gh` CLI — including an option to create one —
and asks where the skills should live. There is no OAuth flow of its own; `gh` holds
the credentials.

Both answers are written to `~/.skill-sync/config.json`, which lives outside the
checkout so the CLI behaves the same wherever you run it from.

The repo holds the skills the way
[HegarGarcia/skills](https://github.com/HegarGarcia/skills) does:

```
skills/
  <skill-name>/
    SKILL.md        # its frontmatter `description` controls when the agent triggers it
    ...             # optional CHANGELOG.md, references/, agents/, etc.
```

A brand-new empty repo works and gets populated on the first sync. Pushing runs
unattended, so the machine needs credentials that work without a prompt — an SSH key
without a passphrase, or a git credential helper. Prefer a public repo: skills.sh
installs from one without credentials.

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
midnight**. Picking skills always needs a terminal, so `setup` refuses to run
non-interactively rather than guessing.

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

`git` work goes through [`simple-git`](https://github.com/steveukx/git-js), repo
listing and creation through the `gh` CLI, and installation through the `skills`
CLI. `rsync` is invoked with `Bun.$`.

## How a sync works

skill-sync only pushes; **installing is skills.sh's job**. Each selected skill's
folder is copied into `skills/<name>/` in the repo, committed, and pushed. Then
`skills update --global --yes` runs for those skills, which is what puts the new
version into every agent directory they are installed to.

A clone of the repo lives in `~/.local/state/skill-sync/repo` and stays parked on
the commit of the last successful sync, marked by the `refs/skill-sync/base` ref.
That commit is the common ancestor, so commits made to the repo from another
machine are merged rather than overwritten.

- **A merge conflict stops the sync.** Local skills are left untouched and `status`
  reports the conflicting paths. Resolve them in the clone, commit, and sync again.
- **The first sync has no common ancestor**, so anything the push would overwrite or
  delete cannot be resolved without losing content. That is reported as `diverged`
  and nothing is changed — reconcile those files once, then sync again. Files this
  machine simply adds are not a conflict.
- **Skills the repo has that you did not select are left alone.** Only the folders
  of selected skills are touched, and only within them does a local deletion
  propagate.
- **Skills that skills.sh has never installed** cannot be refreshed by `update`,
  which exits zero regardless. The sync names them and tells you to run
  `bunx skills add <owner/repo>` once to enroll them.

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

Settings come from `~/.skill-sync/config.json` — written by `setup`, or by hand —
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

`SKILL_SYNC_HOME` moves the config directory itself (default `~/.skill-sync`), and
`XDG_STATE_HOME` moves the state directory. `status` prints both paths.

## Tests

```bash
bun test
```

The sync tests run against a throwaway bare repo in a temp directory, so they
need no network access or configuration.
