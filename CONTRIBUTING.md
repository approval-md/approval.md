# Contributing

Thanks for looking. Two documents cover most of what you need:

- `CLAUDE.md` describes how work moves through this repository: every change
  is a Backlog.md task, the repository runs behind its own approval policy,
  and the log is append-only. `AGENTS.md` is the same workflow for Cursor and
  Codex agents.
- `GOVERNANCE.md` describes who holds the specification and the name, and
  the terms under which the code and the format are licensed.

## Licences

- Contributions to the code (everything outside `SPEC.md` and `schema/`) are
  licensed under Apache 2.0, the same terms as the rest of the runtime.
- Contributions to `SPEC.md` and `schema/` are dedicated to the public domain
  under CC0 1.0, the same terms as the rest of the specification.

Opening a pull request is your agreement to those terms for that
contribution.

## Developer Certificate of Origin

Outside human contributions must be signed off under the Developer
Certificate of Origin, version 1.1 (https://developercertificate.org). Add
the sign-off with `git commit -s`, which appends a line of the form:

```
Signed-off-by: Your Name <you@example.com>
```

The sign-off certifies that you wrote the change or have the right to submit
it under the licence above. There is no contributor licence agreement and no
copyright assignment. The DCO exists for one reason: it keeps a later move of
the specification and name to a neutral body possible without chasing every
past contributor for a signature.

Commits authored by an AI tool under a maintainer's direction carry the
tool's co-author trailer and the maintainer's sign-off responsibility.

## What a good contribution looks like

- It has a Backlog.md task with acceptance criteria and, at completion,
  implementation notes.
- `npm test` and `npm run lint` pass.
- It does not weaken any of the global invariants in `SPEC.md` §11. A diff
  that does fails review regardless of its stated goal.
- It never touches `APPROVAL.md`, `.approval/`, or `events.jsonl`. Policy
  changes are proposed as tasks for the maintainer.
