---
id: APRV-394
title: >-
  Hosted slice for hackathon: policy builder, tenant runner, README under
  hosted/
status: Done
assignee:
  - '@claude'
created_date: '2026-09-20 01:58'
updated_date: '2026-09-20 02:06'
labels: []
dependencies: []
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter wants an honest first step toward "approval.md hosted": we run the daemon for a tenant so the tenant does not run it locally. The shape is one tenant directory per customer, one daemon process per tenant, decisions on the customer's own Telegram bot, and the log staying a portable file in the tenant directory. This task delivers the three files that make that shape demonstrable, wrapping the existing runtime and adding no new network surface.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 hosted/README.md exists and states what is real today and what is next, with a 3-minute demo path
- [x] #2 hosted/policy-builder/index.html is a dependency-free static page rendering a live APPROVAL.md with copy and download
- [x] #3 The builder's output loads with the real policy loader (no load failure, class rules resolve as written)
- [x] #4 node hosted/tenant.mjs <dir> runs init when needed, starts the daemon and the Telegram listener with prefixed output, and exits cleanly on SIGINT
- [x] #5 The Telegram listener exiting on missing env variables names them and leaves the daemon running
- [ ] #6 No changes under src/, and npm test plus npm run lint still pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read examples/email-demo.md, src/cli/daemon.ts RUN_FLAGS, src/cli/paths.ts, src/cli/init.ts flags, src/cli/channel-telegram.ts LISTEN_FLAGS, schema/policy.schema.json and src/core/policy-load.ts, so the generated policy uses only keys and autonomy levels the loader accepts.
2. Write hosted/policy-builder/index.html: plain JS, no dependencies, form on the left (approver id, Telegram numeric sender id, default autonomy, TTL, fixed telegram channel, editable class table seeded with read.* / files.write.workspace / message.send / spend.* / files.delete.* / vcs.push.main), live-rendered APPROVAL.md on the right with Copy and Download.
3. Write hosted/tenant.mjs: resolve the CLI as node <repo>/cli.js, exit 2 pointing at the builder when APPROVAL.md is absent, run approval init --dir when .approval/ is absent, then spawn approval daemon run (--dir, --no-preflight, --no-build, --no-draw) and approval channel telegram listen (--dir) with cwd set to the tenant dir and line-prefixed piped output; SIGINT/SIGTERM stops both; a telegram exit prints the variables to export and leaves the daemon up.
4. Write hosted/README.md describing the hosted shape, what is real today, what is next, and a 3-minute demo that hands off to examples/email-demo.md.
5. Verify: npm run build; generate the builder's exact output in node by extracting its own build() from the page and load it with approval policy check --json; run tenant.mjs against that scratch tenant for ~6s and interrupt it; npm test and npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivered hosted/README.md, hosted/policy-builder/index.html, hosted/tenant.mjs. Nothing under src/, SPEC.md, APPROVAL.md, .approval/ or CLAUDE.md was touched; git status shows only the new hosted/ folder and this task file.

SPEC 11 invariants: this task touches none of them. The three files add no enforcement path and no new network surface. The policy builder is a static page that renders text and never reads a log or a decision; the web channel stays loopback-only and is not involved at all. tenant.mjs spawns the existing 'approval daemon run' and 'approval channel telegram listen' unchanged, so every append still goes through the same gate and compare-and-append path; it passes --no-draw so this supervision opens no port, and --no-preflight/--no-build because a tenant directory is not a git checkout of this repository. No event is written, read back, or reordered by anything here, and no secret is rendered: the builder emits only the policy's declared structure, and the missing-credential message names the VARIABLE NAMES (APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT) and never a value.

Decisions worth recording:
- The builder offers only human-only / manual / supervised-retro / autonomous. supervised-live is deliberately absent: schema/policy.schema.json requires a live_rate beside it, and a rate this form invented would be a gating fraction no author wrote.
- defaults.token_delivery is emitted as 'sealed' and on_expiry as 'reject', the two values the schema admits that keep a token off the channel.
- The generated file is markdown prose plus one ```yaml approval-policy fence, which is what core/policy-load.ts extracts.
- The listener is allowed to exit and the daemon is deliberately kept alive: a tenant with no bot configured still has a log being swept and a queue being regenerated, and the operator gets one line naming what to export.

Verification: npm run build exit 0. The builder's own build() was extracted from the page and run in node, so the tested bytes are the bytes the browser emits; 'node cli.js policy check message.send --dir <scratch> --json' returned loadFailure:null, provenance:'rule', final manual, and read.file.repo resolved autonomous through read.*. The page was opened in a browser: 6 seeded class rows, live output rendered. 'node hosted/tenant.mjs <scratch>' ran init, started the daemon (tick 1, queue regenerated), the listener exited 2 on the absent bot variables with the guidance line printed and the daemon still running, and SIGINT stopped both with exit 0.

npm run lint (oxlint src tests) exit 0; oxlint over hosted/ also exit 0.

AC 6 is LEFT UNCHECKED on purpose. npm test exited 1: 4798 passing, 83 failing. Every failure traces to one of two environment faults that predate this branch and live outside every file this task touched: (a) node_modules/better-sqlite3 is built for NODE_MODULE_VERSION 137 while this Node needs 147, which fails every reindex and index test, and (b) this Node refuses 'options.servername' set to an IP address, which fails the mock-SMTP email adapter and setup-adapter tests. Neither is reachable from a static page, a README, or a process supervisor. The repair is an npm rebuild, which is a deps-class action this session did not take.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added hosted/README.md, hosted/policy-builder/index.html and hosted/tenant.mjs: the honest first slice of approval.md hosted (one tenant directory, one daemon per tenant, decisions on the tenant's own Telegram bot, log stays a portable file). Verified by running the page's own build() in node and loading the result with 'approval policy check --json' (loadFailure null, rules resolve as written), by opening the page in a browser (6 seeded rows, live render), and by running 'node hosted/tenant.mjs' against a scratch tenant: init ran, the daemon ticked and regenerated the queue, the listener exited on the absent bot variables while the daemon stayed up, and SIGINT exited 0. npm run build and npm run lint exit 0. AC 6 is unchecked: npm test exits 1 with 83 pre-existing environment failures (better-sqlite3 ABI mismatch, Node refusing a TLS servername that is an IP address), none of them in a file this task touches.
<!-- SECTION:FINAL_SUMMARY:END -->
