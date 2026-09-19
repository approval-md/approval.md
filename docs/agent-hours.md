# Agent hours: `scripts/agent-hours.mjs` (APRV-373)

The badges at the top of the README count how much agent labour went into this
repository, per model: fable, opus, astra, sol, cursor, and the total. They read
`metrics/agent-hours.json` on `main` through shields.io, and that file is
produced by `scripts/agent-hours.mjs` from the session transcripts the harnesses
leave on the maintainer's machine.

The point is auditability. "Agents wrote this" is a claim; a number with a
stated method, a stated cap, and a stated floor is something a reader can argue
with.

## The method

The script never asks a harness how long it worked. It reads the transcripts
each one writes as it runs, which are a byproduct of the work rather than a
record kept by the party being measured.

**Active time.** A session open from 09:00 to 17:00 did not run for eight hours.
So the measure walks one session's events in timestamp order and, for each
consecutive pair, adds the gap between them capped at 300 seconds. A pause
longer than the cap contributes the cap and nothing more, which is what makes an
overnight gap cost five minutes instead of nine hours.

**The cap.** 300 seconds is the default and the only tuning knob. Raising it
raises every figure, so the value is written into the JSON next to the numbers
it produced (`method.gap_seconds`), and the script never reads that value back.

**Attribution.** Each capped gap is charged to the model of the most recent
event that named one, so a session that switches models mid-way splits between
them. A session in which no event named a model is skipped rather than charged
to a guess. Model ids map to stable family keys (`claude-fable`, `codex-astra`),
because the raw ids carry dated suffixes and a badge pointed at one would drop
to zero the day the vendor ships a point release.

**Tokens.** Claude reports usage per turn, and input counts cache creation and
cache reads along with fresh input. Codex reports a cumulative session total, so
the last figure in the rollout is the session's, charged to that session's
dominant model. Cursor reports no tokens at all.

## What is counted, per source

| source | where | model | timestamps |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<repo-slug>*/**/*.jsonl`, primary checkout and every worktree, each subagent transcript its own session | per turn | per event |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions`, kept when the session's own `cwd` is the repository or anything under it | per turn, from `turn_context` | per event |
| Cursor | `~/.cursor/projects/<repo-slug>/agent-transcripts` | unknown | user turns only |

Three caveats travel with every figure, and they are in the JSON as well as
here.

1. **Every number is a floor.** Only sessions run on the maintainer's machine
   leave a transcript here. Cloud sessions, sessions on another machine, and
   anything from before the harness kept transcripts are invisible to this
   script and are simply not counted. Read the figures as "at least this much".
2. **Cursor is approximate.** Its transcripts carry no per-turn model and no
   machine timestamps; the only clock is the one each user turn printed into its
   prompt, so assistant turns inherit the timestamp of the user turn they follow
   and the file's mtime closes the session. Cursor hours are bounded by the
   cadence of the human's own turns, which reads low, and the agent key is
   flagged `approx` in the JSON.
3. **`codex-review` is a reviewer, not an author.** It is the `codex-auto-review`
   guardian model reading other agents' work. It consumed real time so it is
   counted, and it authored nothing so it stays off the badges.

## Regenerating the file

```
npm run agent-hours                                  # print the table
npm run agent-hours -- --json metrics/agent-hours.json   # rewrite the metrics file
```

Other flags: `--gap <seconds>` changes the idle cap, `--since <YYYY-MM-DD>` and
`--until <YYYY-MM-DD>` bound the window, `--repo <path>` measures a different
checkout, and `--home <path>` points the readers at a different home directory
(the tests use it). Run from a worktree, the script measures the primary
checkout anyway, since that is where all of the transcripts hang.

## The weekly refresh

`scripts/agent-hours-weekly.sh` regenerates the file and opens a pull request
that merges itself, the same shape as the records-log PR: start from
`origin/main`, run the script, and exit without a PR when nothing beyond the
timestamp changed.

It never checks anything out in the primary checkout. The primary's working
tree is where the daemon writes the live log, so all git work happens in a
throwaway `git worktree` under a temp directory, detached at `origin/main` and
removed on exit. The primary is only read, and `--repo` is passed explicitly so
the transcripts are still selected by the primary's path.

```
zsh scripts/agent-hours-weekly.sh --dry-run
```

prints every git and `gh` command it would run, and still runs `git fetch` and
the script itself so the diff summary is real. It refuses to run from a
worktree of its own.

Install the launchd job to run it on Mondays at 03:30:

```
cp scripts/launchd/com.carter.agent-hours.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.carter.agent-hours.plist
```

To run it once by hand, without waiting for Monday:

```
launchctl start com.carter.agent-hours
```

Output lands in `~/.claude/logs/agent-hours-launchd.log`.
