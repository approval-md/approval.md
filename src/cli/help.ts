/**
 * Help text. SPEC.md §10.1 makes `--help` part of the interface rather than a
 * courtesy: the CLI is how agents use this system, and an agent that has to
 * guess an exit code or a JSON key is an agent that will guess wrong on the one
 * invocation that mattered. Every command therefore documents its flags, the
 * full exit-code table, and its exact `--json` shape.
 */

import { GITIGNORE_ENTRY_LINES, GITIGNORE_MARKER } from "./scaffold.js";

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
  approval instructions [--schemas] [--json]
  approval init       [--dir <path>] [--json]
  approval policy check|test <class> [--reversible true|false] [--policy <path>] [--dir <path>] [--json]
  approval policy attest [--policy <path>] [--dir <path>] [--as human:<id>] [--json]
  approval policy amend  [--policy <path>] [--dir <path>] [--log <path>]
                      [--as human:<id>] [--require-load] [--dry-run] [--commit]
                      [--yes] [--json]
  approval register   <task-file> [--as <id>] [--log <path>] [--json]
  approval request    <task> --action <key> [--as <id>] [--json]
  approval grant|reject|revoke <action-key> [--note <text>] [--as human:<id>] [--json]
  approval expire     <action-key> [--json]
  approval token      <action-key> [--policy <path>] [--dir <path>] [--json]
  approval consume    <action-key> --token <t> [--payload-hash <64hex>]
                      [--as <id>] [--json]                            (internal)
  approval run        <action-key> [--token <t>] [--payload-hash <64hex>]
                      [--as <id>] [--json] -- <cmd…>
  approval adapter email <action-key> --token <t> --payload <file|->
                      [--as <id>] [--vault <path>] [--timeout <ms>] [--json]
  approval execution resolve <action-key> --outcome completed|failed
                      --note "<text>" [--as human:<id>] [--json]
  approval audit list|review [<seq|action-key>] [--note "<text>"]
                      [--as human:<id>] [--all] [--json]
  approval wait       <task> --timeout <duration> [--interval <d>] [--json]
  approval queue      [--policy <path>] [--dir <path>] [--json]
  approval channel cli [--policy-dir <path>] [--payload-dir <path>]
                      [--as human:<id>] [--interactive] [--json]
  approval channel web [--port <n>] [--payload-dir <path>] [--as human:<id>]
                      [--policy <path>] [--dir <path>] [--log <path>] [--json]
  approval channel telegram listen|health [--once] [--as human:<id>] [--json]
  approval daemon run [--tasks <dir>] [--out <path>] [--interval <duration>]
                      [--debounce <duration>] [--once] [--json]
  approval status     [--policy <path>] [--dir <path>] [--json]
  approval doctor     [--log <path>] [--policy <path>] [--dir <path>]
                      [--api-base <url>] [--json]
  approval payload hash <file|-> [--json]
  approval env        [--check] [--policy <path>] [--dir <path>] [--log <path>]
                      [--json]
  approval setup      identity|vault|sampling|channel <name>|adapter <name>
                      [--as human:<id>] [--api-base <url>] [--policy <path>]
                      [--dir <path>] [--log <path>]        (interactive; no --json)
  approval vault set <name> [--value-env <VAR>] [--as human:<id>] [--json]
  approval vault list|remove [<name>] [--as human:<id>] [--json]
  approval hook claude-code [--as agent:<id>] [--timeout <duration>]
                      [--interval <d>] [--policy <path>] [--dir <path>]
                      [--log <path>]                    (reads PreToolUse JSON)
  approval hook classify [--json] -- <command…>
  approval import agents-md <file> [--out <path>] [--json]
  approval mcp serve  --as agent:<id> [--dir <path>] [--log <path>]
                      [--policy <path>]              (MCP over stdio; foreground)
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval render     [--log <path>] [--out <path>] [--policy <path>]
                      [--dir <path>] [--json]
  approval --help

Commands:
  instructions
            the full AGENT-FACING usage guide: what to declare before acting,
            the register -> request -> wait -> run sequence, what a refusal
            means, and the invariants an agent must not route around. With
            --schemas it prints the verb registry as JSON — purpose, input and
            output schemas, exit codes and the human-only marker for every verb
            — which is the same source the optional MCP wrapper (SPEC.md §10.5)
            builds its tools from. Reads nothing, writes nothing
  init      scaffold a working directory: APPROVAL.md (SPEC.md §5.1's canonical
            policy, to be read and edited), the empty .approval/log/ directory,
            .approval/QUEUE.md in its empty state, and the .gitignore lines for
            the index, the vault, the environment source map and the
            atomic-write temp files. Appends
            nothing, attests nothing, overwrites nothing; a re-run writes
            nothing and reports what already exists
  log       inspect the append-only event log (verify | tail | export)
  policy    explain what APPROVAL.md does with an action class (check | test),
            record a human's sign-off on the policy file (attest), or run the
            whole amendment ceremony — semantic diff, load advisory,
            attestation, and the two-file git commit — as one verb (amend)
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
  adapter   execute an approved action through a side-effect adapter, the hard
            boundary of SPEC.md §10.4. "adapter email" sends one RFC 5322
            message over SMTP for a communicate.email.external action: the
            credentials come from the vault inside the verified-token window,
            the payload is the bytes the grant bound to, and the runtime — not
            the adapter — recomputes the hash, spends the token, and writes both
            execution events around the send
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
  doctor    is this ENVIRONMENT sane? build freshness, declared identity, policy
            attestation, chain health, the Telegram token, the web port — each
            with a concrete repair. status asks whether the SYSTEM needs
            attention; doctor asks whether the machine you are typing on can run
            the system at all. Appends nothing, sends nothing, repairs nothing
  channel   put pending requests in front of a human over the channel contract.
            "channel cli" renders the queue with [computed]/[claimed] markers and
            the full payload in delimiters, and with a terminal collects
            decisions through the same human-only gate as grant/reject.
            "channel telegram listen" delivers the queue to a Telegram chat on
            every poll cycle (including requests that arrive while it runs) and
            long-polls for Approve/Reject taps; config is environment-only
            (APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT)
  daemon    "daemon run" is the watch loop of SPEC.md §10.2, in the FOREGROUND:
            it records envelope.drift when a task file's state: contradicts the
            log, appends approval.expired for lapsed requests, writes the log's
            state back into the task files, regenerates QUEUE.md, and surfaces
            loop escalations. It holds no lock; backgrounding is the operator's
            business in v0.1
  payload   "payload hash" prints the payload_hash of a JSON document (SHA-256
            over its RFC 8785 canonical serialization), the value a declaration
            carries and a grant binds to. Most flows never need it: "request
            --payload" hashes, verifies and stores the bytes in one step
  audit     "audit list" is the open sampled-audit backlog and "audit review" is
            the HUMAN-ONLY verb that closes one item of it. Sampling itself has
            no verb: the daemon selects supervised actions with an operator-held
            secret, because a caller who could sample could also decline to
            sample itself
  env       resolve .approval/env — the environment SOURCE MAP — and print an
            export block for your shell to evaluate. THE ONLY VERB THAT READS
            THAT FILE: no command loads it implicitly, because human identity is
            one of the variables it carries and a working-tree file any process
            read on its own would let anything able to write it act as you. The
            default output carries secrets by design; "env --check" prints a
            table with no values on any path
  setup     the WRITER for that file: "setup identity|vault|sampling" and
            "setup channel <name>" store each secret in the OS keystore and
            record where it lives, and "setup adapter <name>" fills the VAULT
            from the credential manifest the adapter itself declares, then
            proves it against the service without sending anything. The two
            nouns are SPEC.md §4's: a channel holds no state and needs a
            transport credential, an adapter holds the credentials a side
            effect spends. INTERACTIVE ONLY — it refuses a
            non-terminal stdin and --json, and prints the exact commands to run
            instead, because a setup a pipe could drive would let a CI job
            declare a human identity. It appends nothing to the log, attests
            nothing, and never edits APPROVAL.md
  vault     the encrypted credential store adapters read from (SPEC.md §10.4).
            "vault set|list|remove" are HUMAN-ONLY; list shows NAMES and never
            values, and there is no "vault get" — a credential's only sanctioned
            journey is from .approval/vault.enc into an adapter, inside the
            verified-token window. The passphrase comes from the environment
            variable the policy NAMES (vault.passphrase_env), never from a flag
  hook      put the gate in front of an agent HARNESS. "hook claude-code" reads
            a Claude Code PreToolUse event on stdin, classifies the command it
            is about to run, resolves the class against APPROVAL.md, and answers
            allow or deny — waiting on a real approval decision when the class
            is manual. It never answers "ask": a decision taken outside the log
            is a decision nothing can audit. "hook classify" prints what the
            classifier makes of a command and touches nothing
  import    "import agents-md" parses an AGENTS.md-style permissions section
            into DRAFT policy classes for a human to confirm (SPEC.md §12). It
            prints; it never writes APPROVAL.md, never logs, never attests
  mcp       "mcp serve" is the optional MCP wrapper of SPEC.md §10.5: the same
            verbs as tools, over stdio, sharing the CLI's code paths. It is
            AGENT-FACING ONLY — grant, reject, revoke, attest, amend, vault,
            setup, audit review, expire, execution resolve and the channels are
            not published, because an MCP client is an agent's harness and
            SPEC.md §11 makes the agent the untrusted policy. It runs as ONE
            agent identity, fixed at startup, that no tool call can change
  reindex   rebuild the SQLite index projection from the log
  render    regenerate .approval/QUEUE.md, the READ-ONLY markdown queue
            projection (SPEC.md §9.1): pending requests and the sampled-audit
            backlog, computed and claimed fields visibly distinguished. The
            screenshot, never the truth — editing it authorizes nothing

Defaults:
  log    .approval/log/events.jsonl   (relative to the working directory)
  index  .approval/index.sqlite
  queue  .approval/QUEUE.md
  payloads .approval/payloads/<payload_hash>.json  (the bytes a request bound
           to, written by request --payload; read by render and every channel,
           and re-hashed on every read)
  env    .approval/env  (the environment SOURCE MAP: KEY=keychain:<service> /
         secret-service:<label> / env: / a plaintext literal. Mode 0600, and read
         by exactly one command, "approval env". GITIGNORED by init)
  vault  .approval/vault.enc  (AES-256-GCM over the named credentials; written
         only by "vault set|remove", read only by an adapter inside a verified
         token window. GITIGNORE IT — doctor fails if you have not)

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

export const INSTRUCTIONS_HELP = `approval instructions — the agent-facing usage guide (SPEC.md §10.1)

Usage:
  approval instructions [--json]
  approval instructions --schemas

Flags:
  --schemas    print the VERB REGISTRY as JSON instead of the guide: for every
               verb, its purpose, its input schema (positionals, flags, and the
               trailing argv where it takes one), its --json output schema, the
               shared error shape, its exit codes, and its human_only marker.
               Always JSON, with or without --json
  --json       print the guide as {"guide":"<text>","verbs":[…]}, the prose and
               the registry in one object
  -h, --help   this text

Prints what an agent needs to know before it acts: declare before you execute,
the register -> request -> wait -> run sequence, that supervised and autonomous
classes emit no approval event and must not be waited on, what a refusal means
and that it is FINAL until a human acts again, how to read the exit codes and
the --json error shapes, and the invariants that are enforced rather than
requested — never authoring the clock, never touching APPROVAL.md or the log or
the credentials, never reducing your own scrutiny by self-report.

The verb table at the end is GENERATED FROM THE REGISTRY, so a verb that exists
in the CLI and not in the guide is a test failure rather than a documentation
lapse. Verbs marked [HUMAN-ONLY] record or establish a human's authority: an
agent must not call them, and a wrapper must not publish them as tools.

ONE SOURCE FOR TWO SURFACES. SPEC.md §10.5's optional MCP server exposes the
same verbs as tools and shares the CLI's code paths, so it derives its tool
descriptions and input schemas from what --schemas prints here rather than from
a second list that would drift from this one.

Reads no log, resolves no policy, writes nothing. The output is a pure function
of this build, so --schemas is byte-stable across runs.

${EXIT_CODES}
  instructions uses only 0 and 2.
${JSON_ERRORS}`;

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

  "anomalies" is ADDITIVE and appears ONLY when there is something to report:
  [{"kind":"gate-ts-regression","seq":9,"ts":"...","event":"execution.started",
    "previousSeq":8,"previousTs":"...","skewMs":45000,"message":"..."}]
${JSON_ERRORS}

ANOMALIES DO NOT CHANGE THE VERDICT. SPEC.md §8 stamps the timestamps of
gate-typed events (approval.*, execution.*, budget.*, audit.*, policy.updated)
at the write boundary, so a backwards step of more than 2s between two of them
means either a clock that stepped backwards or a timestamp that was authored
rather than stamped. A CLEAN LOG WITH ANOMALIES IS CLEAN and still exits 0.
Chain integrity is a proof; skew is a judgment. Folding the judgment into the
proof would turn this verb into a check people learn to pass a flag to silence.

Human output: the status and head on stdout; reason, first bad seq, anomalies,
and the full message on stderr.`;

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
  approval policy amend  [--policy <path>] [--dir <path>] [--log <path>]
                         [--as human:<id>] [--require-load] [--dry-run]
                         [--commit] [--yes] [--json]

Subcommands:
  check   explain the autonomy resolution for <class>
  test    exact alias of check (SPEC.md §10.1 names both)
  attest  record a human's sign-off on the policy file's bytes (human-only;
          gate operations refuse while the live file is unattested or changed).
          Run "approval policy attest --help" — it is one of the two policy
          verbs that write to the log.
  amend   the whole amendment ceremony in one verb: semantic diff of the edited
          policy against the last-attested bytes, load advisory, attestation,
          and the two-file git add/commit that lands the edit and its
          attestation together. Run "approval policy amend --help".

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

export const POLICY_AMEND_HELP = `approval policy amend — the whole amendment ceremony, in one verb

Usage:
  approval policy amend [--policy <path>] [--dir <path>] [--log <path>]
                        [--as human:<id>] [--require-load] [--dry-run]
                        [--commit] [--branch <name> | --direct] [--yes] [--json]

Flags:
  --policy <path>  policy file to amend (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
                   (default: the working directory)
  --log <path>     log file to read and append to
                   (default .approval/log/events.jsonl)
  --as human:<id>  the human amending; overrides APPROVAL_HUMAN
  --require-load   REFUSE to attest a policy that does not load (exit 1,
                   nothing appended). Without it a load failure is a loud
                   advisory and the attestation may still proceed.
  --dry-run        print the whole report and write NOTHING — no attestation,
                   no commit, no prompt
  --commit         run the git ceremony instead of printing it
  --branch <name>  force the BRANCH flow and name the branch: commit on a new
                   branch, push it, and open a pull request carrying that one
                   commit (default name policy-amend-<seq>)
  --direct         force the DIRECT flow: commit on the branch you are standing
                   on, as this verb did before protected branches
  --yes            skip the interactive confirmation
  --json           machine-readable output
  -h, --help       this text

What it does, in this order:
  1. resolves the live policy file and hashes its bytes;
  2. compares that hash to the latest attestation. EQUAL means nothing to
     amend, reported on stdout at EXIT 0 — a no-op ceremony is a success;
  3. recovers the last-attested policy TEXT if it can (see BASELINE below) and
     prints the SEMANTIC diff: class resolutions that changed, approvers added
     or removed or re-channelled, defaults, and budget/class limits — all of it
     computed by the real engine on both versions, never re-derived here;
  4. runs the load advisory: "loads clean", or a loud notice naming the failure
     code and stating that the policy will fail closed to all-manual;
  5. asks for confirmation (skipped by --yes and --dry-run);
  6. attests — one policy.updated event, identical in every respect to
     "approval policy attest";
  7. prints, or with --commit runs, the git ceremony: "git add <policy> <log>"
     and a "git commit" whose message cites the attestation seq, plus the push
     (and, on the branch flow, the branch and the pull request).

BRANCH PROTECTION (the two flows). A protected default branch rejects the push
that would land the amendment, so this verb detects one and offers the flow that
works:
  DIRECT  git add + git commit on the branch you are standing on, then
          "git push origin <branch>".
  BRANCH  "git checkout -b <name>", the same one commit, "git push -u origin
          <name>", then "gh pr create" with a title naming the seq and a body
          stating the one-commit rule. MERGE THAT PR WITH A MERGE COMMIT, so the
          policy edit and its attestation stay one commit on main.

DETECTION runs "gh api repos/{owner}/{repo}/branches/<default>/protection":
exit 0 is protected, 404 is unprotected, and no gh / no GitHub remote / no
readable answer is UNKNOWN. It is read-only and it never fails the command: a
probe that could not answer leaves an attestation that already happened exactly
where it was.

PRECEDENCE, highest first:
  1. --branch <name>   the branch flow, with that name (--branch with --direct
                       is a usage error);
  2. --direct          the direct flow;
  3. detection         the branch flow when the default branch is protected AND
                       it is the branch currently checked out; otherwise the
                       direct flow. UNKNOWN is the direct flow.
When the direct flow is about to push a protected default branch (you passed
--direct, or you are standing on it), the report prints a one-line warning
BEFORE the push command rather than letting GitHub deliver the news.

BASELINE (a stated limitation, FLAGGED FOR HUMAN REVIEW): an attestation
records only the SHA-256 of the policy bytes, so the attested TEXT is NOT
recoverable from the log. When the policy lives in a git repository this verb
recovers HEAD:<path> and uses it as the baseline ONLY IF that blob's hash equals
the attested hash — proving the text being diffed is the text that was signed
for. Otherwise it drops to HASH-ONLY MODE: it says so loudly, the semantic diff
is unavailable, and only the load advisory and the attestation run. There is no
--baseline flag, because a baseline supplied by hand is a baseline nobody can
verify.

Human-only, with "approval policy attest"'s identity rules exactly: --as, else
APPROVAL_HUMAN, and an agent: or system: actor is refused before anything is
read or written. Identity is CONFIG-DECLARED and nothing here authenticates it.

CONFIRMATION: interactive y/N by default. With stdin not a terminal (or with
--json) and no --yes, the command REFUSES at exit 2 rather than assuming an
answer — pass --yes to confirm non-interactively, or --dry-run to see
everything without writing. Answering anything but y/yes aborts and writes
nothing.

--commit carries EXACTLY two files: the policy and the log. It refuses outside a
git repository, and refuses when the INDEX holds staged changes to anything
else — a commit that swept in an unrelated staged edit would make "this commit
is the amendment" false. On the branch flow it also refuses when there is no
"origin" remote to push to, and when a --branch name already exists (the
amendment branch is created fresh, so it carries exactly one commit). Every one
of those refusals happens BEFORE the attestation, so a refused --commit never
leaves an attested policy without its commit. Unstaged and untracked files
elsewhere are not touched. With gh absent, --commit on the branch flow still
branches, commits and pushes, and prints the "gh pr create" line for you.

${EXIT_CODES}
  policy amend: 0 when the amendment was recorded, when it was a no-op, when
  --dry-run reported, or when a human aborted at the prompt; 1 when
  --require-load refused a policy that does not load (nothing appended) or the
  log does not verify; 2 for usage — no human identity, an --as that is not
  human:<id>, a missing confirmation it could not ask for, or --commit
  preconditions; 3 for a torn tail; 4 for I/O.

JSON shape (stdout, one object; keys ALWAYS present):
  {"ok":true,"noop":false,"dryRun":false,"aborted":false,
   "policy":"/abs/APPROVAL.md","liveSha256":"<64 hex>",
   "attested":null|{"sha256":"<64 hex>","seq":2},
   "baseline":{"mode":"git-head"|"unavailable","reason":null|"..."},
   "diff":null|{"beforeFailure":null|{"code","message"},
                "afterFailure":null|{"code","message"},
                "structuralComparable":true,"probes":["..."],
                "classes":[{"class":"...","before":{"autonomy","provenance",
                  "pattern"},"after":{...}}],
                "approvers":[{"approver":"...","change":"added"|"removed"|
                  "channels-changed","beforeChannels":[...]|null,
                  "afterChannels":[...]|null,"danglingRules":["..."]}],
                "defaults":[{"field":"autonomy"|"channel"|"approval_ttl"|
                  "on_expiry","before":null|"...","after":null|"..."}],
                "budgets":[{"scope":"global"|"classes.<pattern>",
                  "limit":"daily_usd","before":null|N,"after":null|N}],
                "unchanged":false},
   "load":null|{"ok":true|false,"code":null|"...","message":null|"..."},
   "attestation":null|{"seq":3,"sha256":"<64 hex>"},
   "git":null|{"repo":true,
               "protection":"protected"|"unprotected"|"unknown",
               "protectionReason":"...","defaultBranch":null|"main",
               "currentBranch":null|"main","flow":"direct"|"branch",
               "branch":null|"policy-amend-7","warning":null|"...",
               "commands":["git add ...","git commit -m ...","git push ..."],
               "committed":false,"pushed":false,"prUrl":null|"https://...",
               "output":null|"..."}}
  diff is null in hash-only mode; attestation is null for a no-op, a dry run,
  and an abort. In a dry run the commands carry the literal placeholder <seq>,
  since the attestation that would supply the number has not happened. commands
  is the WHOLE ceremony for the chosen flow, in order.
  refusal  {"ok":false,"error":{"code":"...","message":"..."}}  on stderr

Refusal codes (error.code with --json; frozen public API):
  usage                 no identity, a non-human --as, an unknown flag, or a
                        confirmation that could not be asked for.
  io                    the policy file or the log could not be read/written.
  load-failed           --require-load and the policy does not load. NOTHING
                        was appended.
  commit-preconditions  --commit outside a git repository, with staged changes
                        beyond the policy and the log, or (branch flow) with no
                        origin remote or a --branch name already taken. Checked
                        BEFORE the attestation; nothing was appended.
  git-failed            the attestation WAS appended and git then failed
                        (checkout, add, commit or push); the message names the
                        seq and what to run by hand.
  pr-failed             the attestation was appended, committed and pushed, and
                        "gh pr create" then failed. Open the PR by hand and
                        merge it with a merge commit.
  append-failed         the attestation append itself failed.
  log-unreadable / log-torn-tail / log-corrupt
                        the log could not be read, ends in a torn line, or does
                        not verify. Nothing is amended from a log that does not
                        verify.
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
  envelope-missing        the file carries no approval: envelope AND the log
                          holds a task.registered for its task: the envelope was
                          LOST after registration (an external rewrite is the
                          observed cause). Nothing is appended, because
                          re-registering a stripped file would narrow the record
                          to what survives in it. Restore the block by hand from
                          the log; the runtime never rewrites a task file.
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
                   [--payload <file>|-] [--policy <path>] [--dir <path>]
                   [--log <path>] [--json]

Flags:
  --action <key>   the action's idempotency_key, as registered (required)
  --as <id>        who is requesting; human:<id> or agent:<id>, else APPROVAL_HUMAN
  --payload <file> the action's concrete payload, as JSON; - reads stdin. Its
                   hash must equal the declared payload_hash (payload-mismatch
                   otherwise) and it is filed in .approval/payloads/<hash>.json,
                   which is where render and every channel read the bytes from.
                   Supply it here once and no channel needs --payload-dir or
                   --payloads at all.
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
including SPEC §7's irreversibility floor, then — on the manual path only — the
content binding (payload-hash-required, payload-mismatch), request legality
(duplicate-request, already-executed), then budgets, then the payload store
write (payload-store-failed), then the append of approval.requested. A refused
request stores nothing.

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
                   the content binding, when the approved payload is CONTENT
                   rather than the command. By default run hashes what amended
                   SPEC.md §6.2 defines as its payload, "the argv array and cwd",
                   which is right whenever the command IS the action: an executor
                   that had to be TOLD what it was running could be told wrong.
                   Any action whose grant bound to content instead (an email
                   body, a record write, a message and its recipients) MUST pass
                   this flag with that content's hash, or the spend is refused
                   payload-mismatch. Get it from "approval payload hash <file>",
                   or keep the value recorded at request time.
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
  payload_store    whether .approval/payloads/ exists and how many payload files
                   it holds, with the warning it exists to keep in front of an
                   operator: the store holds the bytes approvals bind to, and it
                   is THE ONE CACHE THAT CANNOT BE REBUILT FROM THE LOG. QUEUE.md
                   regenerates and index.sqlite reindexes; the store does not,
                   because the log records the hash a request bound to and never
                   the material. Deleting it loses those bytes for good, and the
                   surviving binding makes the loss visible: every manual request
                   whose material went with it renders payload-unavailable.
                   INFORMATIONAL: it moves neither the health verdict nor the
                   exit code. An empty store is the normal state of a repo that
                   has never made a request carrying --payload. ("approval
                   doctor" is where an UNWRITABLE store is a failure.)
  anomalies        ADDITIVE and present only when non-empty: gate-typed events
                   whose ts steps backwards by more than 2s relative to the
                   previous gate-typed event (SPEC.md §8). INFORMATIONAL — it
                   moves neither the health verdict nor the exit code, because
                   "approval log verify" already declined to refuse on it and
                   status does not get to overrule that.

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
     "escalated":true}],
   "payload_store":{"present":true,"files":2,"note":"..."}}
  ok is true whenever status ran; healthy is the verdict. attestation.seq is
  null for not-attested and unreadable. payload_store is informational: it never
  moves healthy or the exit code, and note carries the unrebuildable warning
  verbatim.
${JSON_ERRORS}`;

export const DOCTOR_HELP = `approval doctor — environment sanity in one verb

Usage:
  approval doctor [--log <path>] [--policy <path>] [--dir <path>]
                  [--tasks <dir>] [--api-base <url>] [--json]

Flags:
  --log <path>       log file to verify (never written by this command)
  --policy <path>    policy file whose bytes attestation is judged against
  --dir <path>       directory to discover APPROVAL.md / APPROVALS.md in
  --tasks <dir>      task folder the envelope-integrity check reads
                     (default <--dir>/backlog/tasks, the daemon's default)
  --api-base <url>   Bot API base for the Telegram probe
                     (default https://api.telegram.org)
  --root <path>      TEST-ONLY: point the build-freshness check at another tree.
                     It moves no other check. Real invocations never pass it —
                     freshness is judged against the installation this binary
                     was loaded from, not against the working directory
  --json             machine-readable output
  -h, --help         this text

Eleven checks, in the order in which their failures cascade:

  build-freshness  dist/src/cli/main.js — the exact file the bin loader runs —
                   is present and NOT OLDER than the newest file under src/ or
                   tsconfig.json. Two shapes have their own message because
                   both were lost time in a real ceremony: a STALE BUILD, where
                   verbs that exist in the source are simply absent from the
                   binary; and an UNBUILT CHECKOUT, where cli.js exists with no
                   dist/ behind it and the checkout only looks installed. A
                   published install carries no src/, so freshness is
                   unanswerable there and the check SKIPS rather than passing.
  identity         APPROVAL_HUMAN names a human:<id>. Environment only, no --as:
                   this reports what the NEXT command will find.
  attestation      the live policy bytes match the latest policy.updated in the
                   log. Anything else — never attested, edited since, unreadable
                   — makes every gated operation refuse, and that refusal reads
                   like "the policy says no" when it means "the policy is
                   unverified".
  log              the hash chain verifies. A torn tail and a corrupt log are
                   both failures here; neither is repaired, and doctor never
                   truncates a torn line.
  telegram         getMe against --api-base, when the bot token and chat id
                   variables are both set; otherwise SKIP, because a runtime
                   driven by "channel cli" is healthy without Telegram. WHICH
                   variables those are comes from the policy this run resolved
                   (channels.telegram.token_env / chat_id_env), defaulting to
                   APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT, and the skip and
                   failure messages name the ones your policy asked for.
                   getMe AND NOTHING ELSE: never sendMessage, which would buzz a
                   human's phone for a diagnostic, and never getUpdates, whose
                   offset a running listener owns — a decision tap consumed here
                   would never reach the listener waiting for it. The token
                   value never appears in the output. ("channel telegram health"
                   remains the offline answer: it reports configuration and
                   makes no network call at all.)
  web-port         channels.web.port (default 4680) can be bound on 127.0.0.1.
                   A port already HELD is a PASS with a note — the likeliest
                   holder is this runtime's own "approval channel web", and a
                   doctor that cried broken at a working channel would train
                   people to ignore it. Only a bind error meaning the config
                   itself is wrong (EACCES on a privileged port) fails.
  payload-store    .approval/payloads/ can be written. The store holds the bytes
                   approvals bind to, keyed by their hash, and it is THE ONE
                   CACHE THAT CANNOT BE REBUILT FROM THE LOG: the log records
                   the binding, never the material, so a deleted payload is gone
                   and its manual request renders payload-unavailable. A store
                   that does not exist yet PASSES (it is created by the first
                   request carrying --payload); an existing directory this
                   process cannot write FAILS, because a request already
                   accepted by the gate would refuse payload-store-failed mid
                   ceremony. The probe creates and removes one empty file and
                   reads no payload.
  audit-sampling   whether the supervised-action sampler is actually running.
                   Sampling FAILS OPEN by design (SPEC.md §5.2), so an
                   unconfigured sampler silently audits nothing; this states the
                   disabled reason out loud. A sampler nobody configured (no
                   rate, or rate 0) SKIPS; a half-configured one (a rate with no
                   secret, an unset secret variable, an unloadable policy) FAILS,
                   because someone intended sampling and is not getting it. The
                   secret value is never printed.
  envelope-integrity
                   every task file whose task the LOG registered still carries
                   an approval: envelope. The loss this names was observed live
                   (APRV-60): a task-file rewrite by a tool that did not know
                   the key simply dropped it, and nothing refused. FAILS with
                   the task ids and the seq of each registration; the fix is a
                   human restoring the block from the log. NOTHING HERE REWRITES
                   A TASK FILE: the log holds the actions, and re-emitting the
                   envelope from it would turn a projection into a source. SKIPS
                   when there is no task folder.
  vault            .approval/vault.enc, when there is one. THE GITIGNORE CHECK
                   RUNS FIRST, because a vault about to be committed is the
                   worse fault and stays wrong after every other problem is
                   fixed; the fix is the exact line to add. Then the passphrase
                   variable the policy names must be set, and the file must
                   actually decrypt under it — a wrong passphrase and an altered
                   file are reported as one verdict on purpose, since telling
                   them apart would confirm a guessed passphrase against a file
                   someone had modified. PASSES naming the credential COUNT and
                   never a name or a value. SKIPS when there is no vault, with
                   the note that adapters needing credentials will refuse until
                   one exists.
  environment      whether the variables your POLICY NAMES will be there when a
                   verb needs them, and what .approval/env (the source map,
                   SPEC.md §5.2) says about where each one comes from. Every
                   other check reports on one variable at the moment it needs
                   it; this one states the environment as a whole. It resolves
                   exactly what "approval env --check" resolves, so the two
                   cannot disagree, WITH ONE DELIBERATE DIFFERENCE: a
                   keychain:/secret-service: source is reported as DECLARED and
                   is NOT looked up, because "security find-generic-password -w"
                   and "secret-tool lookup" can block on a keychain-unlock or
                   ACL prompt, and a diagnostic must never hang or ask a human
                   for a password. Run "approval env --check" to resolve them.
                   PASSES when every named variable is set here, resolved, or
                   declared against a keystore. FAILS on a mode other than 0600
                   (with the chmod), an unreadable or unparseable file, a
                   secret-bearing variable written into the file as a PLAINTEXT
                   literal, an env file a "git add -A" would commit (with the
                   exact ignore line), or a declared source that refused for a
                   real reason. SKIPS, naming them, when the only thing true is
                   that some variables are unset — unset is a state, like an
                   absent vault, and the checks that know a variable is REQUIRED
                   (identity, vault, audit-sampling) fail on it themselves.
                   VALUE-FREE BY CONSTRUCTION: this check reads each variable's
                   status and source and never its value, on any path.

EVERY FIX BEGINS WITH A COMMAND. A "fix:" line opens with something you can
paste — approval …, chmod …, echo …, export …, mv …, node …, npm … — and the
prose explaining it comes after. An operator scanning a failed run is looking
for the next thing to type, and a line that opens with "check that…" makes them
read a sentence to find out there is nothing to type. Nothing in that list
deletes or commits: doctor repairs nothing, and a fix that told you to rm or to
git commit would be making the decision this project keeps human.

APPENDS NOTHING. Not an event, not a marker. An operator reaching for a
diagnostic while the log is in a state they do not understand must not have that
state changed by looking at it. Nothing here writes, sends, or repairs; every
failure carries a fix the human runs themselves.

THIS IS NOT "approval status". status reports the health of the SYSTEM recorded
in the log — attestation, dangling executions, budgets, escalations. doctor
reports whether this MACHINE can run the system: the right build, a declared
identity, a reachable channel. A stale binary is invisible to status and is
exactly what doctor exists to name.

${EXIT_CODES}
  doctor: 0 when every check passed or skipped, 1 when ANY failed. 4 only when
  doctor itself could not look — the installation root would not stat for a
  reason other than "not there". An unreadable log or policy is NOT that: those
  are environment facts, which is what this command reports, so they are check
  failures at 1.

JSON shape (stdout, one object):
  {"ok":false,"checks":[
    {"check":"build-freshness","status":"pass","detail":"..."},
    {"check":"identity","status":"fail","detail":"...","fix":"..."},
    {"check":"attestation","status":"pass","detail":"..."},
    {"check":"log","status":"pass","detail":"..."},
    {"check":"telegram","status":"skip","detail":"..."},
    {"check":"web-port","status":"pass","detail":"..."},
    {"check":"payload-store","status":"pass","detail":"..."},
    {"check":"audit-sampling","status":"skip","detail":"..."},
    {"check":"envelope-integrity","status":"pass","detail":"..."},
    {"check":"vault","status":"skip","detail":"..."},
    {"check":"environment","status":"skip","detail":"..."}]}
  status is "pass" | "fail" | "skip". fix is present only when there is
  something to do, and it always begins with a runnable command. ok is true when
  no check failed — a skip does not make it false. The eleven checks always
  appear, in this order.
${JSON_ERRORS}`;

export const AUDIT_HELP = `approval audit — the retrospective review of sampled supervised actions

Usage:
  approval audit list   [--all] [--log <path>] [--json]
  approval audit review <seq|action-key> [--note "<text>"] [--as human:<id>]
                        [--log <path>] [--json]

Subcommands:
  list      the open sampled-audit backlog: audit.sampled with no audit.reviewed
  review    record that a HUMAN looked at one sampled action

SUPERVISED actions execute immediately and are audited AFTERWARDS. The daemon
samples a fraction of them (audit.supervised_sample_rate) into a backlog a
person works through; SPEC.md §12 calls the human's attention the audit budget,
and this is where it is spent retrospectively rather than before the fact.

THERE IS NO "approval audit sample". Selection is the runtime's, derived as
HMAC-SHA-256 over the event hash with an operator-held secret named by
audit.sampling_secret_env and kept outside this repository. A verb that let a
caller sample — or decline to sample — an action of its choosing would hand the
party under oversight the control that exists to oversee it. Seeding from event
content alone is forbidden by SPEC.md §5.2 for the same reason: the agent
authoring the event controls that content and could search it until its action
falls outside the sample.

If no secret is configured, SAMPLING IS OFF and this backlog stays empty.
"approval audit list" reports that beside the backlog, because an empty backlog
means one thing when sampling is running and quite another when it is not.
Sampling is retrospective, so an unconfigured sampler costs review coverage and
authorizes nothing: nothing is gated on it and no budget is spent by it.

${EXIT_CODES}`;

export const AUDIT_LIST_HELP = `approval audit list — the open sampled-audit backlog

Usage:
  approval audit list [--all] [--policy <path>] [--dir <path>] [--log <path>]
                      [--json]

Flags:
  --all           include samples that have already been reviewed
  --policy <path> policy file, for reporting whether sampling is on
  --dir <path>    directory to discover the policy in (default: cwd)
  --log <path>    log file to read
  --json          machine-readable output
  -h, --help      this text

Reads a VERIFIED log and writes nothing. The same set .approval/QUEUE.md renders
and the same set the daemon counts as audit_backlog, from the same projection,
so the file, the daemon and this verb cannot disagree.

A review closes a sample only when it comes AFTER it in the chain and names the
same action. An earlier audit.reviewed is a review of an EARLIER sample, and
treating it as covering this one would silently empty the backlog — which is
exactly the failure a sampled-audit backlog exists to prevent.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,
   "sampling":{"enabled":false,"rate":0.1,"secret_env":"APPROVAL_SAMPLE_SECRET",
               "reason":"secret-unset"},
   "open":2,
   "samples":[{"seq":9,"ts":"...","action_key":"...","task":"...",
               "subject_seq":7,"reviewed_seq":null}]}

sampling.reason is null when sampling is running, and otherwise one of
policy-unreadable, rate-absent, rate-zero, rate-invalid, secret-env-unnamed,
secret-unset. The SECRET ITSELF is never printed, never logged, and never
returned by any code path — sampling.secret_env is the variable's NAME, which
the policy file already carries in the open.
${JSON_ERRORS}`;

export const AUDIT_REVIEW_HELP = `approval audit review — record that a human reviewed a sample

Usage:
  approval audit review <seq|action-key> [--note "<text>"] [--as human:<id>]
                        [--log <path>] [--json]

Arguments:
  <seq|action-key> a bare integer is the SEQ OF THE audit.sampled RECORD; any
                   other value is an action key with exactly one open sample.
                   An action key with several open samples refuses
                   ambiguous-subject: a review that could mean either would
                   close the wrong item.

Flags:
  --note <text> what you concluded. OPTIONAL — unlike "execution resolve", this
                event records only that a person looked, and the runtime is not
                relying on the note for a fact it does not otherwise have.
  --as human:<id>  the reviewer; defaults to APPROVAL_HUMAN. HUMAN-ONLY: a
                runtime that could mark its own samples reviewed would be a
                supervision backlog that empties itself.
  --log <path>  log file to read and append to
  --json        machine-readable output
  -h, --help    this text

What it appends: audit.reviewed, naming the sample's action key and task, with
payload {"subject_seq":<seq of the audit.sampled>,"reviewed":true,"note"?:"..."}

NO ATTESTATION IS REQUIRED, for the reason "execution resolve" states: review
records an observation, exercises no policy authority, authorizes nothing, and
spends no budget. A review blocked because a policy file was edited afterwards
would be a supervision backlog held open by an unrelated fact.

Refuses (exit 1): not-sampled when nothing matches, already-reviewed when the
sample is closed, ambiguous-subject when an action key names several open
samples, actor-not-human when the actor is not human:<id>. All leave the log
untouched.

${EXIT_CODES}

JSON shape (stdout, one object):
  success  {"ok":true,"seq":11,"sample_seq":9,"action_key":"...","task":"...",
            "actor":"human:alice"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
           on stderr
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
            "attested_by_human":true,"actor":"human:alice"}
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
  --payload-dir <path> OPTIONAL OVERRIDE. Payload material for keys this
                       operator holds outside the store: one JSON file per
                       action key, "<key>.json" or its percent-encoded name.
                       Unset, the bytes come from .approval/payloads/, where
                       approval request --payload filed them. Either way they
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

The material comes from the payload store (.approval/payloads/, written by
approval request --payload) or from --payload-dir, and is hash-checked against
the recorded binding before it is shown, so what is inside the delimiters is what the
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
  --payload-dir <path> OPTIONAL OVERRIDE. Payload material for keys this
                       operator holds outside the store: one JSON file per
                       action key, "<key>.json" or its percent-encoded name.
                       Unset, the bytes come from .approval/payloads/. Either
                       way they are hashed and checked against the request's
                       recorded payload_hash; material that does not match is
                       REFUSED, never rendered
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
with the agent's summary. Material comes from the payload store, or from
--payload-dir where it overrides; a request whose material nobody holds is
SKIPPED and reported on stderr.

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
   "host":"127.0.0.1","port":4680,"actor":"human:alice"}
  {"event":"stopped","notified":3,"views":7,"decisions":2,"refused":1}
  The token NEVER appears in this stream: --json output is the thing most
  likely to be piped into a file or a log aggregator.`;

export const INIT_HELP = `approval init — scaffold a working directory (SPEC.md §10.1)

Usage:
  approval init [--dir <path>] [--json]

Writes four things into <dir> (default: the working directory):
  APPROVAL.md         SPEC.md §5.1's canonical policy, verbatim. A STARTING
                      POINT, not your policy: read every class before you sign
                      for it
  .approval/log/      the log DIRECTORY, empty. "approval policy attest" is what
                      creates events.jsonl, because a log entry nobody signed is
                      not evidence of anything
  .approval/QUEUE.md  the read-only queue projection in its empty state, written
                      by the same renderer "approval render" uses
  .gitignore          three lines merged under a "${GITIGNORE_MARKER}" marker:
                      ${GITIGNORE_ENTRY_LINES}

Flags:
  --dir <path>   directory to scaffold (default: the working directory)
  --json         machine-readable output
  -h, --help     this text

IT APPENDS NOTHING AND ATTESTS NOTHING. init holds no authority: the policy it
writes authorizes nothing until a human reads it and attests it.

IT NEVER OVERWRITES. init plans every target before writing any of them, then
writes only what is missing and reports the rest in "existing" with a per-file
code (policy-exists, log-dir-exists, queue-exists, gitignore-entries-present).
A re-run in a scaffolded directory therefore writes nothing and exits 0. An
existing APPROVAL.md or QUEUE.md is never modified; .gitignore is the one file
that is merged, append-only, and no existing line is rewritten or removed.
A directory carrying APPROVALS.md (the SPEC.md §5 fallback filename) already has
a policy: init reports policy-exists and writes no APPROVAL.md beside it.

Payloads are TRACKED. .approval/payloads/ is deliberately NOT ignored: those
bytes are what each approval bound to, and evidence belongs in the history. To
ignore them instead, add ".approval/payloads/" yourself — the log keeps every
payload_hash, but the bytes behind them stop being rebuildable.

A path of the WRONG KIND is a refusal, not a report: a directory named
APPROVAL.md, or a regular file where .approval/ belongs, exits 4 with
error.code "path-conflict" and NOTHING is written.

${EXIT_CODES}

JSON shape (one object on stdout):
  {"ok":true,"dir","written":["APPROVAL.md",...],
   "existing":[{"path","code"}],"next_steps":["…"]}
${JSON_ERRORS}`;

export const HOOK_HELP = `approval hook — put the gate in front of an agent harness

Usage:
  approval hook claude-code [--as agent:<id>] [--timeout <duration>]
                            [--interval <duration>] [--policy <path>]
                            [--dir <path>] [--log <path>]
  approval hook classify [--json] -- <command…>

Commands:
  claude-code  read one Claude Code PreToolUse event as JSON on STDIN and print
               the harness's decision object on stdout. Bash commands are
               classified into SPEC.md §7 action classes; Edit/Write/MultiEdit/
               NotebookEdit are gated only when the file is policy-protected
               (APPROVAL.md, .approval/, CLAUDE.md, AGENTS.md, .claude/settings*,
               .github/workflows/, .npmrc); every other tool passes through
  classify     print what the classifier makes of a command line and exit. Reads
               no log, resolves no policy, writes nothing. Put the command after
               "--" so its own flags are not parsed as this verb's

Flags (claude-code):
  --as <id>        the proposing identity (default agent:claude-code)
  --timeout <d>    how long to wait for a decision (default 55s). Set it BELOW
                   the hook timeout configured in .claude/settings.json
  --interval <d>   poll interval while waiting (default 1s)
  --policy <path>  policy file to resolve classes against
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in — point
                   it at the PRIMARY checkout, whose log the daemon writes
  --log <path>     log file (default .approval/log/events.jsonl under --dir's
                   sibling working directory rules)
  -h, --help       this text

What it decides:
  autonomous class   allow, and NOTHING is appended (amended SPEC.md §6.3)
  supervised class   allow, after registering the task; no approval event exists
  manual class       register + request, then WAIT for a human decision. Allow
                     on granted; deny on rejected, revoked, expired or timeout
  gate.self          the "approval" CLI itself is pass-through: it is the
                     enforcement path, and gating it with itself would deadlock

Deny reasons (the reason string is "<code>: <detail>"):
  hook-unclassified       no rule covers some segment of the command
  hook-opaque             a construct whose effect cannot be read from the text
                          (bash -c, eval, backticks, a non-read substitution)
  hook-unparseable        the command line could not be tokenized
  hook-rejected           a human said no
  hook-revoked            a granted approval was withdrawn
  hook-expired            the TTL lapsed before a decision
  hook-timeout            no decision inside --timeout; the request stays live
  hook-gate-refused:<c>   the gate refused intake; <c> is its own frozen code
                          (policy-not-attested, budget-exceeded, …)
  hook-policy-unavailable APPROVAL.md could not be loaded, so nothing resolves
  hook-io                 malformed hook input, or an unreadable log

EXIT 0 CARRIES THE VERDICT. Claude Code reads stdout as a decision only on exit
0, treats exit 2 as a block with stderr as the reason, and treats any other code
as a non-blocking error. So allow and deny are both exit 0 with JSON on stdout,
and exit 2 is reserved for a MISCONFIGURED hook (unknown flag, bad identity),
where blocking is the right failure mode. No new exit code is defined here.

THE VERDICT IS NEVER "ask". The harness's own prompt would collect a decision
that no event records, no channel delivered, and no audit can reconstruct.

The classifier is BEST EFFORT and is not scheming-robust (SPEC.md §11). It reads
the command text and nothing else — never the agent's own "description" field,
which is self-reported. The hard boundary remains the vault and the execution
token (SPEC.md §10.4). See docs/claude-code-hook.md for the settings.json entry,
which a HUMAN commits: it is policy.edit.

${EXIT_CODES}
  claude-code uses only 0 and 2, as above.`;

export const IMPORT_HELP = `approval import — turn existing permissions prose into a draft policy

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Commands:
  agents-md parse an AGENTS.md-style permissions section ("allowed without
            prompting" / "require approval first" / "never") into draft policy
            classes for a human to confirm (SPEC.md §12)

${EXIT_CODES}
${JSON_ERRORS}`;

export const IMPORT_AGENTS_MD_HELP = `approval import agents-md — permissions prose -> draft policy classes

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Reads one markdown file, finds its permissions section, and prints a DRAFT
\`\`\`yaml approval-policy block. SPEC.md §2: AGENTS.md permissions lists are
instructions an agent is trusted to obey and nothing checks. This verb is the
first step in making one checkable.

Flags:
  --out <path>     write the draft YAML (without the fence) to <path> instead of
                   printing it. REFUSES to overwrite an existing file
  --json           machine-readable output
  -h, --help       this text

THE DRAFT AUTHORIZES NOTHING. This verb never writes APPROVAL.md, never appends
to the log, never attests, and consults no attestation. Review the draft, paste
it into APPROVAL.md, and run "approval policy amend" — that ceremony, run by a
human, is what puts a policy in force.

What it recognises:
  region         a heading containing "permissions", at any level (or the three
                 sub-headings on their own, the bare AGENTS.md layout)
  allowed        "allowed without prompting" / "allowed" / "autonomous"
  approval-first "require approval first" / "requires approval" / "ask first" /
                 "approval required"
  never          "never" / "forbidden" / "prohibited"
  bullets        "- " / "* " list items under those headings; a wrapped
                 continuation line is joined to its bullet

How bullets become classes:
  A FIXED, ORDERED KEYWORD TABLE, first match wins — no model is consulted, and
  the same bytes always produce the same draft. Order (precedence):
  account.credential, vcs.history.rewrite, policy.edit, vcs.push, vcs.push.main,
  release.publish, network.call, deps.add, data.delete, vcs.commit.branch,
  exec.local, files.write.workspace, read.*. Every mapping carries its source
  bullet as a "# from:" comment so the human can check the guess.

Fail closed:
  - a bullet the table cannot place is NOT guessed at: it is preserved verbatim
    as a comment, listed under UNMAPPED, and covered by defaults.autonomy
    (manual)
  - v0.1 has no forbid level, so "never" bullets are rendered manual with a
    "# never:" comment. Manual is not never; read those lines
  - the same class claimed by two sections resolves to the STRICTER autonomy
    (SPEC.md §5.2, deny beats allow) and both bullets are named in a warning
  - unrecognised headings inside the permissions area are reported (stderr, or
    "ignored" with --json), never silently skipped
  - a file with no permissions section is exit 0 with an empty draft and a
    warning: a draft of nothing is a correct answer, not an error

No approvers and no channels are generated: a machine must not name who may
approve. The draft carries defaults (manual, 24h, reject) and classes only.

--json prints:
  {"ok":true,
   "source":"<path as given>",
   "out":"<path>"|null,
   "classes":[{"class","autonomy","from","section"}],
   "unmapped":[{"text","section"}],
   "ignored":["<heading>"],
   "warnings":["<text>"]}
"from" is the bullet that DECIDED the autonomy (the stricter one on a conflict);
the draft YAML comments list every bullet that mapped to the class.

${EXIT_CODES}
${JSON_ERRORS}`;

export const PAYLOAD_HELP = `approval payload — work with the bytes an approval binds to

Usage:
  approval payload hash <file|-> [--json]

Commands:
  hash      print the payload_hash of a JSON document: SHA-256 over its RFC 8785
            canonical serialization (SPEC.md §6.2)

${EXIT_CODES}
${JSON_ERRORS}`;

export const PAYLOAD_HASH_HELP = `approval payload hash — the content binding for a payload

Usage:
  approval payload hash <file|-> [--json]

Reads one JSON document from <file>, or from stdin when the argument is "-",
and prints its payload_hash: SHA-256 (lowercase hex) over the RFC 8785 (JCS)
canonical serialization of the parsed VALUE. Canonicalization first is what makes
the hash reproducible across implementations that agree about the payload but not
about key order, whitespace or number formatting.

Flags:
  --json           machine-readable output
  -h, --help       this text

This is the same function the runtime uses, so the printed hash is byte-identical
to the one a request and its grant record.

Where the hash goes:
  payload_hash     in a task file's action declaration, and on the
                   approval.requested / approval.granted events in the log
  approval request --payload <file>|-
                   supplies the concrete bytes; the runtime hashes them, refuses
                   payload-mismatch if they are not what was declared, and files
                   them in .approval/payloads/<hash>.json for render and every
                   channel to display
  approval run --payload-hash <64hex>
                   presents the binding when spending a token, for an action
                   whose payload is content rather than the command itself

MOST FLOWS NEVER NEED THIS VERB: "approval request --payload" both stores and
verifies the bytes, so the hash is computed where the payload already is. Reach
for "payload hash" when writing the declared payload_hash into a task file in the
first place, or when an adapter must present a binding for material this runtime
does not hold.

Bytes that do not parse as JSON are a usage error (exit 2), not a hash: the
binding is defined over the canonical VALUE, so non-JSON input has no defined
payload_hash and printing one would invent a binding no other implementation
could reproduce. Empty input is exit 2 for the same reason. A file that exists
but cannot be read is exit 4.

Reads no log, writes no file, appends nothing.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"hash":"<64hex>"}
${JSON_ERRORS}`;

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
  --payloads <f>   OPTIONAL OVERRIDE. JSON file mapping action key -> that
                   action's payload value. The log records only the payload HASH
                   (SPEC.md §6.2) and §10.4 requires the full payload for a
                   manual action, so the bytes come from .approval/payloads/ —
                   filed by approval request --payload — unless this flag
                   supplies them instead. Either way they are re-hashed and
                   checked against the recorded binding; material that does not
                   match is refused, never rendered
  --policy <path>  policy file to resolve autonomy, budgets and TTL against —
                   and the NAMES of the credential variables (below)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file (read for the queue, appended to by decisions)
  --api-base <url> Bot API base (default https://api.telegram.org). For tests
                   against a local mock server
  --poll-timeout   getUpdates long-poll timeout in seconds (default 25)
  --json           machine-readable output: ONE JSON OBJECT PER LINE, not one
                   per invocation — a listener is a stream, not a query
  -h, --help       this text

THE BOT TOKEN AND CHAT ID COME FROM THE ENVIRONMENT, AND THE POLICY NAMES THE
VARIABLES. channels.telegram.token_env and channels.telegram.chat_id_env carry
variable NAMES, never values (SPEC.md §5.1); a policy declaring neither gets
APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT, and so does a policy that fails to load
— a variable name is not a permission. There is no flag for either value: a bot
token on a command line is a bot token in the shell history and in "ps".

It sends every pending manual request to the configured chat: the
computed fields (class, resolved autonomy, budgets, attestation, payload hash,
chain position, TTL) under one heading, the agent's CLAIMED fields (summary,
cost estimate, rationale) under another that says they are not verified, and
the full payload verbatim in its own block (SPEC.md §9, §10.4). Each message
carries an inline Approve/Reject keyboard.

DELIVERY IS PER CYCLE, NOT ONLY AT STARTUP. Before every getUpdates the
listener re-derives the pending queue from the verified log and sends whatever
it has not already sent, so a request appended while this listener is running
reaches the phone on the next cycle without a restart. Decided and TTL-lapsed
requests fall out of that derivation and are never sent. A send that fails
leaves the request undelivered and is retried on every later cycle, with no
attempt limit — an unreachable Bot API must not turn into a pending request
nobody sees — though the stderr warnings thin out after a few consecutive
failures for the same request. A failure during the STARTUP send still exits
non-zero, so a mistyped token or chat id is immediate.

It long-polls getUpdates. A callback FROM THE CONFIGURED CHAT is recorded
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
  approval channel telegram health [--policy <path>] [--dir <path>] [--json]

Flags:
  --policy <path>  policy file naming the credential variables
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --json           machine-readable output
  -h, --help       this text

Reports whether the bot token and chat id variables are set. Exit 0 when both
are, 1 when either is missing. The token's VALUE never appears in the output —
only whether it is present.

WHICH VARIABLES ARE READ COMES FROM THE POLICY: channels.telegram.token_env and
channels.telegram.chat_id_env hold variable NAMES (SPEC.md §5.1), defaulting to
APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT when a policy declares neither or fails
to load. The names this run resolved are reported in both output forms, so a
renamed variable reads back as the name you set.

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

// ---------------------------------------------------------------------------
// The daemon (APRV-39)
// ---------------------------------------------------------------------------

export const DAEMON_HELP = `approval daemon — the watch loop of SPEC.md §10.2

Usage:
  approval daemon run [--log <path>] [--tasks <dir>] [--out <path>]
                      [--policy <path>] [--dir <path>] [--interval <duration>]
                      [--debounce <duration>] [--once] [--json]

Subcommands:
  run   watch the task folder and the log; record envelope drift, expire lapsed
        requests, regenerate QUEUE.md, and surface loop escalations

${EXIT_CODES}
${JSON_ERRORS}`;

export const DAEMON_RUN_HELP = `approval daemon run — watch, expire, re-render (FOREGROUND)

Usage:
  approval daemon run [--log <path>] [--tasks <dir>] [--out <path>]
                      [--policy <path>] [--dir <path>] [--interval <duration>]
                      [--debounce <duration>] [--once] [--json]

Flags:
  --log <path>        log file to read and append to (.approval/log/events.jsonl)
  --tasks <dir>       task folder to watch (default backlog/tasks). Named
                      explicitly and missing is an error; absent by default is a
                      warning and the daemon runs log-only
  --out <path>        queue file to regenerate (default .approval/QUEUE.md)
  --policy <path>     policy file to read the TTL and autonomy from
  --dir <path>        directory to discover APPROVAL.md / APPROVALS.md in
  --interval <d>      how often to tick with no watcher event (default 30s)
  --debounce <d>      how long a burst of file events settles first (default 250ms)
  --once              run exactly ONE tick and exit; the cron-shaped invocation
  --git-evidence      OPT-IN second evidence layer: commit the log and its
                      payload store to the log home's OWN git repository after
                      every tick that moved the head (SPEC.md §8). Off by
                      default. Requires a standalone log deployment
  --json              machine-readable output, one JSON object per line
  -h, --help          this text

RUNS IN THE FOREGROUND and stops on SIGINT/SIGTERM. It does not fork, write a
pidfile, or manage its own lifecycle: in v0.1 backgrounding is the operator's
business, and systemd, launchd, tmux and & all do it better than a bespoke
daemonizer would. A clean stop exits 0 — a signal is how this verb is meant to
end — and leaves no lockfile and no half-written queue.

Each tick, in order:

  ENVELOPE DRIFT (§6.3) — every task file is read and its approval: envelope
    validated. When the file's state: contradicts the state the log implies, an
    envelope.drift event is appended (actor system:daemon) naming both.
    Identical drift is recorded once — the same claim against the same log is not
    appended again until the file or the log changes.
  TTL SWEEP — every live request whose TTL lapsed gets an approval.expired
    (actor system:gate, through the same "approval expire" the CLI calls). The
    gate ALREADY refuses a late grant whether or not this event exists; the sweep
    makes the lapse visible rather than changing any verdict. Idempotent with
    lazy expiry, with itself, and across restarts, because the candidate list is
    re-derived from the verified log every sweep and nothing is remembered.
  WRITE-BACK (§6.3) — every task file whose state: still disagrees with the log
    is rewritten to match it, AFTER the events above are appended and never
    before: the log is the truth and the file is its projection. Exactly the
    state: line changes; every other byte, key, comment and line ending is
    preserved. A file with no approval: envelope is never given one, and a file
    the writer cannot round-trip safely is left untouched with a
    write-back-refused warning. So a drift record marks a file found wrong AND
    fixed; a file that keeps drifting is one another writer is fighting over.
  LOOP ESCALATION (§10.2) — tasks with three consecutive execution.failed are
    reported when they escalate and when they clear. The gate and the executor
    enforce it; this only surfaces it, and "approval status" reports the same set.
  QUEUE (§9.1) — .approval/QUEUE.md is regenerated through the same renderer
    "approval render" uses, written temp-then-renamed so a reader never sees a
    partial file.

WATCHING IS A LATENCY OPTIMIZATION, NEVER A CORRECTNESS DEPENDENCY. fs.watch is
bursty and platform-dependent, so every tick re-scans the folder and re-derives
everything from the verified log, and the periodic tick runs whether or not any
watcher ever fired. A daemon whose watchers failed to attach is slower, not
wrong; it says so in its first line.

SINGLE WRITER, IN INTENT ONLY. While it runs the daemon is meant to be the only
writer, but the CLI verbs stay appendable: core's advisory lockfile serializes
the writes, and every append here carries the head it decided against, so a
concurrent CLI append refuses the daemon's write rather than corrupting it. The
daemon tolerates that by RE-READING — the next tick re-derives the whole question
from the log as it now is. It holds no lock of its own.

A log that does not verify STOPS the daemon rather than degrading it: nothing may
be appended onto a chain that does not verify, and a projection of one would be a
screenshot of something nobody should read.

GIT EVIDENCE (--git-evidence, OFF BY DEFAULT). SPEC.md §8's optional hardening: a
second, independent record of the same bytes, one an operator can clone and diff
from somewhere the tamperer does not control. When enabled the daemon commits the
log file and the payload store to the log home's own repository after each tick
that moved the head, with a message naming the head's seq and hash, authored as
itself ("approvald <version>", fixed noreply address, never your git identity and
never written to your git config). It NEVER pushes, fetches, or names a branch,
and a git failure is a warning, not a stop.

  THE LOG HOME MUST BE ITS OWN REPOSITORY ROOT, and must not sit inside any outer
  working tree. Enabling in a nested layout — a project repository that also
  tracks .approval/, which is how this project dogfoods itself — is REFUSED, with
  the code log-dir-nested. A hash chain does not survive a merge (two branches
  appending independently produce a corrupt chain by construction), and an outer
  repository's rebases, amends and force-pushes rewrite the bytes the evidence is
  made of. The nested layout stays fully valid WITHOUT the flag; the two patterns
  do not mix. See docs/git-evidence.md.

  Refusals at startup: git-unavailable and log-dir-missing exit 4;
  log-dir-not-repo and log-dir-nested exit 2. Nothing is appended either way.

${EXIT_CODES}
  A clean stop is 0. 4 when the log cannot be read, 3 when its tail is torn, 1
  when the chain does not verify.

JSON shape (stdout, ONE OBJECT PER LINE):
  {"event":"started","log":".approval/log/events.jsonl","tasks":"backlog/tasks",
   "queue":".approval/QUEUE.md","interval_ms":30000,"debounce_ms":250,
   "watching":true}
  {"event":"drift","task":"task-042","file":"backlog/tasks/task-042.md",
   "declared_state":"approved","derived_state":"awaiting","seq":9}
  {"event":"expired","action_key":"task-042:chaser","task":"task-042","seq":10}
  {"event":"rendered","path":".approval/QUEUE.md","bytes":2481,"pending":1,
   "skipped":0,"audit_backlog":0}
  {"event":"escalated","task":"task-042","consecutive_failures":3}
  {"event":"escalation_cleared","task":"task-042"}
  {"event":"tick","n":1,"head":10,"drift":1,"expired":1,"escalated":0}
  {"event":"stopped","reason":"SIGINT","ticks":3,"drift":1,"expired":1,
   "renders":3}
  warnings go to STDERR as {"event":"warning","code":"...","message":"..."},
  with code one of task-unreadable, frontmatter-invalid, envelope-invalid,
  task-id-missing, tasks-dir-unreadable, append-refused, expire-refused,
  render-failed, watch-unavailable, prune-refused. A warning never stops the
  loop.
  payload retention (APRV-41): with payload_retention set in policy, each tick
  appends payload.pruned and THEN removes the payload file for every payload
  whose action has been terminal longer than the duration, and for orphaned
  store files. With the key absent nothing is ever pruned.
  "rendered" is emitted when the queue's summary CHANGES; the file itself is
  rewritten every tick, because TTL countdowns move even when the log does not.
  With --git-evidence, one further line per committing tick:
  {"event":"git_evidence","commit":"a1b2c3d","seq":10,
   "hash":"<sha256 of the head record>","records":2}
  and, on a git failure, {"event":"git_evidence_failed","step":"commit",
  "message":"..."} on STDERR. Neither ever stops the loop.
${JSON_ERRORS}`;

// ---------------------------------------------------------------------------
// The vault (APRV-68)
// ---------------------------------------------------------------------------

const VAULT_NO_GET = `THERE IS NO "approval vault get", and it is not an oversight. A verb that
printed a credential would put it in a terminal, a scrollback buffer, a CI log
and — through the shell that ran it — a history file. A credential's only
sanctioned journey is from the vault into an adapter, inside the verified-token
window the adapter contract holds open (SPEC.md §10.4: "the credentials only
answer to tokens"). Names are visible; values are not.`;

const VAULT_THREAT_MODEL = `What the vault DEFENDS: credentials at rest, and casual reads by an agent that
can read files in the working tree — the ciphertext hides the NAMES as well as
the values.
What it does NOT defend (SPEC.md §11, plainly): a compromised host, and an agent
that can read the passphrase variable. That agent does not need this CLI; it can
decrypt the file itself. Keep the passphrase in an operator-held environment and
outside every agent-readable path.`;

export const VAULT_HELP = `approval vault — the encrypted credential store adapters read from

Usage:
  approval vault set <name> [--value-env <VAR>] [--vault <path>] [--log <path>]
                    [--policy <path>] [--dir <path>] [--as human:<id>] [--json]
  approval vault list   [--vault <path>] [--log <path>] [--as human:<id>] [--json]
  approval vault remove <name> [--vault <path>] [--log <path>]
                    [--as human:<id>] [--json]

Subcommands:
  set     store a credential (value from STDIN or --value-env; never a flag),
          creating .approval/vault.enc if it does not exist
  list    the NAMES the vault holds, the count, and the file path. Never values
  remove  delete one credential by name

ALL THREE ARE HUMAN-ONLY: the actor must match human:<id>, from --as or
APPROVAL_HUMAN, exactly as "policy attest" requires. Identity is declared, not
proved (SPEC.md §11: the trust boundary is the local machine); the check is what
stops an agent's tooling from storing or deleting a credential in passing.

The file is AES-256-GCM over a JSON map of name -> credential, under a key
derived by scrypt (N=16384, r=8, p=1, 32-byte key) from a passphrase read from
the environment variable named by the policy's vault.passphrase_env (default
APPROVAL_VAULT_PASSPHRASE). The policy carries the variable NAME and never the
value, the same convention as channels.telegram.token_env and
audit.sampling_secret_env. There is no --passphrase flag.

APPENDS NOTHING TO THE LOG. A credential's existence is configuration, not an
authorized action, and a log line naming the credentials an operator holds would
be a map of the machine's reach written into the one file this project promises
never to rewrite.

${VAULT_NO_GET}

${VAULT_THREAT_MODEL}

${EXIT_CODES}
  vault: 1 for anything the runtime decided (wrong passphrase, altered file, a
  name the vault does not hold), 4 for filesystem failures, 2 for usage —
  including a missing human identity and a missing passphrase variable.
${JSON_ERRORS}`;

export const VAULT_SET_HELP = `approval vault set — store one credential (HUMAN-ONLY)

Usage:
  approval vault set <name> [--value-env <VAR>] [--vault <path>] [--log <path>]
                    [--policy <path>] [--dir <path>] [--as human:<id>] [--json]

Flags:
  --value-env <VAR>  read the value from this environment variable
  --vault <path>     the vault file (default: <log home>/vault.enc)
  --log <path>       log file the vault path is derived from
  --policy <path>    policy file to read vault.passphrase_env from
  --dir <path>       directory to discover APPROVAL.md / APPROVALS.md in
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

THE VALUE IS NEVER A COMMAND-LINE ARGUMENT. There is no --value flag, because a
secret on a command line is a secret in the shell history and in "ps" output for
the length of the call. The value comes from STDIN:

  pass show smtp/app | approval vault set smtp-password
  approval vault set api-key <<'EOF'
  sk-live-…
  EOF

or from a variable named with --value-env:

  APPROVAL_TMP_SECRET="$(op read op://vault/item/field)" \\
    approval vault set api-key --value-env APPROVAL_TMP_SECRET

One trailing newline is stripped from stdin and nothing else: interior
whitespace is preserved, because some tokens legitimately contain it and a
silently trimmed credential fails at the far end with no local evidence of why.
An empty value is refused rather than stored.

Creates the vault when there is none. Every write re-encrypts the WHOLE map
under a FRESH nonce and lands atomically (temp file at mode 0600, then rename),
so an interrupted write leaves the previous vault intact and two writes of the
same value never produce the same bytes on disk.

${VAULT_NO_GET}

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"name":"smtp-password","created":true,"count":2,
   "path":"/…/.approval/vault.enc"}
  created is false when the name was already present and has been replaced. The
  VALUE appears in no field, on either the success or the failure path.
${JSON_ERRORS}`;

export const VAULT_LIST_HELP = `approval vault list — the names in the vault (HUMAN-ONLY)

Usage:
  approval vault list [--vault <path>] [--log <path>] [--policy <path>]
                      [--dir <path>] [--as human:<id>] [--json]

Flags:
  --vault <path>     the vault file (default: <log home>/vault.enc)
  --log <path>       log file the vault path is derived from
  --policy <path>    policy file to read vault.passphrase_env from
  --dir <path>       directory to discover APPROVAL.md / APPROVALS.md in
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

Prints the credential NAMES, sorted, with a count and the file path. No value is
printed on any path, including the failure paths.

A VAULT NOBODY CREATED IS A STATE, NOT A FAULT: when the file does not exist
this says so and exits 0. A runtime driven by "approval run" and the CLI channel
never needs a credential, exactly as a runtime with no Telegram configuration is
healthy without one. The passphrase is not read in that case, so an absent vault
reports absent rather than complaining about an unset variable.

A wrong passphrase and an altered file both refuse "vault-unreadable" and are
NOT distinguished: a runtime that told you which would let someone confirm a
guessed passphrase against a file they had modified.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"present":true,"path":"/…/.approval/vault.enc","count":2,
   "names":["api-key","smtp-password"]}
  and, for a vault that does not exist,
  {"ok":true,"present":false,"path":"…","count":0,"names":[]}
${JSON_ERRORS}`;

export const VAULT_REMOVE_HELP = `approval vault remove — delete one credential (HUMAN-ONLY)

Usage:
  approval vault remove <name> [--vault <path>] [--log <path>]
                        [--policy <path>] [--dir <path>] [--as human:<id>]
                        [--json]

Flags:
  --vault <path>     the vault file (default: <log home>/vault.enc)
  --log <path>       log file the vault path is derived from
  --policy <path>    policy file to read vault.passphrase_env from
  --dir <path>       directory to discover APPROVAL.md / APPROVALS.md in
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

A name the vault does not hold refuses "credential-absent" (exit 1) rather than
reporting success: an operator removing a credential wants to know whether they
removed the one they meant. The remaining credentials are re-encrypted under a
fresh nonce and written atomically.

Removing a credential an adapter still needs makes that adapter refuse
credential-unavailable at execution time. Nothing here checks for that, because
the check would require this verb to know every adapter a machine might run.

${EXIT_CODES}

JSON shape (stdout, one object):
  {"ok":true,"name":"api-key","count":1,"path":"/…/.approval/vault.enc"}
${JSON_ERRORS}`;

export const ADAPTER_HELP = `approval adapter — execute an approved action through a side-effect adapter

Usage:
  approval adapter email <action-key> --token <t> --payload <file|->
                      [--as human:<id>|agent:<id>] [--vault <path>]
                      [--policy <path>] [--dir <path>] [--log <path>]
                      [--timeout <ms>] [--json]

Adapters:
  email   send one RFC 5322 message over SMTP, for actions declared under
          communicate.email.external (SPEC.md §6.1's canonical example)

An adapter is the HARD BOUNDARY of SPEC.md §10.4: it holds the credentials and
refuses to act without a valid, unexpired, single-use execution token bound to
the action's idempotency_key AND its payload_hash. An agent that bypasses this
CLI still cannot send, because the credentials only answer to tokens.

The runtime, not the adapter, owns the sequence: recompute the payload hash,
verify and consume the token, append execution.started, call the adapter, append
execution.completed or execution.failed. The adapter implements one method and
cannot skip a step, because it never holds the sequence.

${EXIT_CODES}
  adapter: 5 when no valid token was presented (nothing was appended and nothing
  was sent), 1 for everything else the runtime decided — including a payload
  that is not the approved bytes (payload-mismatch), a spent token
  (token-consumed), a misrouted class (adapter-class-mismatch), and a send the
  far side refused (adapter-failed, with the SMTP reply code in adapter_code).
${JSON_ERRORS}`;

export const ADAPTER_EMAIL_HELP = `approval adapter email — send one approved message over SMTP

Usage:
  approval adapter email <action-key> --token <t> --payload <file|->
                      [--as human:<id>|agent:<id>] [--vault <path>]
                      [--policy <path>] [--dir <path>] [--log <path>]
                      [--timeout <ms>] [--json]

Arguments:
  <action-key>  the action's idempotency_key, as declared and granted
  --token       the single-use token "approval grant" printed. REQUIRED
  --payload     the JSON payload the grant bound to; "-" reads stdin. REQUIRED.
                There is deliberately no flag that takes the message inline: a
                body on a command line is a body in the shell history
  --timeout     whole-SMTP-session budget in milliseconds (default 30000).
                Exceeding it is recorded as execution.failed with smtp-timeout

The payload (its RFC 8785 canonical hash is what the grant approved):
  {"from":"a@example.com","to":["b@example.com"],"cc":[…],"bcc":[…],
   "subject":"…","body":"…","content_type":"text/plain"|"text/html"}

  bcc is INSIDE the hash and appears in NO header: a blind recipient is still a
  recipient, and an approval that did not cover them would approve a different
  act. Addresses are plain ASCII local@domain — no display names, no angle
  brackets, no internationalized addresses (this client does not negotiate
  SMTPUTF8). Unknown keys are refused rather than ignored.

Two fields are stamped by the runtime and are NOT part of the hash:
  Date        the moment of the send. The grant binds the message CONTENT; a
              Date inside the payload would make every grant expire into a
              payload-mismatch as soon as the clock moved
  Message-ID  SHA-256 over the action key and the payload hash, at the From
              domain — deterministic, so an operator holding the log can
              recompute the exact Message-ID the far side saw and trace a
              bounce back to an approval

A non-ASCII body is sent quoted-printable and a non-ASCII subject as RFC 2047
encoded-words; an all-ASCII body is sent 8bit, byte for byte as approved.

Configuration comes from the VAULT, read inside the verified-token window and
from nowhere else (no environment, no config file):
  smtp.host  smtp.port  smtp.security  smtp.user  smtp.password

  smtp.security is "implicit" (TLS from the first byte), "starttls" (a MANDATORY
  upgrade — a server that does not offer it is a failure, never a silent
  downgrade), or "none". A credential is never sent over "none". Storing neither
  smtp.user nor smtp.password means an unauthenticated relay; storing exactly
  one is refused, because sending unauthenticated because half a credential is
  missing puts the message on a path nobody configured.

No credential value reaches the log, this command's output, or an error message.
The adapter scrubs every diagnostic it builds, and the contract scans everything
the adapter returns for the values it handed out and redacts them again.

Failure codes (in adapter_code):
  email-payload-invalid   the approved bytes are not a well-formed email.
                          Nothing was connected to
  email-config-invalid    the vault holds unusable SMTP configuration
  credential-unavailable | credential-refused
                          the vault could not supply a name. Nothing was sent
  smtp-connect-failed | smtp-tls-failed | smtp-timeout | smtp-protocol-error
  smtp-<NNN>              the server refused a verb; NNN is its own reply code
                          (smtp-535 authentication, smtp-550 mailbox, …), and
                          the message carries the verb and the reply's FIRST
                          line and nothing else

${EXIT_CODES}
  adapter email: 5 when no valid token was presented, 1 for every refusal
  including a refused send, 2 for usage, 4 when the payload file or the log
  could not be read.

JSON shapes (the adapter contract's own result, unmodified):
  stdout, on a completed send:
  {"ok":true,"adapter":"email","action_key":"…","task":"…","class":"…",
   "autonomy":"manual","payload_hash":"<64hex>","started_seq":N,
   "outcome":"execution.completed","outcome_seq":N,"exit_code":0,
   "detail":{"message_id":"<…>","recipients":N,"bytes":N,"secure":true,
             "auth":"PLAIN","smtp_code":250,"transcript":[…]},"redactions":0}
  stderr, on a refusal:
  {"ok":false,"code":"…","message":"…","adapter":"email","action_key":"…",
   "acted":true|false,"started_seq":N,"outcome":"execution.failed",
   "outcome_seq":N,"exit_code":1,"adapter_code":"smtp-550","redactions":0}
${JSON_ERRORS}`;

export const ENV_HELP = `approval env — resolve .approval/env into an export block for your shell

Usage:
  approval env [--check] [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --check            print a value-free table (NAME / status / source) instead of
                     the export block, and exit 1 if a variable your POLICY NAMES
                     is unresolved
  --policy <path>    policy file whose *_env keys name the variables
  --dir <path>       directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>       log file the .approval/env path is derived from
  --json             machine-readable output (carries values; --json --check does
                     not)
  -h, --help         this text

THIS COMMAND IS THE ONLY THING THAT READS .approval/env, and its default output
CARRIES SECRETS, deliberately: its job is to put them into your shell.

    approval env --check      # look first: no value is printed on this path
    eval "$(approval env)"    # then establish the environment yourself

No other verb loads that file. Human identity (APPROVAL_HUMAN) is one of the
variables it can carry, and in v0.1 identity is config-declared (SPEC.md §11), so
a working-tree file that any process read on its own would let anything able to
write that file act as you on every human-only verb — policy attest, grant,
vault set. The file is inert; a human evaluating this output is what makes it
take effect (SPEC.md §11.1 invariant 7).

The file: one KEY=VALUE per line, # comments and blank lines ignored, no quoting
and no interpolation, mode 0600 (anything else is refused with the chmod to run),
and gitignored by "approval init". VALUE says WHERE the value lives:

  KEY=keychain:<service>       macOS: security find-generic-password -a "$USER"
                               -s <service> -w
  KEY=secret-service:<label>   Linux: secret-tool lookup approval <label>
  KEY=env:                     inherited from the shell that launched you
  KEY=<value>                  a plaintext literal — PERMITTED, and always
                               reported as plaintext by --check and by --json.
                               A rule people route around is not a control
  KEY=literal:<value>          the same, spelled out, for a value that begins
                               with something that looks like a scheme

A value with some other word: prefix is a LITERAL, not an error —
APPROVAL_HUMAN=human:alice is the commonest line this file will ever hold. Near
misses of the real schemes (keyring:, secret_service:, plaintext:, vault:, …) are
reserved and refused rather than silently exported as their own text, since a
mistyped source would otherwise surface as a 401 from the far end hours later.

THE VALUE IS NEVER PUT IN AN ARGV: the helper commands receive a service name or
a label and hand the secret back on stdout.

Which variables are answered for: APPROVAL_HUMAN, the Telegram token and chat id
(channels.telegram.token_env / chat_id_env, or the defaults), the vault
passphrase (vault.passphrase_env, or the default), the sampling secret when — and
only when — audit.sampling_secret_env names one, and any other string-valued key
ending in _env anywhere in the loaded policy.

ALREADY-EXPORTED VALUES WIN. A variable set in this shell is reported
"set-in-environment" and its line in the file is not consulted: your shell is the
authority, and a file that could override it would be a file that silently
redirects a gate operation's credentials.

An ABSENT file is not an error: every variable then falls to set-in-environment
or unset, which is the world before the file existed.

Exit 0 even when variables are unresolved, because the output is destined for
eval and a shell function that failed on an unconfigured channel is one nobody
keeps in their profile. Unresolved variables are printed as # comments naming the
repair. --check is the path with an opinion: 1 when a variable the policy NAMED
is unresolved. A defaulted variable nobody mentioned is an offer, not a promise.

${EXIT_CODES}

  4 here means the file could not be read, or its mode is not 0600.
  1 means the file's contents were refused (a syntax error, a duplicate key, an
  unknown scheme) or, with --check, that a policy-named variable is unresolved.

JSON shape (stdout, one object):
  {"ok":true,"path":"/…/.approval/env","present":true,
   "variables":[{"name":"APPROVAL_TG_TOKEN","status":"resolved-from-keychain",
                 "source":"keychain:approval-tg","plaintext":false,
                 "declared":true,"value":"…","fix"?:"…","refusal"?:{…}}]}
  status is one of set-in-environment | resolved-from-keychain |
  resolved-from-secret-service | resolved-literal | unset. "value" is present
  only when there is one AND --check was not passed. "ok" is the --check verdict
  on every path: false when a policy-named variable is unresolved.
${JSON_ERRORS}`;

export const SETUP_HELP = `approval setup — interactive configuration (SPEC.md §5.2, §10.1)

Usage:
  approval setup identity [--log <path>] [--dir <path>] [--policy <path>]
  approval setup vault    [--as human:<id>] [--log <path>] [--dir <path>]
  approval setup sampling [--as human:<id>] [--log <path>] [--dir <path>]
  approval setup channel telegram [--as human:<id>] [--api-base <url>]
                                [--log <path>] [--dir <path>] [--policy <path>]
  approval setup adapter <name> [--as human:<id>] [--log <path>] [--dir <path>]
                                [--policy <path>]

Subcommands:
  identity  declare who the human is (APPROVAL_HUMAN). The one subcommand that
            is NOT human-only, because it is what declares the identity the
            human-only check reads
  vault     mint a vault passphrase, store it, and record where it lives
  sampling  mint the audit sampling secret of §5.2, store it, and print the
            policy line that turns sampling on
  channel   configure one CHANNEL's transport credential: for telegram, collect
            the bot token, prove it with getMe, discover the approver chat, and
            record both variables
  adapter   fill the VAULT with one ADAPTER's credentials, asked for from the
            manifest that adapter declares, and prove them against the service
            without sending anything

CHANNEL AND ADAPTER ARE TWO NOUNS, not one list, and SPEC.md §4 is why. A
channel surfaces requests and collects decisions and holds no state, so its
setup fills the OS keystore and .approval/env — the map of where the values that
unlock the machine live. An adapter executes side effects and holds credentials,
so its setup fills .approval/vault.enc, which holds the values a gated adapter
SPENDS, read inside the verified-token window and by nothing else. There is no
verb that prints one back. (An older build spelled the Telegram one without the
\`channel\` noun. That form exits 2 and names this one; there is no alias.)

EVERY SUBCOMMAND REFUSES WHEN STDIN IS NOT A TERMINAL, and when --json is given,
and exits 2 printing the exact non-interactive commands to run instead. A setup
that a pipe could drive would be a way for a CI job or an agent to declare a
human identity and store a credential, and identity in v0.1 is config-declared
(SPEC.md §11): establishing it is an act of the human at the machine.

WHAT IT WRITES, AND WHAT IT WILL NOT:
  writes  .approval/env (one KEY=VALUE line per variable, mode 0600, every other
          line and comment preserved) and items in the OS keystore
  never   appends to the log, attests anything, or edits APPROVAL.md. When a
          policy line is needed it prints the \`approval policy amend\` ceremony
          and stops: an amendment ends in a human attestation, and a wizard that
          edited an attested policy would be forging the sign-off

WHERE SECRETS GO:
  macOS (security on PATH)     keychain:<service>
  Linux (secret-tool on PATH)  secret-service:<service>
  neither                      offered as a PLAINTEXT literal in .approval/env,
                               taken only on a typed \`yes\`, and reported as
                               plaintext by \`approval env --check\` forever after

  approval-tg-token            the bot token
  approval-vault-passphrase    the vault passphrase
  approval-sampling-secret     the audit sampling secret

A VALUE YOU ALREADY HOLD IS NEVER HANDLED BY THIS PROCESS. The Telegram token is
collected by the keystore helper's OWN no-echo prompt (\`security
add-generic-password … -w\` with NO value on the command line), and reaches this
runtime only by being read back on stdout. Values this runtime GENERATES (the
passphrase, the sampling secret) go to the helper on its stdin; if a helper will
not take stdin, the fallback puts a just-minted value in an argv and says so.

${EXIT_CODES}

  2 here also means "this is interactive and your stdin is not a terminal".
  1 means the far end refused (an invalid bot token, no chat found).
${JSON_ERRORS}`;

export const SETUP_IDENTITY_HELP = `approval setup identity — declare who the human is

Usage:
  approval setup identity [--log <path>] [--dir <path>] [--policy <path>]

Asks for a \`human:<id>\` identity, validates it against the ^human:.+ pattern
\`policy attest\` enforces, and writes APPROVAL_HUMAN=human:<id> into
.approval/env. Nothing is appended to the log.

A BARE ID IS ENOUGH: answer \`alice\` and the line reads APPROVAL_HUMAN=human:alice.
The prompt prints the prefix because it is what separates a human from the
\`agent:\` and \`system:\` actors the human-only verbs refuse, and those two are
refused here by name — but a prefix the question already showed you does not
have to be retyped. An answer that does not fit gets one line saying why and the
same question again; Ctrl-C or Ctrl-D writes nothing.

NOT HUMAN-ONLY, unlike every other setup subcommand, and that is not a hole: a
verb that required APPROVAL_HUMAN before it would let you set APPROVAL_HUMAN
could only be run by someone who did not need it. The terminal is the control on
this path.

This is CONFIG-DECLARED identity (SPEC.md §11). The trust boundary is this
machine: whoever can set the variable and write to the log is inside it. v0.1
makes no cryptographic claim about who attested.

The line it writes is INERT. No verb reads .approval/env on its own (§11.1
invariant 7); \`eval "$(approval env)"\` is what puts it in your shell.

Refuses when stdin is not a terminal, printing the export line to use instead.

${EXIT_CODES}
${JSON_ERRORS}`;

export const SETUP_VAULT_HELP = `approval setup vault — mint and store the vault passphrase (HUMAN-ONLY)

Usage:
  approval setup vault [--as human:<id>] [--log <path>] [--dir <path>]
                       [--policy <path>]

Generates 32 random bytes, base64-encodes them, stores the result in the OS
keystore as approval-vault-passphrase, and writes the source line for the
variable your policy names in vault.passphrase_env (APPROVAL_VAULT_PASSPHRASE by
default). The value is not printed here or anywhere else — there is no verb in
this CLI that prints it.

WARNS FIRST if .approval/vault.enc already exists. A vault is encrypted under
its passphrase and cannot be re-keyed by changing a variable: every credential
in it becomes unreadable. The warning comes before the generation, and the
confirmation defaults to no.

The generated value reaches the keystore on the helper's STDIN. If this build of
the helper will not take stdin, the fallback passes it in an argv and says so:
a value minted one moment earlier, never used, visible in \`ps\` to your own user
for the length of one call. That trade is made for generated values only.

${EXIT_CODES}
${JSON_ERRORS}`;

export const SETUP_SAMPLING_HELP = `approval setup sampling — mint the audit sampling secret (HUMAN-ONLY)

Usage:
  approval setup sampling [--as human:<id>] [--log <path>] [--dir <path>]
                          [--policy <path>]

Generates the operator-held secret that selects which supervised actions are
sampled for retrospective review (SPEC.md §5.2), stores it as
approval-sampling-secret, and writes its source line.

Selection is HMAC-SHA-256 over the event hash under this secret. Seeding from
event content alone is forbidden: the agent authoring the event controls that
content and could search it until its action falls outside the sample.

IF YOUR POLICY NAMES NO audit.sampling_secret_env, the secret is recorded under
the conventional name APPROVAL_SAMPLING_SECRET and SAMPLING STAYS OFF — §5.2
disables it whenever the policy names no variable, and this verb does not edit an
attested policy file. It prints the block to add and the \`approval policy amend\`
ceremony that attests it.

${EXIT_CODES}
${JSON_ERRORS}`;

export const SETUP_ADAPTER_HELP = `approval setup adapter — fill the vault for one adapter (HUMAN-ONLY)

Usage:
  approval setup adapter <name> [--as human:<id>] [--log <path>] [--dir <path>]
                                [--policy <path>]

Known adapters:
  email     the SMTP settings \`approval adapter email\` reads: smtp.host,
            smtp.port, smtp.security, smtp.user, smtp.password

Asks for each credential the named adapter DECLARES, validates every answer with
the adapter's own rules, stores them in .approval/vault.enc, and offers to prove
the result against the service. The manifest is the adapter's, so the names this
verb writes are by construction the names its \`act\` reads.

THE PASSPHRASE IS READ, NEVER ESTABLISHED. It comes from the environment
variable your policy names in vault.passphrase_env, exactly as \`approval vault
set\` reads it. This verb does not resolve .approval/env (SPEC.md §11.1 invariant
7) — run \`approval setup vault\` and then \`eval "$(approval env)"\` first. With
the variable unset, nothing is stored and no vault is created.

WHAT IT REPORTS: the path, the count, the names written and the names left
alone. Never a value, on any path, including a failed probe.

${EXIT_CODES}

  1 here means the service refused the stored configuration, or the vault would
  not open. The values are KEPT either way; the undo is printed.
${JSON_ERRORS}`;

export const SETUP_ADAPTER_EMAIL_HELP = `approval setup adapter email — the SMTP credentials (HUMAN-ONLY)

Usage:
  approval setup adapter email [--as human:<id>] [--log <path>] [--dir <path>]
                               [--policy <path>]

The five names the email adapter reads inside the verified-token window:

  smtp.host      the submission server
  smtp.port      587 for STARTTLS submission, 465 for implicit TLS
  smtp.security  implicit | starttls | none, picked from a numbered list
  smtp.user      optional, and both-or-neither with the password
  smtp.password  optional, read with no echo, written last

A port that is not a port and a security setting that is not one of the three
words are refused HERE, in the words \`approval adapter email\` would have used at
send time. A username without a password (or the reverse) is refused before
anything is stored: sending unauthenticated because half the credential is
missing would put the message on a path nobody configured.

THE PROBE SENDS NOTHING. It is the same SMTP session a send runs — connect,
EHLO, STARTTLS, AUTH — and then QUIT. It proves the host answers, the TLS mode is
the one the server offers, and the credential is accepted. It does not prove
delivery, and it puts no message on the wire. It defaults to yes and can be
declined; declining stores the values and says they are unverified.

A FAILED PROBE KEEPS THE VALUES. A laptop behind a captive portal is not a
reason to make you type five things again. The refusal prints the SMTP code and
the server's first line, with the credential redacted, and the undo:

  approval vault remove smtp.password --as human:<id>

${EXIT_CODES}

  1 here means the server refused, or the vault would not open with the
  passphrase in your environment.
${JSON_ERRORS}`;

export const SETUP_CHANNEL_HELP = `approval setup channel — configure one channel's transport credential (HUMAN-ONLY)

Usage:
  approval setup channel <name> [--as human:<id>] [--api-base <url>]
                                [--log <path>] [--dir <path>] [--policy <path>]

Known channels:
  telegram  the bot token and the approver chat: APPROVAL_TG_TOKEN and
            APPROVAL_TG_CHAT, or the names channels.telegram.token_env /
            chat_id_env declare

A CHANNEL IS NOT AN ADAPTER, and the two setup verbs fill different stores.
SPEC.md §4: a channel surfaces requests and collects decisions and holds no
state, so what it needs is a transport credential — it goes into the OS keystore,
and .approval/env records where. An adapter executes side effects and holds
credentials, so \`approval setup adapter <name>\` fills the vault instead, with
values a gated adapter spends inside the verified-token window.

An older build spelled the Telegram one without the \`channel\` noun. That form
exits 2 and names this one; there is deliberately no alias, because two
spellings of a distinction the SPEC draws on purpose is how the distinction
stops being drawn.

${EXIT_CODES}

  2 here also means "this is interactive and your stdin is not a terminal".
  1 means the far end refused.
${JSON_ERRORS}`;

export const SETUP_CHANNEL_TELEGRAM_HELP = `approval setup channel telegram — the bot token and the approver chat (HUMAN-ONLY)

Usage:
  approval setup channel telegram [--as human:<id>] [--api-base <url>]
                                  [--log <path>] [--dir <path>] [--policy <path>]

Five steps: store the token, prove it with getMe, WAIT for you to message the
bot, read the chat id back, and write both variables (the names come from
channels.telegram.token_env / chat_id_env, or the defaults).

The wait is a continuous long poll of up to 90 seconds, so when you send the
message does not matter and no Enter is asked for; Ctrl-C stops it. If nothing
arrives it asks getWebhookInfo and prints what Telegram says about this bot —
how many updates are pending, and whether a webhook is swallowing them.

STOP \`approval channel telegram listen\` FIRST. Two processes long-polling one
bot is a 409 from the Bot API, and the loser is whichever asked second.

THE TOKEN IS NEVER TYPED INTO THIS PROCESS on a machine with a keystore: the
helper's own no-echo prompt collects it, and this runtime reads it back on
stdout to make the getMe call. With no keystore, it is read with no echo and —
after a typed \`yes\` — written as a plaintext literal.

NO getUpdates FROM THIS VERB CARRIES AN OFFSET, EVER. An offset is an
ACKNOWLEDGEMENT: it tells the Bot API that everything below it may be discarded,
and a decision tap consumed here would never reach the listener waiting for it.
That is why \`approval doctor\` refuses to call getUpdates at all. Reading without
an offset confirms nothing, and allowed_updates is ["message"], so a pending
callback_query is not even delivered here.

The chat id is written as a LITERAL. A chat id is not a secret; the token is.

HUMAN-ONLY, and enforced (APRV-79): it stores a credential and writes
.approval/env, exactly as \`setup vault\` and \`setup sampling\` do. --as expects a
human:<id>; an agent: or system: actor is refused at exit 2.

${EXIT_CODES}

  1 here means the far end refused: an invalid token (re-copy it from
  @BotFather), a 409 from a running listener, or no message reaching the bot
  before the deadline — in which case Telegram's own view of the bot and the
  manual curl are printed.
${JSON_ERRORS}`;

// ---------------------------------------------------------------------------
// The MCP wrapper (APRV-87)
// ---------------------------------------------------------------------------

export const MCP_HELP = `approval mcp serve — the MCP wrapper of SPEC.md §10.5 (stdio, FOREGROUND)

Usage:
  approval mcp serve --as agent:<id> [--dir <path>] [--log <path>]
                     [--policy <path>]

Flags:
  --as agent:<id>  the identity EVERY tool call is recorded under. Required,
                   unless APPROVAL_AGENT names one. agent: only — a human: or
                   system: value is refused at exit 2, before the transport
                   exists
  --dir <path>     the working directory tools resolve every relative path
                   against (default: this process's working directory)
  --log <path>     pin the log file for every tool call
  --policy <path>  pin the policy file for every tool call
  -h, --help       this text

Speaks MCP over stdin/stdout and runs until interrupted. SIGINT and SIGTERM
close the transport and exit 0. STDOUT IS THE JSON-RPC STREAM: this verb's own
messages go to stderr, and a child spawned by the run tool is piped rather than
inheriting the terminal, so nothing can write into the wire.

THE TOOLS ARE THE AGENT SURFACE, AND ONLY THAT. The tool list is the verb
registry (\`approval instructions --schemas\`) filtered by human_only false, and
every tool's inputSchema is that verb's registry input schema. Two agent-facing
verbs are still withheld: \`consume\`, which is internal plumbing that \`run\`
wraps, and \`hook claude-code\`, which reads a PreToolUse event from a stdin this
transport already owns.

NOT PUBLISHED, and this is the design rather than an omission: grant, reject,
revoke, policy attest, policy amend, execution resolve, audit review, expire,
env, init, setup, vault, the channels, the daemon, and this verb itself. SPEC.md
§11 names the agent the untrusted policy and the human the trusted, expensive
overseer. An MCP client is an agent's harness, so offering it grant would hand
the untrusted policy the overseer's pen. A human decides at a human's surface:
\`approval channel cli\`, the local web page, or Telegram.

IDENTITY CANNOT BE ESCALATED BY A CALLER. --as is removed from every published
input schema, so a client sending one is refused by the schema; the server's own
identity is appended last to every argv, so it wins even if one arrives another
way. There is no tool that takes an actor.

Tool calls run SERIALLY in this process, and appends go through the same
lockfile and compare-and-append every \`approval\` process uses, so a CLI running
beside this server is safe. A refusal comes back as a tool result with
isError true carrying the CLI's own {"error":{"code","message"}} object, never
as a thrown JSON-RPC error: the command was well-formed and the answer was no,
which the caller must be able to read as data. A JSON-RPC error means something
else — an unknown tool, or arguments that do not match the schema. The exit code
travels in _meta as "approval.md/exit_code".

THIS SERVER READS NO .approval/env (SPEC.md §11.1 invariant 7). It runs under
whatever environment the operator launched it with, exactly as every other
\`approval\` invocation does.

POST-V1: mapping the MCP tasks/elicitation extension onto \`awaiting\`. SPEC.md
§10.5 says that MAY happen "when client support stabilizes"; until then the
wait tool blocks and answers, and its timeout is an answer of its own.

${EXIT_CODES}

  2 here is a startup refusal: no agent identity, a human:/system: identity, an
  unknown flag, or an unknown subcommand. 0 is a clean shutdown.
${JSON_ERRORS}`;
