/**
 * Help text. SPEC.md §10.1 makes `--help` part of the interface rather than a
 * courtesy: the CLI is how agents use this system, and an agent that has to
 * guess an exit code or a JSON key is an agent that will guess wrong on the one
 * invocation that mattered. Every command therefore documents its flags, the
 * full exit-code table, and its exact `--json` shape.
 */

const EXIT_CODES = `Exit codes (frozen public API):
  0  success
  1  integrity failure (corrupt log)
  2  usage error
  3  torn tail
  4  I/O error (unreadable/unwritable path; never reported as corruption)`;

const JSON_ERRORS = `With --json, usage and I/O failures print {"error":{"code","message"}} to
stderr and nothing to stdout.`;

export const ROOT_HELP = `approval — human approval for agent actions (pre-release)

Usage:
  approval log verify [--log <path>] [--json]
  approval log tail   [--log <path>] [-n <count>] [--json]
  approval log export [--log <path>] [--json]
  approval policy check|test <class> [--reversible true|false] [--policy <path>] [--dir <path>] [--json]
  approval policy attest [--policy <path>] [--dir <path>] [--as human:<id>] [--json]
  approval register   <task-file> [--as <id>] [--log <path>] [--json]
  approval request    <task> --action <key> [--as <id>] [--json]
  approval grant|reject|revoke <action-key> [--note <text>] [--as human:<id>] [--json]
  approval expire     <action-key> [--json]
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval --help

Commands:
  log       inspect the append-only event log (verify | tail | export)
  policy    explain what APPROVAL.md does with an action class (check | test),
            or record a human's sign-off on the policy file (attest)
  register  validate a task envelope and append task.registered
  request   ask the gate to admit a declared action (manual classes append
            approval.requested; supervised/autonomous append nothing and
            proceed straight to execution, per amended SPEC.md §6.3)
  grant     record a human approval          (HUMAN-ONLY)
  reject    record a human refusal           (HUMAN-ONLY)
  revoke    withdraw an unexecuted approval  (HUMAN-ONLY)
  expire    lapse a request whose TTL passed (system verb, actor system:gate)
  reindex   rebuild the SQLite index projection from the log

Defaults:
  log    .approval/log/events.jsonl   (relative to the working directory)
  index  .approval/index.sqlite

${EXIT_CODES}

Machine-readable output: every command accepts --json and prints exactly one
JSON object per invocation. Run "approval <command> --help" for that command's
exact shape.
${JSON_ERRORS}

The log is append-only. "policy attest" and the gate verbs (register, request,
grant, reject, revoke, expire) each append at most one event per invocation; a
torn tail is reported, never repaired, and nothing ever rewrites a line.

grant, reject and revoke are HUMAN-ONLY: the actor must match human:<id>, from
--as or APPROVAL_HUMAN. expire is the system verb and takes no identity.

A gate refusal — an illegal transition, an expired request, an unattested
policy, a failed budget — exits 1, NOT 2. The command was well-formed; the
answer is no. With --json, error.code names the refusal.`;

export const LOG_HELP = `approval log — read the append-only event log

Usage:
  approval log verify [--log <path>] [--json]
  approval log tail   [--log <path>] [-n <count>] [--json]
  approval log export [--log <path>] [--json]

Subcommands:
  verify   walk the hash chain end to end and report clean | torn-tail | corrupt
  tail     print the last N records (default 10)
  export   stream every stored line to stdout, byte for byte

Default log path: .approval/log/events.jsonl (relative to the working directory)

${EXIT_CODES}

JSON shapes (one object per invocation, on stdout):
  verify  {"status","records","head","intactThroughSeq"?,"firstBadSeq"?,"reason"?,"message"?}
  tail    {"status":"ok"|"torn-tail","records":[...],"warning"?}
  export  {"records":[...],"warning"?}
${JSON_ERRORS}

All three commands open the log for reading only.`;

export const VERIFY_HELP = `approval log verify — verify the log's hash chain

Usage:
  approval log verify [--log <path>] [--json]

Flags:
  --log <path>   log file to verify (default .approval/log/events.jsonl)
  --json         machine-readable output
  -h, --help     this text

Walks every complete line: re-derives each record's digest, follows the prev
chain and the seq succession, and reports the first place the log stops being
self-consistent. An absent file is an empty log and verifies clean. Nothing is
written, and a torn tail is never truncated.

${EXIT_CODES}
  verify maps 1:1 onto the core statuses: clean -> 0, corrupt -> 1,
  torn-tail -> 3. An unreadable log is 4, not 1: a permission bit is not
  evidence of tampering.

JSON shape (stdout, one object):
  clean      {"status":"clean","records":3,"head":{"seq":3,"hash":"<64 hex>"}}
  torn-tail  {"status":"torn-tail","records":3,"head":null,
              "intactThroughSeq":3,"message":"..."}
  corrupt    {"status":"corrupt","records":null,"head":null,
              "firstBadSeq":2,"reason":"hash-mismatch","message":"..."}
  head is null for an empty log. reason is one of malformed-line,
  schema-invalid, bad-alg, hash-mismatch, prev-mismatch, seq-gap,
  seq-duplicate, not-genesis, head-mismatch.
${JSON_ERRORS}

Human output: the status and head on stdout; reason, first bad seq, and the
full message on stderr.`;

export const TAIL_HELP = `approval log tail — print the last records of the log

Usage:
  approval log tail [--log <path>] [-n <count>] [--json]

Flags:
  --log <path>   log file to read (default .approval/log/events.jsonl)
  -n <count>     how many records to print (default 10; 0 prints none)
  --json         machine-readable output
  -h, --help     this text

The chain is verified first. On a torn tail the intact records are printed and
the tear is a warning on stderr — nothing is repaired, and the exit code is 0.
On a corrupt log no records are printed at all: a tail of tampered data is
worse than no tail. An empty or absent log prints nothing and succeeds.

${EXIT_CODES}
  tail: 0 on success (torn tail included), 1 on a corrupt log, 2 for a bad -n,
  4 when the log cannot be read.

JSON shape (stdout, one object):
  {"status":"ok","records":[<event objects, oldest first>]}
  {"status":"torn-tail","records":[...],"warning":"..."}
${JSON_ERRORS}

Human output: one line per record — seq, ts, event, actor, task.`;

export const EXPORT_HELP = `approval log export — stream the whole log to stdout

Usage:
  approval log export [--log <path>] [--json]

Flags:
  --log <path>   log file to read (default .approval/log/events.jsonl)
  --json         machine-readable output
  -h, --help     this text

Without --json the stored lines are written verbatim, byte for byte, exactly as
they sit in the file: no re-serialization, no reformatting, no trailing edits.
Piping export to a file yields a copy of the log. The chain is verified first;
a torn tail prints the intact lines with a stderr warning and exits 0, a
corrupt log prints nothing and fails. The log is never modified.

${EXIT_CODES}
  export: 0 on success (torn tail included), 1 on a corrupt log, 4 when the log
  cannot be read.

JSON shape (stdout, one object):
  {"records":[<every event object, oldest first>]}
  {"records":[...],"warning":"..."}   on a torn tail
${JSON_ERRORS}`;

/**
 * The policy command's exit-code stance, printed in all three policy help
 * texts. It is the one place where "answer" and "error" come apart, so it is
 * stated at length rather than assumed: `policy check` answers the question
 * "what would policy do with this class", and a policy too broken to load has
 * a perfectly good answer — manual, everything, always.
 */
const POLICY_EXIT_CODES = `${EXIT_CODES}
  policy check|test uses only 0, 2 and 4:
    0  the question was answered — INCLUDING the fail-closed answer. A missing,
       unparseable or schema-invalid policy is not an error here: a broken
       policy IS a manual-everything policy, and "manual, because the policy
       failed to load: <code>" is the answer, delivered on stdout with exit 0.
       Branch on manualBecause / provenance, not on the exit code, to tell a
       deliberate manual from a broken one.
    2  usage — missing <class>, unknown flag, or a class that is not a valid
       action class (lowercase dotted segments; wildcards are patterns, not
       actions, and are rejected).
    4  I/O — a policy path that exists but cannot be read (a permission bit).
       Never used for a parse or schema failure; those are the answer above.
  1 and 3 are never returned by this command.`;

const POLICY_MANUAL_BECAUSE = `manualBecause — why a manual answer is manual (null when it is not manual):
  "matched-rule"           a classes rule, or defaults.autonomy, says manual.
                           The policy was read and understood, and it says ask.
  "irreversibility-floor"  policy granted autonomous/supervised and SPEC §7's
                           floor overrode it because --reversible false was
                           given. overridden records what policy actually said.
  "load-failure"           the policy could not be loaded at all, so every
                           class is manual. loadFailure carries code + message.`;

export const POLICY_HELP = `approval policy — explain what policy does with an action class

Usage:
  approval policy check <class> [--reversible true|false] [--policy <path>] [--dir <path>] [--json]
  approval policy test  <class> [--reversible true|false] [--policy <path>] [--dir <path>] [--json]
  approval policy attest [--policy <path>] [--dir <path>] [--as human:<id>] [--json]

Subcommands:
  check   explain the autonomy resolution for <class>
  test    exact alias of check (SPEC.md §10.1 names both)
  attest  record a human's sign-off on the policy file's bytes (human-only;
          gate operations refuse while the live file is unattested or changed).
          Run "approval policy attest --help" — it is the only policy verb that
          writes to the log.

Nothing is executed, requested, or logged: this command reads APPROVAL.md and
answers a hypothetical. Discovery is APPROVAL.md then APPROVALS.md in --dir
(default: the working directory); --policy names a file directly and wins.

${POLICY_EXIT_CODES}

${POLICY_MANUAL_BECAUSE}

Run "approval policy check --help" for the flags and the full --json shape.`;

function policyVerbHelp(verb: "check" | "test", alias: "check" | "test"): string {
  return `approval policy ${verb} — explain what policy does with an action class

Usage:
  approval policy ${verb} <class> [--reversible true|false] [--policy <path>] [--dir <path>] [--json]

Flags:
  --reversible <true|false>
                   whether the action can be undone. Omit it and the question is
                   left open (reversible: null): policy answers on its own terms.
                   --reversible false engages SPEC §7's irreversibility floor,
                   which floors autonomous and supervised to manual. It takes an
                   explicit value because "unstated", "reversible" and
                   "irreversible" are three different questions.
  --policy <path>  policy file to read (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
                   (default: the working directory)
  --json           machine-readable output
  -h, --help       this text

\`policy ${verb}\` is an exact alias of \`policy ${alias}\`; both are named in
SPEC.md §10.1 and they are the same command. <class> is a concrete action class
(lowercase dotted segments, e.g. read.web, vcs.push.main) — not a pattern: \`*\`
is something a policy key may contain, never something an agent can do.

${POLICY_EXIT_CODES}

${POLICY_MANUAL_BECAUSE}

JSON shape (stdout, one object):
  {"class":"vcs.push.main","reversible":null,
   "outcome":{"autonomy":"supervised","approvers":null,"limits":null},
   "provenance":"rule"|"default"|"fail-closed"|"floor",
   "manualBecause":null|"matched-rule"|"irreversibility-floor"|"load-failure",
   "loadFailure":null|{"code":"file-missing"|"no-block"|"multiple-blocks"|
                       "yaml-error"|"schema-invalid","message":"..."},
   "matched":null|{"pattern":"vcs.push.main","rule":{"autonomy":"supervised"}},
   "overridden":null|{"pattern":"read.web"|null,"autonomy":"autonomous"},
   "candidates":[{"pattern":"read.*","specificity":[1,1,2],
                  "autonomy":"autonomous","winner":true,
                  "tieBreak":"specificity"|"strictest-autonomy"|
                             "lexicographic"|"tied-specificity"}],
   "decisionPath":["...","..."]}
  specificity is [literalSegments, wildcardSegments, totalSegments] (SPEC §5.2).
  overridden.pattern is null when the floor overrode defaults.autonomy rather
  than a rule.
${JSON_ERRORS}

Human output: the decisionPath lines, then a final line "-> <autonomy>" carrying
"(fail-closed: <code>)" or "(floor applied over <pattern>: <autonomy>)" when
either applies. stderr stays empty on a successful answer.`;
}

export const POLICY_CHECK_HELP = policyVerbHelp("check", "test");
export const POLICY_TEST_HELP = policyVerbHelp("test", "check");

export const POLICY_ATTEST_HELP = `approval policy attest — record a human's sign-off on the policy file

Usage:
  approval policy attest [--policy <path>] [--dir <path>] [--as human:<id>]
                         [--log <path>] [--json]

Flags:
  --policy <path>  policy file to attest (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
                   (default: the working directory)
  --as human:<id>  the human attesting; overrides APPROVAL_HUMAN
  --log <path>     log file to append to (default .approval/log/events.jsonl)
  --json           machine-readable output
  -h, --help       this text

Appends one policy.updated event carrying the SHA-256 of the policy file's exact
bytes:  payload {"policy_path":"APPROVAL.md","sha256":"<64 hex>"}. Gate
operations refuse whenever the live file's hash differs from the latest
attestation or no attestation exists, with the distinct machine-readable reason
"policy-not-attested". An edited policy is inoperative until a human re-attests
it.

Human-only. The actor must match human:<id>; an agent: or system: actor is
refused before anything is read or written. Identity is CONFIG-DECLARED — it
comes from --as or the APPROVAL_HUMAN environment variable, and nothing here
authenticates it. The trust boundary is the local machine: anyone who can set
that variable and write to the log is inside it. An attestation therefore proves
that someone with local control signed off, not who — cryptographic identity is
future work, not a v0.1 claim.

Bytes, not parse: the file is hashed as it sits on disk and does NOT have to be
loadable. Attesting a schema-invalid policy is allowed and records exactly what
it says — a human saw these bytes. It does not make a broken policy work; a
policy that fails to load is still manual-everything (see policy check).

${EXIT_CODES}
  policy attest: 0 when the attestation was appended; 2 for usage — no
  resolvable human identity, an --as that is not human:<id>, or an unknown flag;
  3 when the log's final line is torn (a crashed write, never repaired here);
  4 for I/O — the policy file is absent or unreadable, or the log cannot be
  written.

JSON shape (stdout, one object):
  success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/APPROVAL.md"}
  refusal  {"ok":false,"error":{"code":"...","message":"..."}}  on stderr
  path is the file that was hashed; the logged payload carries its basename
  only, so an exported log leaks no home directory.
${JSON_ERRORS}`;

/**
 * The gate verbs' shared stance, printed in every gate help text.
 *
 * Two things an agent must not have to infer: that a refusal is exit 1 and not
 * exit 2 (the command was fine, the answer is no), and that supervised and
 * autonomous actions produce no approval events at all — an agent waiting for an
 * `approval.granted` that the spec says will never exist would wait forever.
 */
const GATE_EXIT_CODES = `${EXIT_CODES}
  The gate verbs use all five:
    0  the operation succeeded and the event was appended (or, for a
       supervised/autonomous request, no event was needed).
    1  GATE REFUSAL — the command was well-formed and the runtime said no:
       an illegal transition, an expired request, an unattested policy, a
       failed budget. This is not a usage error and retrying with different
       flags is the wrong repair; branch on error.code in --json.
    2  usage — unknown flag, missing argument, or no resolvable identity.
    3  torn tail — the log's final line is unterminated (a crashed write).
       Never repaired here.
    4  I/O — the log or the task file could not be read or written.`;

const GATE_MANUAL_PATH = `Amended SPEC.md §6.3: approval.* events are EXCLUSIVE to the manual path. An
action whose class resolves to supervised or autonomous emits no
approval.requested and no approval.granted — "approval request" appends nothing
and reports proceed:true. Its authorization is the execution.started event
(APRV-18), which is also where its budget is charged. Do not wait for a grant
that will never come.`;

const GATE_REFUSAL_CODES_HELP = `Refusal codes (error.code with --json; frozen public API):
  policy-not-attested     policy unattested or its bytes changed since
                          attestation (detail: not-attested | hash-mismatch |
                          unreadable). Run "approval policy attest".
  envelope-invalid        the envelope failed envelope.schema.json, or the task
                          file has no frontmatter / no approval: key.
  task-file-unreadable    the task file could not be read (exit 4).
  task-already-registered this task id already has a task.registered record.
  not-registered          the task has no task.registered record.
  action-not-registered   the task declares no action with that idempotency key.
  duplicate-request       a live approval.requested already awaits a decision.
  already-executed        the action key already has an execution.started.
  budget-exceeded         APRV-14 verdicts failed; a budget.exceeded event WAS
                          appended and error.verdicts lists the failures.
  not-requested           there is no request to decide or expire.
  already-decided         the request is already granted/rejected/revoked/expired.
  not-granted             revoke was attempted on a request that is not granted.
  expired                 the TTL lapsed, judged from the request's own ts.
  not-expired             expire was called before the TTL lapsed (or the policy
                          declares no defaults.approval_ttl).
  actor-invalid           the actor is not a well-formed human:/agent: identity.
  actor-not-human         a human-only verb was attempted by another actor.
  log-unreadable          the log could not be read (exit 4).
  log-torn-tail           the log's final line is unterminated (exit 3).
  append-failed           the append itself failed; exit code follows the cause.`;

export const REGISTER_HELP = `approval register — validate a task envelope and record it

Usage:
  approval register <task-file> [--as human:<id>|agent:<id>] [--log <path>] [--json]

Flags:
  --as <id>      who is registering; human:<id> or agent:<id>. Falls back to
                 APPROVAL_HUMAN. Registration is a proposal, not a decision, so
                 an agent may perform it.
  --log <path>   log file to append to (default .approval/log/events.jsonl)
  --json         machine-readable output
  -h, --help     this text

Reads the task file's YAML frontmatter, validates the value of its \`approval:\`
key against envelope.schema.json, and appends one task.registered event carrying
the declared actions. FAIL CLOSED: an invalid envelope appends nothing.

The file is READ ONLY. Nothing is rewritten, so unknown frontmatter keys are
preserved trivially; round-trip rewriting is a later milestone. The task id comes
from the frontmatter's \`id\` — a Backlog.md board key, not part of the envelope.

Registering the same task id twice is refused: two declarations of one id would
leave every later "what class is this key?" lookup guessing. An envelope that
changed after registration is envelope.drift, not a second registration.

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"seq":1,"task":"task-042","actions":1}
  refusal  {"ok":false,"error":{"code":"...","message":"...","errors"?:[...]}}
           on stderr, where errors carries the schema failures.

${GATE_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;

export const REQUEST_HELP = `approval request — ask the gate to admit a declared action

Usage:
  approval request <task> --action <key> [--as human:<id>|agent:<id>]
                   [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --action <key>   the action's idempotency_key, as registered (required)
  --as <id>        who is requesting; human:<id> or agent:<id>, else APPROVAL_HUMAN
  --policy <path>  policy file to apply (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
                   (default: the working directory)
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

The action's class, cost, reversibility and summary are read from the
task.registered record in the LOG — there are no --class or --cost flags. An
agent that could name its own class at request time could declare read.web for
an action registered as financial.spend, and SPEC.md §7's "the class MUST be
declared before a token can be requested" would mean nothing. Register once from
the file; request against what was registered.

Order of checks, each with its own refusal code: identity, then attestation
(policy-not-attested), then class resolution through the real policy engine
including SPEC §7's irreversibility floor, then — on the manual path only —
request legality (duplicate-request, already-executed), then budgets, then the
append of approval.requested.

${GATE_MANUAL_PATH}

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  manual        {"ok":true,"task":"task-042","action_key":"...","class":"...",
                 "autonomy":"manual","proceed":false,"requested":true,"seq":3}
  non-manual    {"ok":true,...,"autonomy":"autonomous","proceed":true,
                 "requested":false,"seq":null}
  refusal       {"ok":false,"error":{"code":"...","message":"...",
                 "verdicts"?:[...],"detail"?:"...","state"?:"...","seq"?:N}}
                 on stderr. seq is the budget.exceeded record that WAS appended.

${GATE_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;

function decisionHelp(verb: "grant" | "reject" | "revoke"): string {
  const event = verb === "grant" ? "approval.granted" : verb === "reject" ? "approval.rejected" : "approval.revoked";
  const legality =
    verb === "revoke"
      ? `Legal only on a GRANTED request that has NOT executed: an unexecuted grant can
be withdrawn, an executed one cannot be un-sent (not-granted / already-executed).`
      : `Legal only on a request that is awaiting a decision. A second decision is
refused (already-decided) — the log is append-only and a human's answer is not
overwritten.`;
  const attestation =
    verb === "grant"
      ? `Attestation is REQUIRED: granting is the authorizing decision, so an
unverified policy cannot produce one (policy-not-attested).`
      : `Attestation is NOT required for this verb. It withdraws authority rather than
granting it, and refusing it because a policy file changed would leave a live
authorization standing.`;
  const budgets =
    verb === "grant"
      ? `Budgets are RE-EVALUATED at grant time — the request may have aged in the
queue while other actions consumed the window, and the moment that matters for a
commitment is the moment the human commits. A failure appends budget.exceeded
and refuses.

The appended approval.granted carries payload {"class","est_cost_usd"} copied
from the request: the budgets evaluator meters authorization from exactly those
two fields.`
      : `No budget is charged: an authorization that was refused or withdrawn was never
a commitment (see the consumption contract in core/budgets.ts).`;

  return `approval ${verb} — record a human ${verb === "grant" ? "approval" : verb === "reject" ? "refusal" : "withdrawal"} (HUMAN-ONLY)

Usage:
  approval ${verb} <action-key> [--note <text>] [--as human:<id>]
                 [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --note <text>    free-text note recorded in the event payload
  --as human:<id>  the deciding human; overrides APPROVAL_HUMAN
  --policy <path>  policy file to apply (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

HUMAN-ONLY. The actor must match human:<id>; an agent: or system: actor is
refused before anything is read or written, in this CLI and again in core and
again by the event schema. Identity is CONFIG-DECLARED (--as or APPROVAL_HUMAN)
and nothing here authenticates it — the trust boundary is the local machine.

${legality}

TTL: a decision after the request's TTL is refused with "expired", judged from
the request's OWN timestamp plus defaults.approval_ttl — whether or not an
approval.expired event has been observed. When the gate discovers a lapse it
first appends that approval.expired event (actor system:gate) and then refuses,
so the log records the state every reader can already derive.

${attestation}

${budgets}

Appends exactly one ${event} on success.

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"decision":"${verb}","state":"${verb === "grant" ? "granted" : verb === "reject" ? "rejected" : "revoked"}","action_key":"...","seq":5}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "verdicts"?:[...],"detail"?:"...","seq"?:N}}  on stderr

${GATE_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;
}

export const GRANT_HELP = decisionHelp("grant");
export const REJECT_HELP = decisionHelp("reject");
export const REVOKE_HELP = decisionHelp("revoke");

export const EXPIRE_HELP = `approval expire — lapse a request whose TTL has passed (system verb)

Usage:
  approval expire <action-key> [--policy <path>] [--dir <path>] [--log <path>]
                  [--json]

Flags:
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

Appends one approval.expired event with the actor system:gate. NO IDENTITY is
accepted or resolved: no human decides an expiry, the clock does, and SPEC.md §8
names expiry as the example of a system:-originated event. This is the verb the
daemon's sweep (a later milestone) calls; it exists in the CLI so the sweep is
testable and so an operator can run it by hand.

Refused when the request is not live (not-requested, already-decided) or when
the TTL has not lapsed (not-expired — which also covers a policy that declares
no defaults.approval_ttl: no TTL means no lapse, and expiring a request the
policy never bounded would be the runtime inventing a deadline).

defaults.on_expiry is recorded in the payload. Its only v0.1 value, "reject",
does not change the mechanics — an expired request is terminal either way — it
tells the projection layer to render the envelope state as rejected. Late
decisions are refused with "expired" whether or not this verb has ever run.

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","actor":"system:gate","seq":6}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
           on stderr

${GATE_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;

export const REINDEX_HELP = `approval reindex — rebuild the SQLite index from the log

Usage:
  approval reindex [--log <path>] [--index <path>] [--force] [--json]

Flags:
  --log <path>     log file to project (default .approval/log/events.jsonl)
  --index <path>   index file to write (default .approval/index.sqlite)
  --force          index the intact prefix of a torn-tail log
  --json           machine-readable output
  -h, --help       this text

The database is a cache; the log is the truth. The index is rebuilt from
scratch, built at a temporary path and renamed into place, so a crashed rebuild
leaves the previous index intact. Verification runs first: a corrupt log is
refused outright, and a torn tail is refused unless --force is given — and even
then only records 1..intactThroughSeq are indexed and the truncation is
recorded in the index metadata. The log itself is never repaired or written to.

${EXIT_CODES}
  reindex: 0 when the index was built; 1 when the log failed verification;
  3 on a torn tail without --force; 4 when a path could not be read or written.

JSON shape (stdout, one object):
  success  {"ok":true,"records":3,"head":{"seq":3,"hash":"<64 hex>"},
            "truncated":false}
  refusal  {"ok":false,"error":{"code":"not-clean"|"torn-tail"|"io",
            "message":"..."}}
  head is null for an empty log; truncated is true only for a forced torn tail.
${JSON_ERRORS}`;
