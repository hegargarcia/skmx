# skill-sync

Keeps a Claude skills directory (`~/.claude/skills` by default) in sync with a git
repo, on a nightly cron schedule.

## Setup

```bash
bun install
mkdir -p ~/.skill-sync
cat > ~/.skill-sync/config.json <<'JSON'
{
  "repo": "git@github.com:you/skills.git"
}
JSON
```

Config lives outside the checkout so the CLI behaves the same wherever you run it
from. `skillsDir` and `branch` can go in the same file; see
[Configuration](#configuration).

The repo it names holds the skills under a top-level `skills/` directory,
mirroring the layout of your local skills directory; a brand-new empty repo works
and gets populated on the first sync. Pushing runs unattended, so the machine
needs credentials that work without a prompt — an SSH key without a passphrase,
or a git credential helper.

## Commands

```bash
bun src/index.ts start 03:00   # schedule the nightly sync (also accepts 3am, 3:30pm)
bun src/index.ts status        # schedule, last sync, and whether it is healthy
bun src/index.ts stop          # remove the schedule
bun src/index.ts sync          # sync now
bun src/index.ts --help        # also --version, and --help on any command
```

`status` exits non-zero when the sync is scheduled but unhealthy — a failed or
conflicted last run, or no successful run in the last 26 hours.

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

`git` work goes through [`simple-git`](https://github.com/steveukx/git-js);
`rsync` and `tar` are still invoked with `Bun.$`.

## How a sync works

A clone of the repo lives in `~/.local/state/skill-sync/repo` and stays parked on
the commit of the last successful sync, marked by the `refs/skill-sync/base` ref.
That commit is the common ancestor that makes a real two-way merge possible: local
edits are committed on top of it, then `origin` is merged into them, pushed, and
the merged result is mirrored back to the skills directory.

- **A merge conflict stops the sync.** The local skills directory is left
  untouched and `status` reports the conflicting paths. Resolve them in the clone,
  commit, and sync again.
- **The first sync has no common ancestor**, so a skill that exists on both sides
  with different contents cannot be merged without losing an edit. That is
  reported as `diverged` and nothing is changed; reconcile those files once, then
  sync again. Skills that exist on only one side are adopted by the other.
- **Local skills are archived before being overwritten**, to
  `~/.local/state/skill-sync/backups` (the last 10 runs are kept).

State lives under `${XDG_STATE_HOME:-~/.local/state}/skill-sync`: `state.json`
holds the last sync record, `schedule.json` the time `start` registered, and
`cron.log` a line per scheduled run.

## Scheduling

`start` registers the job with the OS scheduler through `Bun.cron`, so it survives
reboots and works on Linux (crontab), macOS (launchd), and Windows (Task
Scheduler). `stop` unregisters it. The job itself is `src/scheduled.ts`.

Because there is no API to list registered jobs, `start` records the time in
`schedule.json` for `status` to report. On Linux `status` also confirms the crontab
entry is still there and says so when it has gone missing.

## Configuration

Settings come from `~/.skill-sync/config.json`, and each one can be overridden by
an environment variable — useful for trying the tool against a throwaway repo.
Unknown keys in the file are rejected so typos do not pass silently.

| Key | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `repo` | `SKILL_SYNC_REPO` | — | git remote URL of the skills repo (required) |
| `skillsDir` | `SKILL_SYNC_SKILLS_DIR` | `~/.claude/skills` | skills directory to sync |
| `branch` | `SKILL_SYNC_BRANCH` | `main` | branch to sync |

`SKILL_SYNC_HOME` moves the config directory itself (default `~/.skill-sync`), and
`XDG_STATE_HOME` moves the state directory. `status` prints both paths.

## Tests

```bash
bun test
```

The sync tests run against a throwaway bare repo in a temp directory, so they
need no network access or configuration.
