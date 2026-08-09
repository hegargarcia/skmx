# skill-sync

Keep one GitHub repository of agent skills and global instructions in sync across
Linux and macOS devices.

`skill-sync` keeps a canonical checkout at `~/.skill-sync/repo` and links each
supported agent to it. An edit made through Claude, Codex, or an Agents-compatible
tool therefore changes the same file. A background interval job commits those
changes, integrates remote work with Git's three-way merge, and pushes the result.

## Install and set up

Use it directly:

```bash
npx skill-sync setup
```

Or install the two command aliases globally:

```bash
npm install -g skill-sync
ss setup
```

Setup asks for a GitHub repository and a sync interval. It uses the `git` and `gh`
already installed and authenticated on your machine; skill-sync has no OAuth flow and
never stores a GitHub token. Run `gh auth login` first if needed.

Because interval jobs have no interactive terminal, the Git credential method chosen
by `gh` must also work unattended—for example, an HTTPS credential helper or an SSH
key that does not need a prompt.

For an unattended setup, give every answer as a flag:

```bash
ss setup --repo your-name/agent-library --branch main --interval 15
```

The interval can be a whole number that divides evenly into 60, such as 5, 10, 15,
20, 30, or 60 minutes. This keeps Linux cron and macOS launchd behavior equivalent.
V1 deliberately uses interval sync only—there is no file watcher or long-running
daemon.

## Repository layout

The source repository must contain at least one valid skill:

```text
skills/
  writing/
    SKILL.md
    references/
global/
  AGENTS.md       # optional
  CLAUDE.md       # optional
```

Each skill directory is linked into:

- `~/.claude/skills/<name>`
- `~/.agents/skills/<name>`
- `~/.codex/skills/<name>`

Global files are linked to their matching agent locations. `AGENTS.md` goes to
`~/.agents/AGENTS.md` and `~/.codex/AGENTS.md`; `CLAUDE.md` goes to
`~/.claude/CLAUDE.md`.

Setup inspects every destination before changing any of them. A missing path is safe,
and identical content can be adopted. If any destination contains different content,
setup stops, lists every collision, and leaves the targets untouched. Move or
reconcile those paths yourself, then rerun setup.

## Commands

```bash
ss setup       # connect the repo, create links, and enable interval sync
ss sync        # sync immediately
ss logs        # show configuration and recent structured runs
ss uninstall   # remove the interval job and links owned by skill-sync
```

`uninstall` always preserves `~/.skill-sync/repo`, `~/.skill-sync/runs.jsonl`, and
the rest of the local state. It prints their paths so you can inspect or remove them
deliberately.

## What happens during sync

One lock protects the entire lifecycle:

1. Validate all managed skills and YAML frontmatter.
2. Commit changes under `skills/` and `global/` in the app-owned checkout.
3. Fetch and merge the configured remote branch with normal Git three-way behavior.
4. Validate the merged tree, restore missing owned links, and push.

Non-overlapping changes from multiple devices converge automatically. If the same
lines overlap, the merge is aborted so agents never see conflict markers, nothing is
pushed from that device, and `ss logs` gives the exact recovery command:

```bash
cd ~/.skill-sync/repo
git merge origin/main
# resolve the files, then:
git add -A && git commit
ss sync
```

The previous prototype's union merge rule is removed. skill-sync never guesses how
to combine contradictory prose or duplicate YAML keys.

## Local state and scheduling

Configuration and logs live under `~/.skill-sync/`:

```text
~/.skill-sync/
  config.json
  repo/
  runs.jsonl
  scheduler.log
```

Linux uses the user's crontab. macOS uses
`~/Library/LaunchAgents/com.skill-sync.sync.plist`. Both invoke the same hidden
coordinator used by `ss sync`; scheduled runs do not depend on an interactive shell.

For isolated testing, `SKILL_SYNC_HOME` moves the state directory and
`SKILL_SYNC_AGENT_HOME` moves the projected agent home.

## Development

Node 20.12 or newer is required. Bun is not.

```bash
npm install
npm run check
npm run dev -- --help
npm pack
```

The integration tests use temporary local Git repositories and do not need network
access or GitHub credentials.
