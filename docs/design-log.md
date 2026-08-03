# Design log

A record of how skill-sync got built, why it works the way it does, and what testing
revealed along the way. Written at the end of the first build session, covering
`9fa8b60..f6b2197` (26 commits, 2026-07-27 to 2026-07-31).

This is a distilled record rather than a transcript. It is kept because most of what
is below was learned by trying things rather than by reading documentation, and
several of the decisions look arbitrary until you know what was ruled out.

## What the tool does

The skills repo is checked out once. Every agent directory holds a symlink per synced
skill pointing into that checkout, so Claude, Codex and the rest read the same files
and editing a skill through any of them edits the repo. A sync then commits whatever
changed in the checkout, merges the remote, pushes, and makes sure the links exist.

```
~/.claude/skills/showrunner  ─┐
~/.agents/skills/showrunner  ─┼─→  <checkout>/skills/showrunner  ──→  git remote
~/.codex/skills/showrunner   ─┘
```

Scheduling is an OS-level cron entry written by `Bun.cron`, defaulting to hourly.

## Decisions, and what they replaced

### The checkout is the source of truth, not the agent directories

Skills were first mirrored *from* an agent directory *into* a clone with rsync on every
run. That silently reverted work: an edit made through a different agent's link landed
in the clone, then the next sync copied the configured directory over it and reported
`already in sync`. Now a skill is only copied in to seed it; after that the checkout is
authoritative and edits land there directly.

### Installation is symlinks, not skills.sh

An earlier version pushed to the repo and then called `npx skills update` to install.
Dropped because `skills update` **exits 0 for skills it has never installed**, so the
trigger reported success while agents got nothing, and `skills add -a '*'` created
directories for **50+ agents** under a sandboxed HOME. Symlinks make installation ours,
instantaneous, and inspectable.

### `checkout` config option

A machine that already has the repo checked out and works in it does not want a second
clone; both would be linked from agent directories and edits would land in whichever
one an agent happened to read. `checkout` points at the existing one. A checkout named
in the config is treated as the user's: never created, never cleaned, remote verified.

### Hourly by default, with a per-machine minute

Conflicts need two machines to change the same lines *between* syncs, so the gap
between syncs is what decides how often they happen. Hourly shrinks the window; the
minute is derived from the hostname so machines do not all arrive at once. A refused
push fetches, merges and pushes again rather than waiting an hour.

### Markdown merges by union

Skills are lists of rules that grow at the end, so two machines each appending one both
change the last line — the same region, which git stops on. The repo carries
`skills/**/*.md merge=union`, added on the first sync, so git keeps both sides' lines.
Markdown only: keeping both halves of a JSON file is never right.

The trade is that union never asks. Two machines rewording one rule keep both wordings,
and **frontmatter edited on both sides produces a broken skill** — verified: a duplicated
`description:` key and a stray `---` mid-body, with git reporting success. The guard for
that (parse frontmatter after merge, treat a broken one as a conflict) is **not built**.

### Conflicts abort rather than sit in the working tree

Agents read the checkout through links, so a conflicted tree would feed them files
containing `<<<<<<<` markers. The merge is aborted, which leaves a clean tree — and
therefore nothing to "resolve in the clone", which the error message used to claim.
Following that advice and committing the file leaves the sync conflicted forever. The
message now gives the recipe that works:

```bash
cd <checkout> && git merge origin/main   # markers appear here
# fix the marked files
git add -A && git commit
```

### Never overwrite or delete without reconciliation

A first sync refuses (`diverged`) when pushing would overwrite a file that differs on
both sides, or delete one the repo has and this machine does not. Files this machine
merely adds are not a conflict and are copied over.

## Bugs found by testing, and what each teaches

| Bug | Lesson |
| --- | --- |
| Edits through one agent's link were reverted by the next sync, reported as `already in sync` | Two writable copies of one file is the bug; pick one source |
| `--delete` on the bootstrap copy would have deleted a remote-only file | Mirroring is only safe the first time a skill arrives |
| `readdir` + `dirent.isDirectory()` returned `false` for symlinked skills, so discovery found none | A symlink is not a directory to `readdir`; test for the `SKILL.md` instead |
| rsync's default size-and-mtime check called two same-sized edits in the same second identical | Use `--checksum` when correctness matters more than speed |
| rsync itemize `.f..t...` (attribute-only) was read as a content change | Only `>f`, `c`, `*deleting` mean the tree changed |
| `refExists` returned `true` for missing refs: `rev-parse --verify --quiet` resolves to `""` under simple-git instead of rejecting | Check the value, not just the absence of a throw |
| `.default("00:00")` on a zod pipe skipped the transform, handing the handler a raw string | `.prefault()` applies a default as *input* |
| First-run gating keyed on the clone's existence, so a second sync skipped the divergence guard and would have clobbered the remote | Gate on an explicit marker (`refs/skill-sync/base`), not a side effect |
| `reset --hard` + `clean -fd` on a user-named checkout destroyed uncommitted work | Never clean a directory the user owns |
| The repo's `.gitignore` silently dropped skill files (`node_modules/`, `*.log`) | Staging skips ignored files without a word; name them |
| Extra local files were never copied when the repo already held the skill | "Nothing to overwrite" is not the same as "nothing to do" |
| Union merge corrupted YAML frontmatter, exit 0 | A merge strategy that never asks needs a validity check |

## Verified facts about the ecosystem

Tested on **Claude Code 2.1.220** and **Codex 0.145.0** with probe skills placed in the
real agent directories and removed afterwards.

| Shape | Claude Code | Codex |
| --- | --- | --- |
| Plain directory | works | works |
| Skill directory is a symlink | works | works |
| `SKILL.md` itself is a symlink | works | untested |
| Whole `skills/` directory is a symlink | works (project scope) | untested |

A symlinked skill is not merely listed: invoking it through the Skill tool resolved and
returned its body. A running session also picked up new probes live.

**Caveat that remains open:** [claude-code#14836](https://github.com/anthropics/claude-code/issues/14836)
reports that the `/skills` command shows nothing for symlinked skills even though the
model loads and uses them — discovery/validation does not resolve symlinks, execution
does. Not reproducible headlessly, so assume symlinked skills may be missing from
`/skills` while working fine. Related and closed as duplicates:
[#38051](https://github.com/anthropics/claude-code/issues/38051) (regression from the
symlink security fixes in ~v2.1.69), [#25367](https://github.com/anthropics/claude-code/issues/25367),
[#37590](https://github.com/anthropics/claude-code/issues/37590).

Untested: Cursor and Gemini CLI, neither installed. Both implement the same
[Agent Skills](https://www.skills.sh) standard, so adding `.cursor/skills` to the link
targets is likely a one-line change — but verify before believing it.

## Library and platform notes

**Bun 1.3.14**
- `Bun.cron(path, expression, title)` registers with the OS: crontab on Linux (marked
  `# bun-cron: <title>`), launchd on macOS, Task Scheduler on Windows. `Bun.cron.remove(title)`
  is idempotent. There is **no list API**, so the schedule is recorded in `schedule.json`.
- `Bun.cron.parse` resolves expressions **in UTC** while the OS scheduler fires in local
  time, so it is not used for "next run" — in UTC+9 it would call a 03:00 job 12:00.
- `fs.watch` recursive works, including through symlinks and for directories created
  after the watch begins. Event paths are unreliable: an atomic save reports the *temp*
  file, a new nested file reports only the top directory. Treat events as "something
  changed, ask git".

**bunli 0.9.1 / @bunli/core**
- Option schemas are standard-schema, so zod works. There are **no positional argument
  schemas**, despite the docs example — positionals arrive as `positional: string[]`.
- The help renderer wraps and aligns *option* descriptions under the flag column, but
  prints the *command* description unwrapped. Keep command descriptions short.
- Prompt rows are one `<text>` element with a single `fg` colour, so ANSI inside an
  option's `hint` renders as literal escape codes. Glyphs carry warnings inside lists;
  colour comes from `prompt.log.warn` or from plain stdout.
- `prompt.filter` only returns values from its own options, so it cannot take free text.
- Its own help and errors print as JSON when stdout is not a TTY (agent mode).
- `bunli test` passes the configured pattern to `bun test` as a *filter*, matching on
  path rather than glob. `bunli doctor` needs a subcommand. `bunli generate` finds no
  commands unless they are laid out its way, and `bunli build` runs it anyway.

**Environment quirks on this machine**
- `~/.bun/bin` is **not on PATH** in a login shell, so `bun` and any linked `skill-sync`
  binary must be called by absolute path. Cron entries embed one, so they are unaffected.
- `~/.ssh/github` has no passphrase, which is why unattended pushes work.
- No `expect`, so real TUI keystrokes cannot be driven here — prompt logic is tested
  through an injected fake `PromptApi` instead.
- `notify-send` and `osascript` are absent, and cron has no session bus, which is why
  notifications were designed as hook output rather than desktop toasts.

## Deferred deliberately

- **File watchers (V2).** Would shrink the sync gap from an hour to seconds and largely
  dissolve conflicts. The cost is a supervised daemon per platform, plus a feedback-loop
  guard (the sync writes to the directory it watches) and a lock against concurrent git.
  The hourly cron is the simple 90%.
- **`resolve` command** for conflicts, and the **frontmatter validation** that would make
  union merging safe. Not built; conflicts are resolved with the git recipe above.
- **Per-machine conflict branch** (`skill-sync/<machine>`) for visibility and recovery.
- **SessionStart hook** that syncs before an agent reads skills — freshness plus conflict
  avoidance plus a place to report conflicts, in one mechanism.

## State at the end of the session

- 143 tests, `tsc --noEmit` clean.
- Configured against `hegargarcia/skills` using the existing checkout at `~/dev/skills`;
  `personal-preferences` and `showrunner` linked into `.claude`, `.agents` and `.codex`.
- `gh-stack` exists locally but is not in the repo, so it is not synced.

Known gaps: nothing is **scheduled** yet (installing a cron entry was left to a
deliberate command); `skill-sync` is not on PATH though error messages suggest it;
staleness is judged at 26 hours regardless of cadence, so a dead hourly sync looks
healthy for a day; there is no CI running the tests; and a second machine has only ever
been simulated with two fake home directories.
