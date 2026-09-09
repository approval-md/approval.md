---
id: APRV-176
title: >-
  Crowd demo wiring: guest policy limits, MCP tunnel runbook, rsi connect
  section
status: In Progress
assignee:
  - '@opus-176'
created_date: '2026-08-31 01:19'
updated_date: '2026-09-06 08:09'
labels:
  - demo
dependencies:
  - APRV-173
  - APRV-174
  - APRV-175
ordinal: 155000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final assembly of the crowd-MCP track. Demo policy declares the now-enforced intake limits: requests_per_hour: 3 on the guest-reachable classes and budgets.global.max_pending: 10 (the tripwire firing on stage is the pitch: these limits protect the human's attention, and the audience watches them refuse). Runbook gains the guest section: second quick tunnel for the MCP port, URL published only when the demo starts and rotated after, session/lifetime caps stated, flood management (digest coalescing; a flood-clear of rejections is not a considered denial). HARD REQUIREMENT stated as a MUST: the guest instance runs in a throwaway directory with an EMPTY vault and no email adapter configured, so even a verb-filter bug has nothing to spend. rsi/index.html's connect-your-agent section activates: paste box for the MCP URL plus the claude mcp add one-liner for attendees. Defaults settled by Carter: wait clamp 5s, 20 sessions, guests can see the shared queue (mild info leak accepted as demo theater).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Demo policy with the declared limits passes policy check and the limits are observed refusing in a rehearsal (queue-full or rate-limited fires at least once)
- [x] #2 Runbook guest section covers tunnel, URL rotation, caps, flood management, and the empty-vault MUST
- [ ] #3 One full rehearsal: a real external MCP client (another machine) connects, files a request, the phone decides, the rsi page shows it live
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Demo policy (examples/web-agent-demo/provisioning.md §2, the heredoc every instance is written from): add requests_per_hour: 3 to the three MANUAL classes a guest can reach (exec.local, communicate.email.external, policy.edit) and budgets.global.max_pending: 10 beside daily_actions: 25. read.* is deliberately left alone: an autonomous class returns before request() reaches intake, so a ceiling there would be a number nothing enforces. Retire the stale sentence that calls limits.max_pending unenforced vocabulary (APRV-173 enforces it) and add the two policy check invocations that prove the file still parses.
2. tests/demo-guest-limits.test.ts, a TEST rather than a stage rehearsal: EXTRACT the yaml approval-policy block from provisioning.md itself (so doc and enforcement cannot drift), assert the declared limits, write it into a scratch instance, attest, and run the real CLI policy check. Then stand up serveApprovalMcpHttp({guest:true}) on an ephemeral loopback port and drive the guest surface with real MCP clients: (a) one guest session registers and requests four exec.local envelopes, the fourth refused rate-limited; (b) four guest sessions fill the shared queue to budgets.global.max_pending, the eleventh refused queue-full. Nothing hand-written into the log; every record arrives through a guest tool call.
3. examples/web-agent-demo/runbook.md: new guest section covering the second quick tunnel for 4681 (gated exactly like the 4700 beat), URL published at demo start and rotated after, the caps in one table (20 concurrent / 200 lifetime sessions, 5s wait clamp, requests_per_hour 3, global max_pending 10), flood management (digest coalescing; a flood-clear of rejections is not a considered denial), Carter's settled defaults incl. guests seeing the shared queue, and the HARD REQUIREMENT as a MUST: the guest instance is a throwaway directory with an EMPTY vault and no email adapter. Warnings box gains the guest lines.
4. rsi connect section: blocked upstream. rsi/index.html is NOT on main (it exists only on the unmerged rsi-page / claude/rsi-demo-restyle-combined branch, e359031), so the section has nowhere to land in this commit; carry the exact markup in the notes and report the blocker rather than re-landing another task's 400-line file inside APRV-176.
5. npm run build; mcp-guest / mcp-http / policy / docs-guard / the new suite; npm run lint; npm run typecheck. Finalize with evidence, leave In Progress.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What shipped

Two of the three acceptance criteria. AC 3 is Carter's and is specified at the bottom.

### 1. The demo policy declares the crowd-demo ceilings (AC 1)

`examples/web-agent-demo/provisioning.md` §2 carries the demo gate's policy as the heredoc an operator copies verbatim, so the ceilings go there rather than into a second file nobody would read:

- `requests_per_hour: 3` on all three MANUAL classes (`exec.local`, `communicate.email.external`, `policy.edit`), which is what "guest-reachable" means here: those are the classes a guest can put in front of a human. Counted per origin, and at v0.1 origin is the requesting actor, so under `--http --guest` the ceiling is three per class per connected stranger per hour, and nothing a caller sends can move a request onto somebody else's count.
- `budgets.global.max_pending: 10` beside the existing `daily_actions: 25`.
- `communicate.email.external.limits.max_pending: 3` kept, now enforced rather than decorative.
- `read.*` deliberately gets NOTHING. An autonomous class returns proceed before `request()` reaches the intake limits, so a ceiling there would be a number in an attested file that nothing enforces. Stated in the doc so the omission reads as a decision.

The stale paragraph calling `limits.max_pending` unenforced v0.1 vocabulary is retired (APRV-173 enforces both names) and replaced with prose that says what the two limits protect: budgets meter money, these meter the queue, and the queue is one person's attention.

### 2. A TEST, not a rehearsal, drives the guest surface through them (AC 1)

New `tests/demo-guest-limits.test.ts`, 4 cases, all passing:

1. The `yaml approval-policy` block is EXTRACTED from provisioning.md itself and loaded through `core/policy-load.ts` (so it is schema-validated on the way in), then asserted class by class. The doc and the assertions cannot drift: an edit to the documented numbers fails here. This deliberately breaks the pattern of `tests/e2e-web-agent-demo.test.ts`, which keeps a trimmed twin because it needs one.
2. `approval policy check` is run for real, in a scratch instance written from that block, on the discriminating class the doc names (`read.files --reversible true`; an unparseable policy fails closed to manual everywhere, so only a permissive answer proves the file loaded) plus the email class and `exec.local`. Exit 0 on all three.
3. `rate-limited` fires: one guest session over a real `serveApprovalMcpHttp({guest:true})` listener on an ephemeral loopback port registers and requests four seeded `exec.local` envelopes; the fourth comes back isError with `error.code: rate-limited` and one failing verdict `[requests_per_hour, rolling-1h, 3]`. The log holds exactly three `approval.requested`, all under one `agent:guest-*` actor.
4. `queue-full` fires: four guest sessions (three asks each, which is what the per-origin ceiling forces) fill the shared queue to ten, then a fresh fifth session whose own hour is untouched is refused `queue-full` with the failing verdict `[global.max_pending, global, 10]`. The log still holds exactly ten requests, so the refusal appended nothing.

Every record under test arrives through a guest MCP tool call over a socket. Nothing is hand-written into a log.

### 3. The runbook's guest section (AC 2)

New `examples/web-agent-demo/runbook.md` §4, "The crowd track: attendees connect their own agents" (sections 4-7 renumbered to 5-8; no cross-reference pointed at those numbers). It covers, in this order:

- **The empty-vault MUST, first, as a block quote.** The guest instance is `~/demo-guest`, provisioned through provisioning.md steps 1-3 and STOPPING before step 4's `setup vault` and `setup adapter email`; `vault.enc` must not exist and doctor's `vault` row must read as not-applicable. The reasoning is stated as belt and braces: guest mode withholds `run`, `token` and every adapter, and the empty vault is what makes a bug in that filter cost nothing. The consequence is spelled out: the crowd track can never point at `~/demo-gate`, which holds the finale's SMTP password.
- **Seeded envelopes.** A guest can register only what is already on disk, and a manual action without a `payload_hash` is refused `payload-hash-required`, so a seeded envelope missing one is unusable. Found by the test, not by reading.
- **The second tunnel**, gated exactly like the 4700 beat with 4681 substituted, including the honest line about the header field an MCP client asks for (this server reads no header).
- **URL rotation**: published only when the track starts, killed when it ends, re-gated on every relaunch (`payload-mismatch` refuses the old grant's token), rotated before leaving the venue.
- **Connecting**: the /rsi paste box and the `claude mcp add --transport http` one-liner, with an explicit instruction to verify the flag spelling per client on the day rather than trusting a runbook to have guessed it.
- **The caps in one table** with the constant and file behind each: 20 concurrent / 200 lifetime sessions, the 5s `wait` clamp, 3 per hour, 10 pending, 3 pending email, 9 tools. Below it the observed `rate-limited` refusal line and the "Request-volume ceilings" table `.approval/QUEUE.md` now renders (both captured from a seeded instance on 2026-09-06, transcribed rather than paraphrased).
- **Guests can see the shared queue**, named as an accepted information leak with the reason it is safe (everything in that queue is already on a projector in the same room), per Carter's settled default.
- **Flood management**: digest coalescing, an "all" tap is N separate decisions, a flood-clear of rejections is not a considered denial (it clears the queue and decides nothing), and the better answer, which is to let the ten-pending ceiling and the 10m TTL drain it. `withdraw` is off the guest allowlist, so nothing an attendee does can churn the log.

Also: the instance table at the top gains `~/demo-guest`; the failure playbook gains four guest failure modes (`mcp-guest-restricted`, the two 503 caps, the clamped `wait`, and envelopes missing a hash); the hard-warnings box gains three lines (4681 is the second and last exposable port, the guest instance MUST hold no credential, never publish the URL early); §6 says the guest instance is retired whole rather than reset; §8 gains three TBDs.

## Decisions

- **The limits live in the ONE demo policy, not a separate guest policy.** provisioning.md §2 is the file every instance is written from, `~/demo-guest` included, and a second policy would be a second thing to keep in step. The guest instance differs from the demo gate in what it HOLDS (no vault, no adapter, throwaway directory) rather than in what it declares.
- **`requests_per_hour` on three classes, not one.** The task says "the guest-reachable classes". A guest reaches whatever the operator seeded, and the operator may seed any manual class, so all three carry it. The consequence is worth knowing: class limits are scoped by the winning rule's pattern, so one guest may file 3/hour in EACH class, nine in total across the three. The global `max_pending: 10` is what bounds the aggregate.
- **`read.*` carries no limit**, stated above and in the doc. It is the one place where adding the number would have been strictly worse than leaving it out.
- **The test extracts the policy from the documentation.** The alternative (a twin, like the existing e2e demo tests keep) would have passed AC 1 while leaving the documented numbers free to drift from the tested ones, which is the exact defect this task is about.
- **`schema/policy.schema.json` was NOT touched**, though its `budgets.max_pending` description still says "Policy vocabulary in v0.1: enforcement lands with M4/M5", which APRV-173 made false. Schema changes are their own tasks (CLAUDE.md) and conformance versions ride on that file. Flagged for a follow-up, not fixed here.

## Invariants touched

None weakened. The work is a policy declaration, documentation and a test; no enforcement path changed. Three §11.1 invariants are LEANED ON and are worth naming because the runbook now makes public claims about them: invariant 4 (self-reported fields never reduce scrutiny) is why a per-session `agent:guest-<hex>` is minted before the transport exists and why the rate limit cannot be moved onto another origin; invariant 6 (refusals machine-readable and distinct) is why the test asserts `error.code` and the verdict array rather than prose; invariant 9 (human-only classes inert to agents) is why the guest allowlist can be published at all.

## Blocked, and it is not a small thing: the rsi connect section

**`rsi/index.html` is not on main.** It exists only on the unmerged branches `rsi-page` and `claude/rsi-demo-restyle-combined` (single commit e359031), whose base is around PR #166 while main is at PR #306. APRV-170 and APRV-172 are both marked Done and neither one's code has ever landed: main has no `rsi/` directory, and `examples/web-agent-demo/server.mjs` on main carries no `Access-Control-Allow-Origin` header. So https://approval.md/rsi is dark today, and the live-connect the crowd track's connect box sits beside cannot work cross-origin until APRV-172 lands with it.

Activating the section therefore has nowhere to land in this commit. Carrying e359031's 403-line page into an APRV-176 commit would re-land another task's deliverable inside this one, forking a file two branches already own and inviting an add/add conflict, which is the unreviewable bundle CLAUDE.md's one-task-one-unit rule exists to prevent. The section belongs in the branch that owns the page, in that branch's own PR.

The markup, matching the page's existing idioms (`.connect`, `.prompt`, `.ps1`, `.go`, `.origin`), replacing the `div class="soon"` block under the "Connect your agent" heading:

    <h2>Connect your agent</h2>
    <p>Point your own agent's MCP client at the gate and let it request whatever it likes. A human still decides, and nothing a guest agent is granted executes anywhere: there is no run verb on this surface and no adapter behind it.</p>

    <div class="connect">
      <div class="prompt">
        <span class="ps1" aria-hidden="true">$ claude mcp add --transport http approval-demo</span>
        <input id="mcp" type="url" inputmode="url" spellcheck="false" autocomplete="off"
               placeholder="https://xxxx.trycloudflare.com/mcp" aria-label="Guest MCP URL">
      </div>
      <button class="go" id="mcp-copy">Copy</button>
    </div>
    <p class="origin">Paste the MCP URL announced on stage. Nine tools: instructions, register, request, wait, status, queue, log_verify, policy_check, policy_test. Three requests an hour per guest, ten pending in the whole queue, and wait comes back in five seconds.</p>

Copy handler: navigator.clipboard.writeText(prefix + input.value) inside try/catch, falling back to selecting the input, in the same defensive style the page's localStorage access already uses. The paste box needs no persistence: the URL is per-session and rotates the moment the track ends.

## Validation

Clean build (`npm run build`, exit 0). `npm run lint` (oxlint) exit 0. `npm run typecheck` exit 0.

Targeted suites, one invocation, exit 0: demo-guest-limits, mcp-guest, mcp-http, mcp-server, docs-guard, cli-policy, policy-explain, policy-load, policy-load-route-floor, policy-match, policy-proposal, intake-limits — **247 tests, 247 pass, 0 fail** (82s).

Demo end to end, separate invocation, exit 0: e2e-web-agent-demo, e2e-web-agent-demo-isolation, e2e-mcp-demo — **4 tests, 4 pass, 0 fail** (68s). Run because the demo policy those twins are trimmed from changed.

The new suite alone: 4 tests, 4 pass, 0 fail. Full `npm test` not run (not required for this task).

## AC 3 is Carter's, and here is exactly what it must show

Left unchecked deliberately. Nothing in this repository can prove it: it needs a second machine, a phone and a room. The rehearsal passes only if every one of these is observed, in this order.

1. `~/demo-guest` is a THROWAWAY directory whose doctor reports the vault row as not-applicable and where no `.approval/vault.enc` exists. Check this first; if it fails, stop, because everything after it is unsafe rather than merely unproven.
2. `approval mcp serve --http --guest` prints a banner reading GUEST, naming `~/demo-guest`, and giving both session caps.
3. The 4681 tunnel is opened through the explicit register/request/wait/run flow against the PRIMARY checkout's log, with the phone deciding it, and the resulting chain carries task.registered, approval.requested, approval.granted, execution.started, execution.completed.
4. A real external MCP client on a SECOND machine (not this laptop, not a second terminal on it) connects to the tunnel URL, and the server's stderr names the `agent:guest-<hex>` it minted for that session.
5. That client calls `instructions`, then `register` and `request` on a seeded envelope, and reads back proceed: false.
6. The phone shows the FULL payload above the buttons, and a tap grants it. The client's `wait` returns granted within a poll, and NOTHING executes: no adapter runs, no email leaves, and the guest has no `run` to call.
7. /rsi shows the queue row appear and clear live, in a browser that is not on the demo laptop. (Blocked today: see the section above. The page and the demo server's CORS have to land first.)
8. Two refusals are observed rather than simulated: a fourth request from that client inside the hour comes back `rate-limited`, and with the queue at ten a further request comes back `queue-full`. Watch the "Request-volume ceilings" table in `.approval/QUEUE.md` count down to them.
9. The tunnel is killed and `~/demo-guest` is binned afterwards, and the repository's own log is checked for drift (`git status --porcelain .approval/` inside the primary, expecting nothing).

If step 4 cannot be arranged with a real second machine, do not check AC 3. A localhost client proves the transport and proves nothing about the tunnel, which is the part that fails on the day.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The crowd demo's intake limits are declared, documented and proven. The demo policy in examples/web-agent-demo/provisioning.md now carries requests_per_hour: 3 on all three manual (guest-reachable) classes and budgets.global.max_pending: 10, with the stale "enforcement lands with the daemon" paragraph retired; tests/demo-guest-limits.test.ts extracts that policy block from the documentation itself, runs the real approval policy check against it, and drives real guest MCP sessions over a loopback HTTP listener until rate-limited (a fourth ask in an hour) and queue-full (an eleventh pending request from a crowd) each fire, with the log proving neither refusal appended anything. The runbook gains section 4, the crowd track: the empty-vault MUST for the throwaway guest instance, seeded envelopes and their mandatory payload_hash, the second gated tunnel on 4681, URL publish-late/rotate-after, every cap in one table with its constant, the accepted shared-queue leak, and flood management including the line that a flood-clear of rejections is not a considered denial. AC 3 (a rehearsal from a second machine with a phone decision) is Carter's and is specified step by step in the notes. The rsi connect section is BLOCKED: rsi/index.html has never landed on main, so the markup is carried in the notes for the branch that owns the page.
<!-- SECTION:FINAL_SUMMARY:END -->
