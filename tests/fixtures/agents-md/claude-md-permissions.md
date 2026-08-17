<!--
FIXTURE PROVENANCE — DO NOT EDIT TO MAKE A TEST PASS.

Below this comment are the bytes of the "## Permissions" section of this
repository's CLAUDE.md, copied verbatim on 2026-08-17 (APRV-64). CLAUDE.md
declares that section to be "the first fixture for `approval import agents-md`
in M6", and this file is that fixture.

The copy is deliberate. Reading CLAUDE.md at test time would mean a later edit
to the repository conventions silently changed what the importer is pinned
against, and the pinned bytes in tests/agents-md.test.ts would start asserting
a moving target. If CLAUDE.md changes and this fixture should follow, that is a
human decision, made in a diff that shows both sides.
-->

## Permissions

### Allowed without prompting
- Read files, list directories, search the repo
- Edit source, tests, fixtures, and Backlog.md task files
- Run tests, lint, typecheck, build; `node`/`tsx` scripts inside the repo
- Local git: status, diff, add, commit on feature branches

### Require approval first
- `git push`, merges to `main`, tag creation
- `npm publish`, `npm version`, any registry interaction
- Adding or upgrading dependencies
- Deleting files outside the current task's stated scope
- Any network call beyond package installs (API calls, webhooks, sends)
- Edits to `APPROVAL.md`, `.approval/`, `CLAUDE.md`, or CI/release config

### Never
- Touch credentials, tokens, or the vault
- Rewrite git history on shared branches
- Mutate `events.jsonl` or fabricate log entries — including in tests;
  test logs are built through the real append path

*(This section is intentionally AGENTS.md-convention format: it is the
first fixture for `approval import agents-md` in M6.)*
