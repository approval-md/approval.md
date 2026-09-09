# APRV-193 — SPEC and CLAUDE.md amendment text, for human sign-off

**Status: drafted, NOT applied.** Nothing in this file has been written into
`SPEC.md` or `CLAUDE.md`; both are protected paths and the build lane does not
touch them. This is the text to apply, the questions that have to be answered
before some of it can be, and an honest statement of where the shipped build
differs from what the text would require.

The design this comes from is `design/aprv-193-starve-the-code.md` (APRV-193's
design lane). What shipped is `src/core/sandbox.ts`, `src/cli/sandbox.ts`, the
`approval run` wiring, the classifier's wrapper unwrapping, the hook's optional
requirement, and `docs/sandboxed-exec.md`.

---

## 1. What shipped, so the text can be read against it

| Drafted | Shipped | Gap |
|---|---|---|
| egress denied for allowed-class exec | yes, on macOS: `approval run` without a token, and `approval sandbox` | Linux and Windows have no mechanism in this build |
| the ceiling is computed from the resolved class | **no**: the shipped rule is "a token was presented" | see §5, question 1 |
| an envelope may declare `egress.allow`, intersected with the ceiling | **no** | needs the schema change of APRV-193c |
| `sandbox-unavailable` in `execute_refusal_codes` | **no**: the refusal is a stderr message and exit 127, nothing appended | widens a frozen union; question 4 |
| `exec.sandbox: required | advisory` policy key | **no**: `APPROVAL_SANDBOX_REQUIRED=1` is the interim | policy lives in `APPROVAL.md`, which agents do not edit |
| `execution.started` records what was applied | yes: `sandbox`, with four values | the field is not constrained in `schema/event.schema.json` (payload shape is open); constraining it is its own task, per CLAUDE.md |

---

## 2. Draft for SPEC.md §7 (side-effect taxonomy)

> Insert after the `account.credential` paragraph (APRV-194):
>
> `exec.*` and the developer-workstation classes that run project code name the
> execution of code the runtime did not author, so the class states what MAY
> happen and the runtime's sandbox states what CAN. An implementation SHOULD
> execute such an action with outbound network denied by the operating system
> wherever no human has approved the specific bytes, and SHOULD permit egress
> only under a grant. The permission is computed by the runtime and is never
> read from a declaration by the party under oversight; where an implementation
> accepts an egress declaration on an envelope it applies it as an INTERSECTION
> with what the runtime already permits and never as a widening, so §11.1
> invariant 4 holds over it unchanged. A declaration naming a host outside that
> ceiling is refused `envelope-invalid` at registration. Because such a
> declaration is part of the payload the grant binds to (§10.4), the approver
> approved those hosts, and a change after the grant is `payload-mismatch` on
> the existing path. (Amended APRV-193, pending sign-off.)

## 3. Draft for SPEC.md §10.4 (adapters and hard enforcement)

> Insert after the APRV-205 paragraph:
>
> An implementation SHOULD spawn a granted argv inside an operating-system
> sandbox that denies outbound network, except where the execution rests on a
> human's grant over those exact bytes: a grant IS the authority to reach the
> world, and an executor that denied egress under one would have no door at all.
> `execution.started` records which room the child ran in, so an auditor can
> distinguish an execution that ran starved, one that ran under a grant, one
> whose operator took a recorded opt-out, and one that ran on a platform where
> the implementation has no mechanism. A machine whose mechanism is present and
> broken refuses before anything is appended and before any token is spent, so a
> machine that cannot protect an execution costs no authority: the same token
> executes once the mechanism works. (Amended APRV-193, pending sign-off.)
>
> The custody of the environment (APRV-205) and the custody of the filesystem
> are the same rule applied twice: the credential material beside the log (the
> vault, the environment source map, the sealing keys) is unreadable to a
> spawned child wherever the platform can express that. What this buys is
> bounded, and is stated rather than implied: the granted process can read what
> it was given, and so can its descendants, and every OTHER process has nothing.

## 4. Draft for SPEC.md §11.1 (global invariants), as invariant 11

> 11. **Allowed execution is starved by default.** A process the runtime spawns
>     for an action no human approved receives no outbound network and no
>     credential. The permission to reach the world is computed by the runtime
>     from what it can verify (a grant it can check, never a claim the executing
>     party makes about itself), and a declaration by that party may only narrow
>     it. An operator's opt-out is recorded on the execution it applies to, and a
>     platform on which the implementation cannot provide the sandbox is recorded
>     on every execution that ran without it. (`tests/sandbox.test.ts`.)
>     (Amended APRV-193, pending sign-off.)

*Numbering note: the design lane drafted this as invariant 10; §11.1 has since
gained the values-block invariant (APRV-238) at 10, so it is drafted here as 11.
Confirm the number against the file at the time of application.*

## 5. Draft for SPEC.md §11.2 (refusal-code registry)

Only if question 4 below is answered yes.

> Add to the `execute_refusal_codes` table, in definition order after
> `budget-exceeded`:
>
> | `sandbox-unavailable` | The runtime has a sandbox mechanism for this platform and it did not work, so the execution the executor promised to starve cannot be starved. Probed rather than inferred, because an installed mechanism on a kernel with the feature disabled exists and fails. Evaluated before the token is spent and before anything is appended, so a machine that cannot protect an execution costs no authority: the same token executes once the mechanism is available. |

## 6. Draft for CLAUDE.md

> Add to the "Engineering invariants (from SPEC.md, enforced in review)" list,
> after "Global invariants are implicit acceptance criteria":
>
> - **Allowed execution is starved.** A child this runtime spawns for an action
>   no human approved gets no egress and no credential: environments are built
>   by `core/child-env.ts` and never inherited, and the child runs under the
>   egress profile of `core/sandbox.ts` wherever the platform has one. A diff
>   that reintroduces an inherited environment on a spawn path, or that spawns
>   an ungranted child outside the profile, fails review.

> And to the "Permissions → Allowed without prompting" list:
>
> - `approval sandbox -- <command>` — the wrapper that runs a command with no
>   way out to the network. It classifies as the command inside it, so it
>   neither hides anything from the gate nor asks anything extra of it.

---

## 7. The questions only Carter can answer

The design lane asked six; two were settled by building, and these four are
still open.

1. **Is "a token was presented" the right line?** The design proposed a
   class-derived ceiling (a table from resolved class to permitted hosts). What
   shipped is simpler and is decided before the append: a child whose execution
   rests on a human's grant over these exact bytes keeps the network, and every
   other child is starved. It cannot be gamed, because a token that does not
   verify runs no command at all, and it costs precision: a manual action that needs
   no network keeps it, and a supervised action that legitimately needs one host
   must take the recorded `--no-sandbox` rather than a narrow allowance. **Keep
   the simple line, or build the ceiling table and the envelope declaration
   (APRV-193c)?**

2. **Platform fallback.** On macOS a broken mechanism refuses. On a platform
   with no mechanism, `approval run` PROCEEDS and records
   `sandbox: "unsupported"`, because refusing there would take the execution
   path away from every operator not on macOS. The design argued for
   fail-closed by default with an attested `exec.sandbox: advisory` as the
   escape. **Ship the policy key and flip the default to required, or leave the
   interim `APPROVAL_SANDBOX_REQUIRED=1` until Linux exists (APRV-193g)?**

3. **Does the fleet turn the hook requirement on?** `APPROVAL_HOOK_REQUIRE_SANDBOX=1`
   makes an unwrapped `npm test` / `node x.mjs` / `tsc` deny with
   `hook-sandbox-required` and names the spelling that works. Off by default.
   Turning it on is the difference between a wrapper agents may use and a
   wrapper they must. **On, and from when?**

4. **Widening a frozen union.** `sandbox-unavailable` would add a member to
   `execute_refusal_codes`, which §11.1 invariant 6 freezes as public API. It is
   not added in this build: the refusal is a stderr message and exit 127 with
   nothing appended, which is correct behaviour with an inferior vocabulary: an
   agent branching on refusal codes sees no code at all here. **Confirm the
   union may grow, and it goes in with the §11.2 row above.**

## 8. Two things the build learned that the design did not know

- **An agent harness cannot run under the sandbox.** `claude` and `cursor-agent`
  need the model API, which is exactly what is denied, so the "launch the
  session under `approval sandbox`" half of the design does not work as written.
  A session-wide sandbox needs an egress allowlist reaching one host, which
  Seatbelt cannot express by hostname and which the prior art solves with a
  local proxy. The unit protected in this build is therefore the COMMAND, and
  the hook requirement is what makes commands wear it. This is the largest gap
  between the design and what is possible today, and it deserves its own task.
- **Seatbelt's `sandbox-exec` exits 71 when its `execvp` fails**, which would be
  recorded as the child's own exit code. The runtime resolves the command to an
  absolute path first and never wraps one it cannot find, so a missing command
  still fails as the ENOENT it is.
