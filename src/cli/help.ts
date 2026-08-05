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
  approval token      <action-key> [--policy <path>] [--dir <path>] [--json]
  approval consume    <action-key> --token <t> [--payload-hash <64hex>]
                      [--as <id>] [--json]                            (internal)
  approval run        <action-key> [--token <t>] [--payload-hash <64hex>]
                      [--as <id>] [--json] -- <cmd…>
  approval execution resolve <action-key> --outcome completed|failed
                      --note "<text>" [--as human:<id>] [--json]
  approval wait       <task> --timeout <duration> [--interval <d>] [--json]
  approval queue      [--policy <path>] [--dir <path>] [--json]
  approval channel cli [--policy-dir <path>] [--payload-dir <path>]
                      [--as human:<id>] [--interactive] [--json]
  approval channel web [--port <n>] [--payload-dir <path>] [--as human:<id>]
                      [--policy <path>] [--dir <path>] [--log <path>] [--json]
  approval channel telegram listen|health [--once] [--as human:<id>] [--json]
  approval status     [--policy <path>] [--dir <path>] [--json]
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval render     [--log <path>] [--out <path>] [--policy <path>]
                      [--dir <path>] [--json]
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
  token     report whether a live single-use execution token exists for an
            action (the RAW token is printed once, by grant, and stored nowhere)
  consume   spend a token and append execution.started (internal plumbing;
            "approval run" wraps it)
  run       execute a command behind the gate: appends execution.started before
            spawning it, execution.completed/failed with the child's exit code
            after, and exits with that same code
  execution recovery verbs for executions the runtime could not close itself.
            "execution resolve" records the outcome a HUMAN OBSERVED for a
            dangling execution: mandatory --note, human-only, exit_code null,
            attested_by_human true. No attestation is required — resolve records
            a fact a human observed; it exercises no policy authority, so it
            does not require an attested policy
  wait      block until a task's requests are decided; the exit code IS the
            decision (0 granted, 1 rejected/revoked, 3 expired, 6 timeout)
  queue     the pending-decision INBOX: requests awaiting a human, inside their
            TTL. Nothing else — exit 0 always when the log could be read
  status    system HEALTH: attestation, dangling executions, budget headroom,
            the latest chain verdict, loop escalations. Exit 1 when any of
            those needs attention. queue is what a human must answer; status is
            what an operator must fix, and neither carries the other's content
  channel   put pending requests in front of a human over the channel contract.
            "channel cli" renders the queue with [computed]/[claimed] markers and
            the full payload in delimiters, and with a terminal collects
            decisions through the same human-only gate as grant/reject.
            "channel telegram listen" delivers the queue to a Telegram chat and
            long-polls for Approve/Reject taps; config is environment-only
            (APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT)
  reindex   rebuild the SQLite index projection from the log
  render    regenerate .approval/QUEUE.md, the READ-ONLY markdown queue
            projection (SPEC.md §9.1): pending requests and the sampled-audit
            backlog, computed and claimed fields visibly distinguished. The
            screenshot, never the truth — editing it authorizes nothing

Defaults:
  log    .approval/log/events.jsonl   (relative to the working directory)
  index  .approval/index.sqlite
  queue  .approval/QUEUE.md

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
answer is no. With --json, error.code names the refusal.

Two codes are ADDITIONS to the table above, each emitted by exactly one verb:
5 by "approval run" when no valid execution token was presented (nothing is
appended), and 6 by "approval wait" on timeout. Nothing in 0–4 changed meaning.`;

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
  loop-escalated          SPEC.md §10.2: three consecutive execution.failed
                          events escalated the task to manual, so its
                          supervised/autonomous actions may not proceed
                          unsupervised. Its MANUAL actions are unaffected; the
                          streak clears on an execution.completed.
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
  log-corrupt             the hash chain does not verify; nothing is authorized
                          from an unverifiable log (exit 1). Run
                          \`approval log verify\` for the detail.
  append-failed           the append itself failed; exit code follows the cause.
                          \`head-moved\` means the log grew between this command's
                          read and its write, so nothing was written.`;

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
${
  verb === "grant"
    ? `
TOKENS: a grant MINTS the single-use execution token for the action and PRINTS
IT ONCE — on stdout as "token: <64 hex>", or as the "token" key with --json. The
log records only its SHA-256 (payload token_sha256), so this print is the only
time the raw value exists outside the caller's memory and NOTHING can recover
it: not "approval token", not the log, not the index. Capture it, or revoke and
request again. Spend it with "approval run" (or the internal "approval consume").
`
    : ""
}
${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"decision":"${verb}","state":"${verb === "grant" ? "granted" : verb === "reject" ? "rejected" : "revoked"}","action_key":"...","seq":5${verb === "grant" ? `,\n            "token":"<64 hex>"}   (shown once; never recoverable)` : "}"}
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

/**
 * The token refusal codes, shared by `approval token` and `approval consume`.
 * Frozen public API in the same sense the gate's codes are: an agent branches on
 * `error.code` to decide whether to fix itself, stop retrying, or ask a human.
 */
const TOKEN_REFUSAL_CODES_HELP = `Refusal codes (error.code with --json; frozen public API):
  not-granted      no grant governs this action key — never requested, still
                   awaiting a decision, or rejected. Ask a human, do not retry.
  token-mismatch   a grant exists but the presented token is not its preimage
                   (or the grant predates tokens and carries no hash).
  token-consumed   already spent: an execution.started for this action key is in
                   the log. A token is single-use; retrying cannot help.
  token-expired    the PARENT REQUEST's TTL lapsed. There is no separate token
                   TTL — re-request the action.
  token-revoked    a human withdrew the grant (approval.revoked).
  log-unreadable   the log could not be read (exit 4).
  log-torn-tail    the log's final line is unterminated (exit 3).
  log-corrupt      the hash chain does not verify; no token is spendable from an
                   unverifiable log (exit 1). Run \`approval log verify\`.
  append-failed    the append itself failed; exit code follows the cause.
                   \`head-moved\` means another writer got there first — with one
                   token that is a refused double-spend, and nothing was written.`;

/**
 * The one design point everybody gets wrong on first reading, so it is printed
 * in both token-facing help texts.
 */
const TOKEN_SHOWN_ONCE = `THE RAW TOKEN IS SHOWN ONCE, BY "approval grant", AND IS RECOVERABLE FROM
NOTHING. The log records only its SHA-256 (approval.granted payload
token_sha256), which is the entire point: an exported, copied, audited log grants
its reader no power to execute. If the token is lost, revoke the grant and
request the action again.`;

export const TOKEN_HELP = `approval token — report the execution-token status of an action

Usage:
  approval token <action-key> [--policy <path>] [--dir <path>] [--log <path>]
                 [--json]

Flags:
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

${TOKEN_SHOWN_ONCE}

So this command does NOT print the token — it cannot, and no future version can
without storing the secret the design exists to avoid storing. It reports
whether a live, unspent token EXISTS for the action key, and prints its digest
so an operator can match it against the log. SPEC.md §10.1 lists "approval token
<action-key>  # print single-use execution token if granted"; the honest reading
under the settled hash-only design is that the token is printed BY grant and
that this verb reports status. (Flagged for human review.)

Exit 0 means: granted, unrevoked, unexpired, unconsumed — the token minted at
that grant is still spendable by whoever holds it. Every other answer is a
refusal at exit 1, naming which of the three deaths applied: execution
(token-consumed), revocation (token-revoked), or the parent request's TTL
(token-expired).

Writes nothing. Reads the log and the policy only.

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  live     {"ok":true,"action_key":"...","state":"granted","live":true,
            "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
            "est_cost_usd":0.02,"task":"task-042"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "seq"?:N}}  on stderr

${TOKEN_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;

export const CONSUME_HELP = `approval consume — spend an execution token (INTERNAL PLUMBING)

Usage:
  approval consume <action-key> --token <t> [--payload-hash <64hex>]
                   [--as <id>] [--policy <path>] [--dir <path>] [--log <path>]
                   [--json]

Flags:
  --token <t>      the raw token printed by "approval grant" (required)
  --payload-hash <64hex>
                   SHA-256 over the RFC 8785 canonical serialization of the
                   payload about to be executed. REQUIRED whenever the grant
                   bound to bytes, which under amended SPEC.md §6.2 is every
                   manual grant this runtime mints. A different hash — or none —
                   is refused payload-mismatch, nothing is appended, and the
                   token stays live: a grant approves specific bytes, and
                   changing the payload after grant requires a new request.
  --as <id>        the executing identity, human:<id> or agent:<id>;
                   defaults to APPROVAL_HUMAN
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

INTERNAL. This is the plumbing verb "approval run" (APRV-18) wraps; it exists in
the CLI so the token boundary is testable and so an adapter integration can be
driven by hand. Prefer "approval run -- <cmd…>", which mints, spends, executes
and records completion as one auditable unit.

Verifies the token and, only if it is live, appends ONE execution.started
carrying {"class","est_cost_usd","token_sha256"} — class and est_cost_usd copied
from the grant, per the consumption contract in core/budgets.ts. This is the
ONLY sanctioned appender of execution.started on the manual path: a manual
action's start event cannot exist without a verified token behind it.

Supervised and autonomous actions have no grant and therefore no token (amended
SPEC.md §6.3); this verb correctly refuses them with not-granted. Their
execution.started belongs to "approval run".

Budgets are NOT charged twice: the evaluator counts an execution.started only
when the window holds no approval.granted with the same action key, so a manual
action costs its window exactly one charge — the grant.

${TOKEN_SHOWN_ONCE}

${GATE_EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","event":"execution.started","seq":5,
            "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
            "est_cost_usd":0.02}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "seq"?:N}}  on stderr

${TOKEN_REFUSAL_CODES_HELP}
${JSON_ERRORS}`;

// ---------------------------------------------------------------------------
// The execution verbs (APRV-18): run, wait, status, queue
// ---------------------------------------------------------------------------

/**
 * The exit table plus the two APRV-18 additions.
 *
 * Additions, not redefinitions: 0–4 keep their meanings everywhere, and 5 and 6
 * are emitted by exactly one verb each. Both are printed in full wherever they
 * can occur, because an agent that has to guess an exit code guesses wrong on
 * the one invocation that mattered.
 */
const RUN_EXIT_CODES = `${EXIT_CODES}
  5  NO VALID EXECUTION TOKEN — "approval run" only (APRV-18 addition to the
     frozen table). The action's class resolves to manual and no usable token
     was presented. NOTHING was appended. Distinct from 1 because the repair is
     distinct: request the action, have a human grant it, and pass the token
     that grant printed once.`;

const WAIT_EXIT_CODES = `Exit codes (frozen public API) — for "approval wait" the code IS the decision
(SPEC.md §10.1: "exit code = decision"):
  0  success — every request of the task is granted (a task with no requests at
     all is granted vacuously: there was nothing to wait for)
  1  integrity failure (corrupt log) / here also: REJECTED or REVOKED — a human
     said no. Precedence: a human's no outranks a lapse.
  2  usage error
  3  torn tail / here also: EXPIRED — the TTL lapsed before a decision landed
  4  I/O error (unreadable/unwritable path; never reported as corruption)
  6  TIMEOUT — "approval wait" only (APRV-18 addition to the frozen table). The
     wait elapsed with request(s) still undecided. Nothing was appended, the
     request(s) are still live, and waiting again is legitimate.
  The overloading of 1 and 3 is deliberate: wait appends nothing and cannot fail
  a chain verification of its own, and --json names the outcome exactly
  (status: granted | rejected | expired | timeout) for callers that need more
  than a number. FLAGGED FOR HUMAN REVIEW.`;

export const RUN_HELP = `approval run — execute a command behind the gate

Usage:
  approval run <action-key> [--token <t>] [--payload-hash <64hex>] [--as <id>]
               [--policy <path>] [--dir <path>] [--log <path>] [--json]
               -- <cmd> [args…]

Flags:
  --token <t>      the raw token printed once by "approval grant". REQUIRED for
                   any action whose class resolves to manual (including one
                   forced there by SPEC §7's irreversibility floor).
  --payload-hash <64hex>
                   override the computed content binding. NORMALLY UNNECESSARY:
                   amended SPEC.md §6.2 defines run's payload as "the argv array
                   and cwd", and run hashes exactly that itself — an executor
                   that had to be TOLD what it was running could be told wrong.
                   The override exists for adapters whose real payload is
                   something else (a message body and its recipients, a proposed
                   record) and which wrap run rather than calling core.
  --as <id>        the executing identity, human:<id> or agent:<id>; defaults to
                   APPROVAL_HUMAN
  --policy <path>  policy file to apply (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable summary — ON STDERR, see below
  -h, --help       this text

Everything after the first "--" is the child's argv and is passed through
untouched, flags included.

What it does, in this order:
  1. appends execution.started — BEFORE the child is spawned, never after;
  2. spawns the command with inherited stdio (the child owns the terminal);
  3. appends execution.completed (child exit 0) or execution.failed (anything
     else), carrying payload.exit_code — the real number, unmapped;
  4. exits with THE CHILD'S EXIT CODE. run is transparent: a wrapper that
     swallowed the code would break every && and every CI step that wrapped it.

A child killed by a signal is recorded and reported as 128 + signal number
(SIGKILL 137, SIGTERM 143), the shell convention. A command that could not be
spawned at all is recorded as exit_code 127.

Authorization: manual actions spend a token (verified, single-use, bound to the
action key). Supervised and autonomous actions have no grant and no token
(amended SPEC.md §6.3) — for them run enforces, in order, attestation, SPEC.md
§10.2 loop escalation, single-use idempotency, and BUDGETS, which are charged
here because execution.started is their authorization record.

A CRASH BETWEEN started AND ITS OUTCOME leaves a DANGLING EXECUTION: the log
says truthfully that the action began and that nobody knows how it ended.
"approval status" reports it distinctly; "approval queue" does not (it is not a
pending decision). NOTHING REPAIRS IT AUTOMATICALLY — a second run for the same
key refuses rather than reconciling, because reconciliation would mean GUESSING
whether the side effect happened, and a guess in an append-only log is
indistinguishable from a fact. Recovery is a human recording the outcome they
actually observed:

  approval execution resolve <action-key> --outcome completed|failed \
                             --note "<what you saw>" [--as human:<id>]

which appends execution.completed or execution.failed with exit_code null and
attested_by_human true, so no reader mistakes an observation for a measurement.

CONTENT BINDING (amended SPEC.md §6.2, §10): run computes the hash of the argv
and cwd it is about to spawn and presents it when spending the token. If the
grant bound to different bytes the spend is refused payload-mismatch, nothing is
appended, and the token stays live. A grant approves specific bytes.

${RUN_EXIT_CODES}

JSON shape — ON STDERR, because stdout belongs to the child:
  success  {"ok":true,"action_key":"...","task":"...","class":"...",
            "autonomy":"manual","started_seq":5,"outcome":"execution.completed",
            "outcome_seq":6,"exit_code":0}
  refusal  {"ok":false,"error":{"code":"...","message":"...","detail"?:"...",
            "verdicts"?:[...],"seq"?:N,"event_seq"?:N}}

Refusal codes (error.code with --json; frozen public API):
  token-required        the class resolves to manual and no token was given.
                        Nothing was appended. EXIT 5.
  action-not-registered no task.registered record declares this action key.
  loop-escalated        SPEC.md §10.2: three consecutive execution.failed events
                        for the task escalated it to manual; its supervised or
                        autonomous actions may not start. Route it through a
                        human grant instead.
  policy-not-attested   policy unattested or its bytes changed (detail:
                        not-attested | hash-mismatch | unreadable).
  already-executed      an execution.started already exists for this key.
  budget-exceeded       budgets refused the start; a budget.exceeded event WAS
                        appended and error.verdicts lists the failures.
  not-granted           manual action with a token but no grant behind it.
  token-mismatch        the presented token is not the grant's preimage.
  token-consumed        the token was already spent — including by a dangling
                        execution, which run will NOT reconcile.
  token-expired         the parent request's TTL lapsed.
  token-revoked         a human withdrew the grant.
  not-started           (finish path) no execution.started to close.
  already-finished      (finish path) that execution already has an outcome.
  log-unreadable        the log could not be read (exit 4).
  log-torn-tail         the log's final line is unterminated (exit 3).
  log-corrupt           the hash chain does not verify; nothing executes from an
                        unverifiable log (exit 1). Run \`approval log verify\`.
  append-failed         the append itself failed; exit code follows the cause.
                        \`head-moved\` means the log grew between the checks and
                        the write; nothing was written and nothing is retried.
${JSON_ERRORS}`;

export const WAIT_HELP = `approval wait — block until a task's requests are decided

Usage:
  approval wait <task> --timeout <duration> [--interval <duration>]
                [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --timeout <d>    how long to wait, in the SPEC.md §5.2 duration grammar
                   (<positive integer><ms|s|m|h|d|w>), e.g. 6h. Required.
  --interval <d>   poll interval (default 500ms). Tuning for tests and
                   automation; the log is the only thing polled.
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

Polls the log until every approval.requested of the task has a decision, or the
timeout elapses. WRITES NOTHING — not even the approval.expired event it may
derive: expiry is judged lazily from the request's own timestamp (a decision is
refused past the TTL whether or not the event exists), and materialising it is
"approval expire"'s job, not a reader's.

Only the MANUAL path produces requests to wait for. A supervised or autonomous
action emits no approval.requested at all (amended SPEC.md §6.3), so waiting on
a task that has none returns immediately with exit 0 — there is no grant coming.

${WAIT_EXIT_CODES}

JSON shape (stdout, one object; timeout goes to stderr):
  decided  {"ok":true,"task":"task-042","status":"granted"|"rejected"|"expired",
            "actions":[{"action_key":"...","state":"granted","seq":4}]}
  timeout  {"ok":false,"task":"task-042","status":"timeout",
            "actions":[{"action_key":"...","state":"requested","seq":3}]}
  state is the per-action derived state; status is the whole task's outcome,
  with rejected/revoked outranking expired and expired outranking granted.
${JSON_ERRORS}`;

export const QUEUE_HELP = `approval queue — the pending-decision inbox

Usage:
  approval queue [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

Lists exactly the requests awaiting a human decision and inside their TTL:
action key, task, class, declared cost, when it was requested, and how much of
the TTL is left. Nothing else. THIS IS AN INBOX, NOT A DASHBOARD.

What it deliberately does NOT show — all of it lives in "approval status":
dangling executions, attestation state, budget headroom, chain verification,
loop escalations. A decided, expired, revoked or executed action leaves the
queue and does not come back; operational debris never enters it. An inbox that
accumulates things nobody can act on is an inbox that stops being read, and this
one is the whole mechanism by which a human's attention is spent.

Writes nothing. EXIT 0 ALWAYS when the log could be read — an empty inbox is a
healthy inbox, not an error. Only a filesystem fact (4) or a torn tail (3) can
produce anything else.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"pending":[{"action_key":"task-042:chaser","task":"task-042",
   "class":"communicate.email.external","est_cost_usd":0.02,
   "requested_ts":"2026-08-06T10:00:00.000Z","seq":3,
   "ttl_remaining_ms":3599000}]}
  pending is [] for an empty inbox. ttl_remaining_ms is null when the policy
  declares no defaults.approval_ttl (no TTL means no lapse).
${JSON_ERRORS}`;

export const STATUS_HELP = `approval status — system health, not the inbox

Usage:
  approval status [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --policy <path>  policy file whose bytes attestation is judged against
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

Reports, in one object:
  attestation      attested | hash-mismatch | not-attested | unreadable, with
                   the seq of the governing policy.updated record.
  verification     the latest chain verdict: clean | torn-tail | corrupt, and
                   the record count (null when corrupt — a corrupt log's count
                   is not a fact worth reporting).
  dangling         executions that STARTED AND NEVER FINISHED, each with its
                   action key, task, start timestamp and seq. This is the state
                   a crash between execution.started and its outcome leaves.
                   Nothing repairs it automatically; it clears only when a human
                   records the real outcome with "approval execution resolve",
                   which demands a mandatory note, a human actor, and records
                   exit_code null rather than inventing one. Recording an
                   outcome nobody observed is exactly the write this design
                   refuses to make casual.
  budgets          headroom per configured GLOBAL limit, from a ZERO-COST PROBE
                   evaluated now: the numbers are what the evaluator would say
                   about a hypothetical next action declaring $0. Consequently
                   remaining for daily_actions already has that one action
                   subtracted, because every authorization counts as one.
                   Class limits are absent by design — they need a matched rule,
                   and therefore a specific action, which status does not have.
  loop_escalations tasks with three consecutive execution.failed events, forced
                   to manual by SPEC.md §10.2 until an execution.completed lands.

THIS IS NOT "approval queue". queue is the pending-decision inbox — what a human
must answer. status is what an operator must fix. Neither shows the other's
content, and a dangling execution is the clearest case: it appears here, never
there, because nobody is being asked to decide it.

Writes nothing.

${EXIT_CODES}
  status: 0 when everything is healthy — policy attested, chain clean, no
  dangling execution, no loop escalation. 1 when ANY of those needs attention
  (including a torn tail: status reports health, while "approval log verify"
  remains the verb whose exit code distinguishes 3). 4 when the log path itself
  could not be read.

JSON shape (stdout, one object):
  {"ok":true,"healthy":false,
   "attestation":{"state":"attested","seq":1},
   "verification":{"status":"clean","records":6},
   "dangling":[{"action_key":"...","task":"...","ts":"...","seq":5}],
   "budgets":[{"limit":"global.daily_usd","scope":"global",
     "window":"rolling-24h","consumed":0.02,"requested":0,"remaining":9.98,
     "pass":true}],
   "loop_escalations":[{"task":"task-042","consecutive_failures":3,
     "escalated":true}]}
  ok is true whenever status ran; healthy is the verdict. attestation.seq is
  null for not-attested and unreadable.
${JSON_ERRORS}`;

export const EXECUTION_HELP = `approval execution — recovery verbs for executions the runtime could not close

Usage:
  approval execution resolve <action-key> --outcome completed|failed
                            --note "<text>" [--as human:<id>] [--log <path>]
                            [--json]

Subcommands:
  resolve   record the outcome a HUMAN OBSERVED for a dangling execution

A DANGLING EXECUTION is what a crash between execution.started and its outcome
leaves behind: the log says truthfully that the action began and that nobody
knows how it ended. "approval status" reports it; "approval queue" does not,
because nobody is being asked to decide anything. Nothing in this codebase
closes one automatically — an automatic reconciliation would have to GUESS
whether the email went out, and a guess written into an append-only log is
indistinguishable from a fact.

${EXIT_CODES}`;

export const RESOLVE_HELP = `approval execution resolve — record what a human observed

Usage:
  approval execution resolve <action-key> --outcome completed|failed
                            --note "<text>" [--as human:<id>] [--log <path>]
                            [--json]

Flags:
  --outcome <o>    completed or failed. REQUIRED, and nothing is inferred: the
                   runtime does not know how the execution ended, which is the
                   whole reason this verb exists.
  --note <text>    what you observed and how you know. MANDATORY and non-empty.
                   The event's entire value is the observation behind it; an
                   unexplained human-attested outcome cannot be told apart from
                   a guess.
  --as human:<id>  the person recording the observation; defaults to
                   APPROVAL_HUMAN. HUMAN-ONLY — an agent closing its own
                   dangling execution is the executing party reporting on
                   itself, which is the one thing the log exists not to accept.
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

What it appends: execution.completed or execution.failed, with payload
  {"note":"<text>","attested_by_human":true,"exit_code":null}

exit_code is NULL, not 0 and not 127. Nobody ran anything and there is no code
to report; a fabricated exit code would read exactly like an observed one.
attested_by_human marks the difference for every reader and every projection.

NO ATTESTATION IS REQUIRED. resolve records a fact a human observed; it
exercises no policy authority, so it does not require an attested policy. It
authorizes nothing, spends no budget, mints no token, and consumes nothing —
the commitment was charged at authorization time, long before the crash. A
dangling execution left unclosable because a policy file was edited afterwards
would be a repair blocked by an unrelated fact.

Refuses (exit 1) when there is nothing to close: not-started when the key has
no execution.started, already-finished when that execution already has an
outcome. Both leave the log untouched.

${EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","task":"...",
            "event":"execution.completed","outcome":"completed","seq":7,
            "attested_by_human":true,"actor":"human:carter"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
           on stderr
${JSON_ERRORS}`;

export const CHANNEL_HELP = `approval channel — put a pending request in front of a human

Usage:
  approval channel cli [--log <path>] [--policy-dir <path>] [--policy <path>]
                       [--payload-dir <path>] [--as human:<id>] [--interactive]
                       [--json]
  approval channel web [--port <n>] [--payload-dir <path>] [--as human:<id>]
                       [--policy <path>] [--dir <path>] [--log <path>] [--json]
  approval channel telegram listen|health [--once] [--as human:<id>] [--json]

Subcommands:
  cli        render the pending queue in this terminal and, when it IS a
             terminal, collect decisions with a prompt
  web        serve the pending queue as a page on 127.0.0.1 ONLY, with
             Grant/Reject forms and a batch gesture; see
             "approval channel web --help"
  telegram   deliver the queue to a Telegram chat (sendMessage + inline
             keyboard) and long-poll for Approve/Reject taps; see
             "approval channel telegram --help"

A channel is TRANSPORT. It renders what the runtime derived and reports the
gesture a human made; it decides nothing, holds no state, writes no log line and
never sees an execution token. Every decision collected here is recorded by the
same human-only gate "approval grant" and "approval reject" call, with every
rule — TTL, budgets, attestation, idempotency — applied unchanged.

${EXIT_CODES}`;

export const CHANNEL_CLI_HELP = `approval channel cli — the zero-config channel

Usage:
  approval channel cli [--log <path>] [--policy-dir <path>] [--policy <path>]
                       [--payload-dir <path>] [--as human:<id>] [--interactive]
                       [--json]

Flags:
  --log <path>         log file to read, and to append decisions to
  --policy-dir <path>  directory to discover APPROVAL.md / APPROVALS.md in
  --policy <path>      policy file (wins over --policy-dir)
  --payload-dir <path> directory of payload material, one JSON file per action
                       key: "<key>.json" or its percent-encoded name. The bytes
                       are hashed and checked against the request's recorded
                       payload_hash; material that does not match is REFUSED,
                       never rendered.
  --as human:<id>      the person deciding; defaults to APPROVAL_HUMAN. Required
                       only when a decision could be recorded.
  --interactive        prompt even though stdin is not a terminal (scripted
                       input, wrappers, tests)
  --json               machine-readable output; never interactive
  -h, --help           this text

THE RENDERING CONVENTION (SPEC.md §9). Every displayed field carries a marker in
the first column, and the marker is the whole point:

  [computed] class            communicate.email.external      (log)
  [claimed]  summary          chase invoice 41                (agent:drafter)

  [computed]  the RUNTIME derived it — from the verified log, the attested
              policy, the budget evaluator, the payload bytes, or arithmetic on
              the display instant. The parenthetical names which derivation.
  [claimed]   the PARTY UNDER OVERSIGHT wrote it. The parenthetical names the
              author. Claimed fields are indented under their own heading. A
              claim may raise your scrutiny; it is never evidence, and rendering
              one with the visual authority of a computed field is a conformance
              failure for a channel, not a styling preference.

THE FULL PAYLOAD (SPEC.md §10.4). For a manual action the exact bytes the
approval binds to are printed verbatim inside delimiters, never mixed with the
agent's summary:

  --- BEGIN FULL PAYLOAD (bound sha256 <64hex>) ---
  { … }
  --- END FULL PAYLOAD ---

The material comes from --payload-dir and is hash-checked against the recorded
binding before it is shown, so what is inside the delimiters is what the
execution token will spend. A manual request with no material is SKIPPED and
reported on stderr — visibly, because a request missing from a queue is a
request nobody will approve.

INTERACTIVE ONLY WITH A TERMINAL. With a TTY on stdin (or --interactive) each
pending request is rendered and answered: g) grant, r) reject, s) skip. A reject
DEMANDS a note and re-asks until it gets one; a grant's note is optional. A
grant prints its single-use execution token ONCE — the log stores only its
SHA-256 and nothing can recover it.

WITHOUT a TTY, and always with --json, the queue is printed and the command
EXITS 0 WITHOUT READING STDIN. It cannot hang a pipeline, and it records
nothing.

IDENTITY IS DECLARED, NOT PROVED. --as, else APPROVAL_HUMAN. The trust boundary
is the local machine: a decision recorded here proves that someone with local
control answered, not who. Missing or non-human identity on the deciding path is
a usage error (2), refused before anything is rendered.

${EXIT_CODES}
  1 is also a gate refusal surfaced from a decision (already-decided, expired,
  budget-exceeded, policy-not-attested, …). The command was well-formed; the
  runtime's answer was no. An empty queue is 0.

JSON shape (stdout, one object):
  {"ok":true,"channel":"cli","interactive":false,
   "pending":[{"action_key":{"kind":"computed","value":"task-042:chaser",
     "source":"log"},
     "summary":{"kind":"claimed","value":"chase invoice 41",
       "author":"agent:drafter"}, …}],
   "skipped":[{"action_key":"...","code":"payload-unavailable",
     "message":"..."}]}
  pending holds the TAGGED requests verbatim: every field keeps its
  kind/value/source|author markers, so a machine reader sees the same
  computed/claimed split a human does. pending is [] for an empty queue.`;

export const WEB_HELP = `approval channel web — the local queue page (127.0.0.1 ONLY)

Usage:
  approval channel web [--port <n>] [--log <path>] [--policy <path>]
                       [--dir <path>] [--payload-dir <path>] [--as human:<id>]
                       [--json]

Flags:
  --port <n>           port to bind. Precedence: --port > channels.web.port in
                       the policy > 4680. There is deliberately NO --host
  --log <path>         log file to read, and to append decisions to
  --policy <path>      policy file (wins over --dir)
  --dir <path>         directory to discover APPROVAL.md / APPROVALS.md in
  --payload-dir <path> directory of payload material, one JSON file per action
                       key: "<key>.json" or its percent-encoded name. The bytes
                       are hashed and checked against the request's recorded
                       payload_hash; material that does not match is REFUSED,
                       never rendered
  --as human:<id>      the person deciding; defaults to APPROVAL_HUMAN.
                       REQUIRED at startup — this page exists to record
                       decisions, so a server whose buttons could not record
                       one is refused before the socket is bound (exit 2)
  --json               print the listening/stopped lines as JSON objects
  -h, --help           this text

The command runs until interrupted (ctrl-c / SIGTERM). It is a PULL channel:
nothing is delivered anywhere, and the page is the notification surface. Open
it when you want to decide.

BINDS 127.0.0.1 AND NOTHING ELSE. The loopback host is hard-coded, and there is
no flag, option or environment variable that widens it. That is not an
oversight: this server has NO AUTHENTICATION, so the loopback interface IS the
access control. A --host 0.0.0.0 would turn "anyone with local access can
approve" into "anyone on this network can approve", from a flag that reads like
a convenience.

NO AUTH IN v0.1 — THE TRUST BOUNDARY (SPEC.md §11). This page authenticates
nobody. Every decision is recorded against the actor from --as / APPROVAL_HUMAN,
so what it proves is "someone with access to this machine answered", never "that
specific person answered". The same caveat is printed in a banner ON the page,
because the page is where the human is looking. CSRF: there is no token in v0.1
— there is no session to protect, and anything that can open a socket to the
port can POST directly. A best-effort same-origin check refuses clearly
cross-origin POSTs (403); it is a speed bump, not a control, and is flagged for
review in the source.

THE RENDERING CONVENTION (SPEC.md §9). Every field is marked [computed] (the
runtime derived it; the parenthetical names the derivation) or [claimed] (the
party under oversight wrote it; the parenthetical names the author). Claimed
fields sit in their own outlined section under a heading naming their author.
Every value — claimed fields and payload bytes especially — is HTML-escaped:
they are agent-authored, and they are this page's entire injection surface.

THE FULL PAYLOAD (SPEC.md §10.4). For a manual action the exact bytes are shown
verbatim in a delimited <pre> block labelled with the bound sha256, never mixed
with the agent's summary. Material comes from --payload-dir; a request whose
material is missing is SKIPPED and reported on stderr.

BATCHING (SPEC.md §10.3, B7). Tick requests and use "Grant selected" /
"Reject selected" for one gesture over the set. The log never batches: each
member gets its own approval.granted / approval.rejected carrying the batch's
delivery id. A selection that would hide one member's full payload behind
another is refused (batch-forbidden-mix) with nothing recorded. A reject needs
a note, batch or not, and the requirement is enforced on the server (422).

NO JAVASCRIPT REQUIRED. Every flow is a plain form post; the only script on the
page is a "select all" convenience.

THE EXECUTION TOKEN IS SHOWN ON THE PAGE, ONCE. A grant mints a single-use
token, and the response page displays it in a copy-me block. It is never
written to the log (which holds only its SHA-256), never put in a URL, and
never shown again — reload and it is gone. This differs from the Telegram
channel, which refuses to put a token in a chat: that transcript lives on
someone else's servers, this page is served over loopback to the person
deciding, right now, and is persisted nowhere.

${EXIT_CODES}
${JSON_ERRORS}

JSON shape (stdout, one object per line):
  {"event":"listening","channel":"web","url":"http://127.0.0.1:4680/",
   "host":"127.0.0.1","port":4680,"actor":"human:carter"}
  {"event":"stopped","notified":3,"views":7,"decisions":2,"refused":1}
  The token NEVER appears in this stream: --json output is the thing most
  likely to be piped into a file or a log aggregator.`;

export const RENDER_HELP = `approval render — regenerate .approval/QUEUE.md from the log

Usage:
  approval render [--log <path>] [--out <path>] [--policy <path>] [--dir <path>]
                  [--json]

Flags:
  --log <path>     log file to read (NEVER written by this command)
  --out <path>     queue file to write (default .approval/QUEUE.md)
  --policy <path>  policy file to resolve autonomy, budgets and the TTL from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --json           machine-readable output
  -h, --help       this text

Writes the queue projection of SPEC.md §9.1: a rendered, READ-ONLY markdown view
of the requests awaiting a human decision plus the sampled-audit backlog,
regenerated WHOLE on every run. "This is the screenshot; it is never the truth."
The file opens with a header saying so; editing it authorizes nothing and is
overwritten by the next render.

Every displayed field is visibly COMPUTED (derived by the runtime from the
verified log, the attested policy, or the payload binding — each line names the
derivation) or CLAIMED (authored by the requesting agent — a separate block that
names the author), per SPEC.md §9. Full payloads are deliberately NOT inlined:
the queue collects no decision, so it carries the content binding only and the
decision channels present the bytes, as SPEC.md §10.4 requires.

Deterministic: the evaluation instant is read once, here, and handed to the pure
renderer, so the same log rendered at the same instant produces the same bytes.
TTL countdowns are the only thing that moves between renders of an unchanged log.

Writes exactly one file, atomically (temp + rename), and only that file. A log
that does not verify refuses (exit 1) and writes nothing.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"out":"/abs/.approval/QUEUE.md","bytes":2481,
   "head":{"seq":7,"hash":"<64hex>"},"pending":2,"skipped":0,
   "audit_backlog":0,"now":"2026-08-06T10:00:00.000Z"}
  head is null for an empty log. skipped counts live requests the renderer could
  not summarize (they are listed in the file with their reason, never dropped).
  refusal  {"ok":false,"error":{"code":"log-corrupt|log-torn-tail|
            log-unreadable|write-failed","message":"..."}} on stderr
${JSON_ERRORS}`;

// ---------------------------------------------------------------------------
// Channels (APRV-26)
// ---------------------------------------------------------------------------

/**
 * The §11 caveat, verbatim in every channel help text.
 *
 * An operator wiring a bot to their approval log must be able to see the size
 * of the claim they are making before they wire it, without reading the source
 * or the spec.
 */
const CONFIG_DECLARED_IDENTITY = `Identity is CONFIG-DECLARED (SPEC.md §11). This channel does not authenticate
the person who taps a button: it checks that the callback came from the
configured chat, and records the decision against the human actor this process
was started with (--as / APPROVAL_HUMAN). The guarantee is "someone with access
to that chat, on a runtime configured by someone with local control, approved"
— NOT "that specific person approved". Anyone in the chat can approve as the
configured actor, so the chat's membership is part of your trust boundary. Use
a private chat with the bot. Cryptographic identity is future work.`;



export const TELEGRAM_HELP = `approval channel telegram — the Telegram push channel

Usage:
  approval channel telegram listen [--once] [--as human:<id>] [--payloads <f>]
                                   [--policy <path>] [--dir <path>]
                                   [--log <path>] [--api-base <url>]
                                   [--poll-timeout <seconds>] [--json]
  approval channel telegram health [--json]

Configuration is ENVIRONMENT-ONLY (SPEC.md §5.1): APPROVAL_TG_TOKEN holds the
bot token and APPROVAL_TG_CHAT the approver chat id. APPROVAL.md carries only
those variable NAMES — never a token, never a secret. There is no flag that
would put a bot token into a shell history or a process listing.

${CONFIG_DECLARED_IDENTITY}

${EXIT_CODES}
${JSON_ERRORS}`;

export const TELEGRAM_LISTEN_HELP = `approval channel telegram listen — deliver the queue, collect decisions

Usage:
  approval channel telegram listen [--once] [--as human:<id>] [--payloads <f>]
                                   [--policy <path>] [--dir <path>]
                                   [--log <path>] [--api-base <url>]
                                   [--poll-timeout <seconds>] [--json]

Flags:
  --once           process exactly one getUpdates batch, then exit (scripts,
                   tests, cron-style polling)
  --as human:<id>  the approver every decision is recorded against; defaults to
                   APPROVAL_HUMAN. REQUIRED — approvals are human-only
  --payloads <f>   JSON file mapping action key -> that action's payload value.
                   The log records only the payload HASH (SPEC.md §6.2), and
                   §10.4 requires the full payload to be presented for a manual
                   action, so the bytes are supplied here. They are re-hashed
                   and checked against the recorded binding; material that does
                   not match is refused, never rendered
  --policy <path>  policy file to resolve autonomy, budgets and TTL against
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file (read for the queue, appended to by decisions)
  --api-base <url> Bot API base (default https://api.telegram.org). For tests
                   against a local mock server
  --poll-timeout   getUpdates long-poll timeout in seconds (default 25)
  --json           machine-readable output: ONE JSON OBJECT PER LINE, not one
                   per invocation — a listener is a stream, not a query
  -h, --help       this text

On start it sends every pending manual request to the configured chat: the
computed fields (class, resolved autonomy, budgets, attestation, payload hash,
chain position, TTL) under one heading, the agent's CLAIMED fields (summary,
cost estimate, rationale) under another that says they are not verified, and
the full payload verbatim in its own block (SPEC.md §9, §10.4). Each message
carries an inline Approve/Reject keyboard.

Then it long-polls getUpdates. A callback FROM THE CONFIGURED CHAT is recorded
through the same human-only gate the CLI verbs use — TTL, budgets, attestation,
idempotency and compare-and-append all still apply. A callback from ANY OTHER
chat is ignored: counted as an anomaly, answered with a refusal, never turned
into a decision and NEVER written to the log. A second tap on an
already-decided request is refused already-decided by the gate: no second event
is appended and the toast says so.

Delivery bookkeeping is IN MEMORY ONLY (channels hold no state, §10.3). A
restarted listener re-sends everything still pending and the buttons on its
older messages stop resolving. Duplicated messages are the acceptable failure
mode; an approval that depended on a channel's memory would not be.

THE EXECUTION TOKEN IS PRINTED ON THIS TERMINAL'S STDOUT AND IS NEVER SENT TO
TELEGRAM. A chat transcript is stored on someone else's servers, backed up to
phones, and readable by anyone later added to the chat — it is not a credential
store. So the person who taps Approve on their phone does not receive the
token; the operator running this listener does.

REJECT COLLECTS NO REASON. An inline keyboard has no text input, so a rejection
is recorded with the note "rejected via telegram (callback <id>)". Use
"approval reject --note" when the reason matters. (A ForceReply flow is a
follow-up, flagged rather than silently dropped.)

BATCHING IS DEFERRED. §10.3 permits one gesture over a set; Telegram binds one
keyboard to one message, and a batch carrying every member's full payload would
exceed the 4096-character limit long before the keyboard helped. notify() still
accepts a batch and sends one message per member sharing one batch delivery id,
so every event carries it — the semantics are there, the one-tap ergonomics are
not.

Runs until interrupted (SIGINT/SIGTERM stop it cleanly) or, with --once, for a
single update batch. The loop SURVIVES THE NETWORK: a timeout, a dropped
socket, a 5xx or a non-JSON response is counted, complained about on stderr and
retried with a doubling backoff. It never stops listening quietly.

${CONFIG_DECLARED_IDENTITY}

${EXIT_CODES}

JSON shape (stdout, ONE OBJECT PER LINE):
  {"event":"notified","action_key":"task-042:chaser","delivery_id":"41"}
  {"event":"decision","action_key":"task-042:chaser","decision":"grant",
   "ok":true,"seq":7,"state":"granted","token_issued":true}
  {"event":"decision","action_key":"...","decision":"grant","ok":false,
   "code":"already-decided","token_issued":false}
  {"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
   "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
   "key-mismatch":0}}
  The raw execution token is NEVER in the JSON stream — that stream is the one
  most likely to be piped into a file. It is printed as plain text on stdout.
${JSON_ERRORS}`;

export const TELEGRAM_HEALTH_HELP = `approval channel telegram health — is this runtime configured for Telegram?

Usage:
  approval channel telegram health [--json]

Flags:
  --json     machine-readable output
  -h, --help this text

Reports whether APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT are set. Exit 0 when
both are, 1 when either is missing. The token's VALUE never appears in the
output — only whether it is present.

MAKES NO NETWORK CALL. A health check that contacted the Bot API would announce
the bot from any shell and would fail for reasons (a captive portal, a rate
limit) that say nothing about whether the configuration is right. The live
counters — deliveries, decisions, ignored callbacks, recovered poll errors —
belong to a RUNNING listener: they are on its stderr as they happen, in its
--json "stopped" line, and programmatically on TelegramChannel.health()/stats().

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"channel":"telegram","token_env":"APPROVAL_TG_TOKEN",
   "token_set":true,"chat_env":"APPROVAL_TG_CHAT","chat_id":"12345"}
${JSON_ERRORS}`;
