---
id: APRV-247
title: >-
  examples/telegram-demo.md is stale: run step and refusal forms predate the
  argv+cwd payload hash and the current refusal rendering
status: In Progress
assignee:
  - 'agent:opus-lane-j'
created_date: '2026-09-02 21:42'
updated_date: '2026-09-05 00:05'
labels:
  - docs
dependencies: []
priority: low
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-226 lane on 2026-09-02 while writing the Backlog.md example: examples/telegram-demo.md step 10 shows approval run succeeding with a --payload-hash of an email-shaped payload while the command is echo, but the current run verb recomputes the hash from argv plus physical cwd so that step cannot succeed as written; its refusal examples use the older 'approval: code:' form where the CLI now prints the glyph form (a cross, the code, the message). Outcome: the demo is re-run end to end against the current CLI and every shown command and output is what the CLI prints today; the docs-guard suite pins the refusal form used in examples so the two cannot drift again. Docs only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every command and output block in examples/telegram-demo.md matches a fresh end-to-end run of the current CLI; the run step's payload hash is derived the way approval run derives it
- [x] #2 A docs-guard test asserts examples use the current refusal rendering
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Cut a worktree from fresh origin/main, npm ci, npm run build.
2. Re-run the whole walkthrough end to end with a driver script against a scratch approval home at /tmp/approval-demo and the local mock Bot API from tests/telegram-mock.ts (no real bot, no network), capturing every command's stdout, stderr and exit code plus the message the bot sent.
3. Rewrite examples/telegram-demo.md from that transcript. The structural fix is the payload: approval run's payload is {argv, cwd} (SPEC.md section 6.2, APRV-140), so the demo's email-shaped payload.json becomes the argv it actually spawns, with the reader computing the hash from their own pwd -P the way examples/backlog-md-project/README.md does. No pinned hash value survives.
4. Update every stale output block: the glyph refusal rendering, the three new approval status rows, the tab-separated log tail, the current Telegram message blocks (COMPUTED / PAYLOAD canonical rendering / WHAT THIS DOES) and their order.
5. Add a docs-guard test that scans every markdown file under examples/ for the retired 'approval: <code>:' refusal form over the frozen refusal vocabulary, and asserts the demo prints its refusals in the shape src/cli/style.ts's refusal() produces today.
6. Run the docs-guard and fixtures suites plus lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes (agent:opus-lane-j)

Branch aprv-247-telegram-demo-doc, cut from origin/main at 8f2f2aa. Docs and tests only; no src/ change.

### What was actually stale

Two things, and only the first was structural.

**The payload.** The walkthrough bound the action to an email-shaped object (`{to, subject, body}`) and then passed that hash to `approval run -- echo sent`. Since APRV-140 `run` recomputes the binding from the argv it is about to spawn and the physical cwd (SPEC.md section 6.2), so the document's own final step could not succeed as written: `--payload-hash` named bytes that are not the bytes, and the CLI refuses `payload-mismatch` before spawning anything. There is no way to keep an email payload in a walkthrough that ends at `run`; the scripted twin (tests/e2e-demo.test.ts) had already reached that conclusion and uses `{argv, cwd}`. The document now does too. The `<` and `&` moved into the argv, so step 8's escaping check is still a real check, and the email-shaped payload is pointed at examples/email-demo.md and examples/agentmail-demo.md, where an adapter hashes those bytes itself.

No pinned hash survives: the hash is a function of the reader's own directory, so step 2 has them compute it with `$(pwd -P)` the way examples/backlog-md-project/README.md does, and the shown value is labelled as this transcript's.

**The refusal rendering.** Steps 7 and 11 printed `approval: <code>: <message>`; the CLI has printed the glyph form since APRV-102.

### How the transcript was produced

One driver script ran the whole walkthrough against a scratch approval home at /tmp/approval-demo (physical /private/tmp/approval-demo on macOS) with the built CLI, capturing stdout, stderr and exit code per command. The two Telegram steps were driven against tests/telegram-mock.ts, never the real Bot API, and the document says so where they appear. Nothing touched this repository's APPROVAL.md, .approval/ or log; no gate verb ran against the worktree.

Everything else in the file is that run verbatim, which caught more drift than the task named: `approval status` has grown three rows (harness outcomes, gate window, reconciliation), `approval log tail` is tab-separated, `approval init` prints a scaffold block plus five numbered next steps, and the Telegram message is now four messages whose blocks read COMPUTED, then PAYLOAD (the WYSIWYS canonical rendering, renderer approval.md/wysiwys/2), then WHAT THIS DOES. The old prose described a COMPUTED / CLAIMED / FULL PAYLOAD order that no longer exists, and the order is load-bearing: the claim sits under the bytes.

### The guard

tests/docs-guard.test.ts gained two tests. The sweep walks every markdown file under examples/ and fails on `approval: <code>:` for any code in the frozen refusal vocabulary. The positive half asserts the demo carries what cli/style.ts's `refusal()` produces today, built by calling the renderer with a sentinel message so the two-space separator is pinned rather than assumed.

Scoped to the vocabulary on purpose: `approval wait`'s timeout is not a refusal and cli/execute.ts still prints it as `approval: timeout: …`, which examples/backlog-md-project/README.md shows correctly. A general `approval: \w+:` pattern would fail that file for being right.

The sweep found the same retired line in examples/agentmail-demo.md and examples/email-demo.md, both fixed here. Verified by mutation: reintroducing the old form in the demo fails both new tests (exit 1), and the file was restored.

### One thing the diff does not show

tests/cli-payload.test.ts carried a comment calling its fixture "the payload of examples/telegram-demo.md, and the hash that doc claims". That link is gone. The fixture stays (what that suite tests is `approval payload hash` determinism, which wants a fixed input) and the comment now says what it is and why.

No global invariant in SPEC.md section 11 is touched: nothing here changes an enforcement path, a timestamp source, a schema, or an append.

### Verification

- `node --test dist/tests/docs-guard.test.js` — exit 0, 13 tests, 13 pass
- `node --test dist/tests/backlog-fixtures.test.js` — exit 0, 9 tests, 9 pass
- `node --test dist/tests/cli-payload.test.js` — exit 0, 17 tests, 17 pass
- `node --test dist/tests/classify-tier.test.js` — exit 0, 50 tests, 50 pass
- `node --test dist/tests/e2e-demo.test.js` — exit 0, 9 tests, 9 pass (the scripted twin, unchanged and still green)
- `npm run lint` — exit 0
- `npm run build` — exit 0

AC3 (full `npm test`) is left for the orchestrator: this lane was scoped to the docs-guard and fixtures suites plus lint.
<!-- SECTION:NOTES:END -->
