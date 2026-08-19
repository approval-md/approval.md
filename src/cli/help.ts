/**
 * Help text. SPEC.md §10.1 makes `--help` part of the interface rather than a
 * courtesy: the CLI is how agents use this system, and an agent that has to
 * guess an exit code or a JSON key is an agent that will guess wrong on the one
 * invocation that mattered. Every command therefore documents its flags, its
 * refusal codes and its exact `--json` shape.
 *
 * WHAT A PER-VERB HELP IS (APRV-91): the usage forms, a short paragraph of
 * intent, the flags, the machine-facing contract (`--json` shape, refusal
 * codes), and a two-line footer. What it is NOT is an essay. The frozen
 * exit-code table is printed by `approval --help` and nowhere else, the
 * cross-cutting stances (identity is declared not proved, a refusal is exit 1,
 * a token is shown once, a channel is transport) are stated once at the root,
 * and the long design rationale lives in `docs/cli-reference.md`, which every
 * trimmed help points at by anchor. The prose was moved, not rewritten.
 */

import { GITIGNORE_ENTRY_LINES, GITIGNORE_MARKER } from "./scaffold.js";

/** The frozen table. Printed by {@link ROOT_HELP} and by nothing else. */
const EXIT_CODES = `Exit codes (frozen public API):
  0  success
  1  integrity failure (corrupt log)
  2  usage error
  3  torn tail
  4  I/O error (unreadable/unwritable path; never reported as corruption)`;

/** What a per-verb help says instead of reprinting the table. */
const EXIT_CODES_POINTER = `exit codes: approval --help`;

const JSON_ERRORS = `With --json, usage and I/O failures print {"error":{"code","message"}} to
stderr and nothing to stdout.`;

/** The footer line pointing at the moved rationale. */
function why(anchor: string): string {
  return `why: docs/cli-reference.md#${anchor}`;
}

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

Two codes are ADDITIONS to the table above, each emitted by exactly one verb:
5 by "approval run" when no valid execution token was presented (nothing is
appended), and 6 by "approval wait" on timeout. Nothing in 0–4 changed meaning.
This table is printed HERE and nowhere else; a verb's own --help names only the
codes that are peculiar to it.

Machine-readable output: every command accepts --json and prints exactly one
JSON object per invocation. Run "approval <command> --help" for that command's
exact shape.
${JSON_ERRORS}

The stances every verb inherits, stated once:

  THE LOG IS APPEND-ONLY. "policy attest" and the gate verbs (register, request,
  grant, reject, revoke, expire) each append at most one event per invocation; a
  torn tail is reported, never repaired, and nothing ever rewrites a line.

  A GATE REFUSAL exits 1, NOT 2 — an illegal transition, an expired request, an
  unattested policy, a failed budget. The command was well-formed; the answer is
  no. With --json, error.code names the refusal, and retrying with different
  flags is the wrong repair.

  IDENTITY IS CONFIG-DECLARED (SPEC.md §11). The actor comes from --as or
  APPROVAL_HUMAN and nothing authenticates it; the trust boundary is the local
  machine. What the log proves is that someone with local control acted, not
  who. grant, reject, revoke and every human-only verb require human:<id>;
  expire is the system verb and takes no identity.

  APPROVAL EVENTS ARE EXCLUSIVE TO THE MANUAL PATH (amended SPEC.md §6.3). An
  action resolving to supervised or autonomous emits no approval.requested and
  no approval.granted: "approval request" appends nothing and reports
  proceed:true, and its authorization is the execution.started event. Do not
  wait for a grant that will never come.

  THE RAW EXECUTION TOKEN IS SHOWN ONCE, BY "approval grant". The log records
  only its SHA-256, so nothing can recover it — not "approval token", not the
  log, not the index. If it is lost, revoke the grant and request again.

  A CHANNEL IS TRANSPORT. It renders what the runtime derived and reports the
  gesture a human made; it decides nothing, holds no state, writes no log line
  and never sees a token. Every field it shows is marked [computed] (the runtime
  derived it) or [claimed] (the party under oversight wrote it), per SPEC.md §9.

The reasoning behind each verb — threat models, the design points that surprise
people, the alternatives that were rejected — is in docs/cli-reference.md.`;

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

Prints what an agent needs to know before it acts: the register -> request ->
wait -> run sequence, what a refusal means, how to read the exit codes and the
--json error shapes, and the invariants that are enforced rather than requested.
The verb table is generated from the registry, so a verb missing from the guide
is a test failure rather than a documentation lapse. Reads no log, resolves no
policy, writes nothing; the output is a pure function of this build.

${EXIT_CODES_POINTER} (instructions uses only 0 and 2)
${JSON_ERRORS}
${why("instructions")}`;

export const LOG_HELP = `approval log — read the append-only event log

Usage:
  approval log verify [--log <path>] [--json]
  approval log tail   [--log <path>] [-n <count>] [--json]
  approval log export [--log <path>] [--json]

Subcommands:
  verify   walk the hash chain end to end and report clean | torn-tail | corrupt
  tail     print the last N records (default 10)
  export   stream every stored line to stdout, byte for byte

All three open the log for reading only.
Default log path: .approval/log/events.jsonl (relative to the working directory)

JSON shapes (one object per invocation, on stdout):
  verify  {"status","records","head","intactThroughSeq"?,"firstBadSeq"?,"reason"?,"message"?}
  tail    {"status":"ok"|"torn-tail","records":[...],"warning"?}
  export  {"records":[...],"warning"?}

${EXIT_CODES_POINTER}
${JSON_ERRORS}`;

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
  A CLEAN LOG WITH ANOMALIES IS CLEAN and still exits 0.

Human output: the status and head on stdout; reason, first bad seq, anomalies,
and the full message on stderr.

${EXIT_CODES_POINTER} (clean 0, corrupt 1, torn-tail 3; an unreadable log is 4,
not 1: a permission bit is not evidence of tampering)
${JSON_ERRORS}
${why("log-verify")}`;

export const TAIL_HELP = `approval log tail — print the last records of the log

Usage:
  approval log tail [--log <path>] [-n <count>] [--json]

Flags:
  --log <path>   log file to read (default .approval/log/events.jsonl)
  -n <count>     how many records to print (default 10; 0 prints none)
  --json         machine-readable output
  -h, --help     this text

The chain is verified first. On a torn tail the intact records are printed and
the tear is a warning on stderr; on a corrupt log no records are printed at all.
An empty or absent log prints nothing and succeeds. Nothing is repaired.

JSON shape (stdout, one object):
  {"status":"ok","records":[<event objects, oldest first>]}
  {"status":"torn-tail","records":[...],"warning":"..."}

Human output: one line per record — seq, ts, event, actor, task.

${EXIT_CODES_POINTER} (0 on success, torn tail included; 1 on a corrupt log)
${JSON_ERRORS}`;

export const EXPORT_HELP = `approval log export — stream the whole log to stdout

Usage:
  approval log export [--log <path>] [--json]

Flags:
  --log <path>   log file to read (default .approval/log/events.jsonl)
  --json         machine-readable output
  -h, --help     this text

Without --json the stored lines are written verbatim, byte for byte: piping
export to a file yields a copy of the log. The chain is verified first; a torn
tail prints the intact lines with a stderr warning and exits 0, a corrupt log
prints nothing and fails. The log is never modified.

JSON shape (stdout, one object):
  {"records":[<every event object, oldest first>]}
  {"records":[...],"warning":"..."}   on a torn tail

${EXIT_CODES_POINTER} (0 on success, torn tail included; 1 on a corrupt log)
${JSON_ERRORS}`;

/**
 * The policy command's exit-code stance, printed in all three policy help
 * texts. It is the one place where "answer" and "error" come apart, so it is
 * stated at length rather than assumed: `policy check` answers the question
 * "what would policy do with this class", and a policy too broken to load has
 * a perfectly good answer — manual, everything, always.
 */
const POLICY_EXIT_CODES = `${EXIT_CODES_POINTER}. policy check|test uses only 0, 2 and 4:
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
          gate operations refuse while the live file is unattested or changed)
  amend   the whole amendment ceremony in one verb: semantic diff, load
          advisory, attestation, and the two-file git commit

Nothing is executed, requested, or logged: this command reads APPROVAL.md and
answers a hypothetical. Discovery is APPROVAL.md then APPROVALS.md in --dir
(default: the working directory); --policy names a file directly and wins.

${POLICY_EXIT_CODES}

${POLICY_MANUAL_BECAUSE}

Run "approval policy check --help" for the flags and the full --json shape.
${why("policy")}`;

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

\`policy ${verb}\` is an exact alias of \`policy ${alias}\`. <class> is a concrete
action class (lowercase dotted segments, e.g. read.web, vcs.push.main) — not a
pattern: \`*\` is something a policy key may contain, never something an agent
can do.

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
either applies. stderr stays empty on a successful answer.
${why("policy-check")}`;
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
attestation or no attestation exists, with the reason "policy-not-attested". An
edited policy is inoperative until a human re-attests it.

Human-only: the actor must match human:<id>, from --as or APPROVAL_HUMAN.
Identity is CONFIG-DECLARED and nothing here authenticates it: the
trust boundary is the local machine, so an attestation proves that someone with
local control signed off, not who.

Bytes, not parse: the file is hashed as it sits on disk and does NOT have to be
loadable. Attesting a schema-invalid policy records exactly what it says — a
human saw these bytes — and does not make a broken policy work.

JSON shape (stdout, one object):
  success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/APPROVAL.md"}
  refusal  {"ok":false,"error":{"code":"...","message":"..."}}  on stderr
  path is the file that was hashed; the logged payload carries its basename
  only, so an exported log leaks no home directory.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("policy-attest")}`;

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
     amend, reported on stdout at EXIT 0;
  3. recovers the last-attested policy TEXT if it can (see BASELINE) and prints
     the SEMANTIC diff, computed by the real engine on both versions;
  4. runs the load advisory;
  5. asks for confirmation (skipped by --yes and --dry-run);
  6. attests — one policy.updated event, identical to "approval policy attest";
  7. prints, or with --commit runs, the git ceremony: "git add <policy> <log>",
     a "git commit" citing the attestation seq, and the push (and, on the branch
     flow, the branch and the pull request).

THE TWO FLOWS. DIRECT commits on the branch you are standing on. BRANCH creates
a branch, pushes it and opens a PR carrying that one commit — MERGE THAT PR WITH
A MERGE COMMIT, so the policy edit and its attestation stay one commit on main.
PRECEDENCE, highest first: --branch <name> (with --direct it is a usage error),
then --direct, then detection — the branch flow when the default branch is
protected and checked out, the direct flow otherwise and when detection is
UNKNOWN. Detection is read-only ("gh api …/protection") and never fails the
command.

BASELINE (a stated limitation, FLAGGED FOR HUMAN REVIEW): an attestation records
only the SHA-256 of the policy bytes, so the attested TEXT is
NOT recoverable from the log. In a git repository HEAD:<path> is the baseline
ONLY IF that blob's hash equals the attested hash; otherwise it drops to
HASH-ONLY MODE, says so loudly, and runs only the load advisory and the
attestation. There is no --baseline flag.

CONFIRMATION: interactive y/N by default. With stdin not a terminal (or --json)
and no --yes it REFUSES at exit 2 rather than assuming an answer. --commit
carries EXACTLY two files, the policy and the log, and every precondition it
checks is checked BEFORE the attestation. Human-only, with "policy attest"'s
identity rules exactly.

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
  and an abort. In a dry run the commands carry the literal placeholder <seq>.
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
  git-failed            the attestation WAS appended and git then failed; the
                        message names the seq and what to run by hand.
  pr-failed             the attestation was appended, committed and pushed, and
                        "gh pr create" then failed.
  append-failed         the attestation append itself failed.
  log-unreadable / log-torn-tail / log-corrupt
                        nothing is amended from a log that does not verify.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("policy-amend")}`;

/** The gate verbs' refusal vocabulary — frozen public API, not rationale. */
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
                          LOST after registration. Nothing is appended; restore
                          the block by hand from the log.
  not-registered          the task has no task.registered record.
  action-not-registered   the task declares no action with that idempotency key.
  duplicate-request       a live approval.requested already awaits a decision.
  already-executed        the action key already has an execution.started.
  budget-exceeded         APRV-14 verdicts failed; a budget.exceeded event WAS
                          appended and error.verdicts lists the failures.
  loop-escalated          three consecutive execution.failed events escalated
                          the task to manual (SPEC.md §10.2). Its MANUAL actions
                          are unaffected; the streak clears on a completion.
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
                          from an unverifiable log (exit 1).
  append-failed           the append itself failed; exit code follows the cause.
                          \`head-moved\` means the log grew between this command's
                          read and its write, so nothing was written.`;

/** The one line a gate verb adds to the root's table: a refusal is 1, not 2. */
const GATE_EXIT_CODES = `${EXIT_CODES_POINTER}. A GATE REFUSAL IS 1, NOT 2: the
command was well-formed and the runtime said no. Branch on error.code, not on
the exit code.`;

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
the declared actions. FAIL CLOSED: an invalid envelope appends nothing. The file
is READ ONLY, and registering the same task id twice is refused.

JSON shape (stdout, one object):
  success  {"ok":true,"seq":1,"task":"task-042","actions":1}
  refusal  {"ok":false,"error":{"code":"...","message":"...","errors"?:[...]}}
           on stderr, where errors carries the schema failures.

${GATE_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why("register")}`;

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
task.registered record in the LOG — there are no --class or --cost flags.
Register once from the file; request against what was registered.

Order of checks, each with its own refusal code: identity, attestation, class
resolution (including SPEC §7's irreversibility floor), then — on the manual
path only — the content binding (payload-hash-required, payload-mismatch),
request legality, budgets, the payload store write, and the append of
approval.requested. A refused request stores nothing.

APPROVAL EVENTS ARE EXCLUSIVE to the manual path (amended SPEC.md §6.3): a
supervised or autonomous action appends nothing here and reports proceed:true.
Do not wait for a grant that will never come.

JSON shape (stdout, one object):
  manual        {"ok":true,"task":"task-042","action_key":"...","class":"...",
                 "autonomy":"manual","proceed":false,"requested":true,"seq":3}
  non-manual    {"ok":true,...,"autonomy":"autonomous","proceed":true,
                 "requested":false,"seq":null}
  refusal       {"ok":false,"error":{"code":"...","message":"...",
                 "verdicts"?:[...],"detail"?:"...","state"?:"...","seq"?:N}}
                 on stderr. seq is the budget.exceeded record that WAS appended.

${GATE_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why("request")}`;

function decisionHelp(verb: "grant" | "reject" | "revoke"): string {
  const event = verb === "grant" ? "approval.granted" : verb === "reject" ? "approval.rejected" : "approval.revoked";
  const legality =
    verb === "revoke"
      ? `Legal only on a GRANTED request that has NOT executed (not-granted /
already-executed).`
      : `Legal only on a request awaiting a decision; a second decision is refused
(already-decided).`;
  const attestation =
    verb === "grant"
      ? `Attestation is REQUIRED: granting is the authorizing decision.`
      : `Attestation is NOT required: this verb withdraws authority rather than
granting it.`;
  const budgets =
    verb === "grant"
      ? `Budgets are RE-EVALUATED at grant time; a failure appends budget.exceeded and
refuses. The appended approval.granted carries payload {"class","est_cost_usd"}
copied from the request.`
      : `No budget is charged: an authorization refused or withdrawn was never a
commitment.`;

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

Appends exactly one ${event} on success. HUMAN-ONLY: the actor must match
human:<id>, and identity is config-declared (--as or APPROVAL_HUMAN).

${legality}
${attestation}
${budgets}

TTL: a decision after the request's TTL is refused with "expired", judged from
the request's OWN timestamp plus defaults.approval_ttl. When the gate discovers
a lapse it appends approval.expired (actor system:gate) and then refuses.
${
  verb === "grant"
    ? `
TOKENS: a grant MINTS the single-use execution token and PRINTS IT ONCE — on
stdout as "token: <64 hex>", or as the "token" key with --json. The log records
only its SHA-256, so nothing can recover it. Capture it, or revoke and request
again. Spend it with "approval run".
`
    : ""
}
JSON shape (stdout, one object):
  success  {"ok":true,"decision":"${verb}","state":"${verb === "grant" ? "granted" : verb === "reject" ? "rejected" : "revoked"}","action_key":"...","seq":5${verb === "grant" ? `,\n            "token":"<64 hex>"}   (shown once; never recoverable)` : "}"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "verdicts"?:[...],"detail"?:"...","seq"?:N}}  on stderr

${GATE_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why(verb)}`;
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
accepted or resolved: no human decides an expiry, the clock does. This is the
verb the daemon's sweep calls; it exists in the CLI so the sweep is testable.

Refused when the request is not live (not-requested, already-decided) or when
the TTL has not lapsed (not-expired, which also covers a policy declaring no
defaults.approval_ttl). defaults.on_expiry is recorded in the payload; late
decisions are refused with "expired" whether or not this verb has ever run.

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","actor":"system:gate","seq":6}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
           on stderr

${GATE_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why("expire")}`;

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
scratch at a temporary path and renamed into place, so a crashed rebuild leaves
the previous index intact. A corrupt log is refused outright and a torn tail is
refused unless --force is given. The log itself is never written to.

JSON shape (stdout, one object):
  success  {"ok":true,"records":3,"head":{"seq":3,"hash":"<64 hex>"},
            "truncated":false}
  refusal  {"ok":false,"error":{"code":"not-clean"|"torn-tail"|"io",
            "message":"..."}}
  head is null for an empty log; truncated is true only for a forced torn tail.

${EXIT_CODES_POINTER} (1 when the log failed verification, 3 on a torn tail
without --force)
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
                   unverifiable log (exit 1).
  append-failed    the append itself failed; exit code follows the cause.
                   \`head-moved\` means another writer got there first — with one
                   token that is a refused double-spend, and nothing was written.`;

/** The design point everybody gets wrong on first reading, in one sentence. */
const TOKEN_SHOWN_ONCE = `THE RAW TOKEN IS SHOWN ONCE, BY "approval grant", AND IS RECOVERABLE FROM
NOTHING: the log records only its SHA-256. If it is lost, revoke the grant and
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

So this command does NOT print the token. It reports whether a live, unspent
token EXISTS for the action key and prints its digest, so an operator can match
it against the log. Exit 0 means granted, unrevoked, unexpired, unconsumed;
every other answer is a refusal naming which of the three deaths applied.
Writes nothing.

JSON shape (stdout, one object):
  live     {"ok":true,"action_key":"...","state":"granted","live":true,
            "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
            "est_cost_usd":0.02,"payload_hash":"<64 hex>"|null,
            "task":"task-042"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "seq"?:N}}  on stderr
  payload_hash is the binding the grant carried, or null for a grant that bound
  to no bytes.

${TOKEN_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why("token")}`;

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
                   token stays live.
  --as <id>        the executing identity, human:<id> or agent:<id>;
                   defaults to APPROVAL_HUMAN
  --policy <path>  policy file to read defaults.approval_ttl from
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

INTERNAL. This is the plumbing verb "approval run" wraps; prefer
"approval run -- <cmd…>", which mints, spends, executes and records completion
as one auditable unit. It verifies the token and, only if it is live, appends
ONE execution.started carrying {"class","est_cost_usd","token_sha256"}.
Supervised and autonomous actions have no token and are refused not-granted.

${TOKEN_SHOWN_ONCE}

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","event":"execution.started","seq":5,
            "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
            "est_cost_usd":0.02}
  refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
            "seq"?:N}}  on stderr

${TOKEN_REFUSAL_CODES_HELP}

${GATE_EXIT_CODES}
${JSON_ERRORS}
${why("consume")}`;

// ---------------------------------------------------------------------------
// The execution verbs (APRV-18): run, wait, status, queue
// ---------------------------------------------------------------------------

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
                   SPEC.md §6.2 defines as its payload, "the argv array and cwd".
                   Any action whose grant bound to content instead (an email
                   body, a record write, a message and its recipients) MUST pass
                   this flag with that content's hash, or the spend is refused
                   payload-mismatch. Get it from "approval payload hash <file>".
  --as <id>        the executing identity, human:<id> or agent:<id>; defaults to
                   APPROVAL_HUMAN
  --policy <path>  policy file to apply (overrides discovery)
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read and append to
  --json           machine-readable summary — ON STDERR, see below
  -h, --help       this text

Everything after the first "--" is the child's argv, passed through untouched.

What it does, in this order:
  1. appends execution.started — BEFORE the child is spawned, never after;
  2. spawns the command with inherited stdio (the child owns the terminal);
  3. appends execution.completed (child exit 0) or execution.failed (anything
     else), carrying payload.exit_code — the real number, unmapped;
  4. exits with THE CHILD'S EXIT CODE. A child killed by a signal is recorded as
     128 + signal; a command that could not be spawned is recorded as 127.

Authorization: manual actions spend a token. Supervised and autonomous actions
have no grant and no token — for them run enforces attestation, loop escalation,
single-use idempotency, and BUDGETS, which are charged here.

A CRASH BETWEEN started AND ITS OUTCOME leaves a DANGLING EXECUTION, which
NOTHING REPAIRS AUTOMATICALLY. Recovery is a human recording what they observed:

  approval execution resolve <action-key> --outcome completed|failed \
                             --note "<what you saw>" [--as human:<id>]

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
  loop-escalated        three consecutive execution.failed events escalated the
                        task to manual; route it through a human grant instead.
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
  log-corrupt           the hash chain does not verify (exit 1).
  append-failed         the append itself failed; exit code follows the cause.

${EXIT_CODES_POINTER}, plus one code this verb alone emits:
  5  NO VALID EXECUTION TOKEN. The action's class resolves to manual and no
     usable token was presented. NOTHING was appended. Distinct from 1 because
     the repair is distinct: request the action, have a human grant it, and pass
     the token that grant printed once.
${JSON_ERRORS}
${why("run")}`;

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
timeout elapses. WRITES NOTHING — not even the approval.expired it may derive.
Only the MANUAL path produces requests to wait for, so a task with none returns
immediately with exit 0.

JSON shape (stdout, one object; timeout goes to stderr):
  decided  {"ok":true,"task":"task-042","status":"granted"|"rejected"|"expired",
            "actions":[{"action_key":"...","state":"granted","seq":4}]}
  timeout  {"ok":false,"task":"task-042","status":"timeout",
            "actions":[{"action_key":"...","state":"requested","seq":3}]}
  state is the per-action derived state; status is the whole task's outcome,
  with rejected/revoked outranking expired and expired outranking granted.

${EXIT_CODES_POINTER}. For "approval wait" THE CODE IS THE DECISION (SPEC.md
§10.1): 0 granted, 1 rejected or revoked, 3 expired, 4 I/O, and
  6  TIMEOUT — "approval wait" only. The wait elapsed with request(s) still
     undecided. Nothing was appended, the requests are still live, and waiting
     again is legitimate.
The overloading of 1 and 3 is deliberate; --json names the outcome exactly.
${JSON_ERRORS}
${why("wait")}`;

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
the TTL is left. THIS IS AN INBOX, NOT A DASHBOARD — dangling executions,
attestation, budgets, chain verification and loop escalations are all in
"approval status". Writes nothing, and EXIT 0 ALWAYS when the log could be read.

JSON shape (stdout, one object):
  {"ok":true,"pending":[{"action_key":"task-042:chaser","task":"task-042",
   "class":"communicate.email.external","est_cost_usd":0.02,
   "requested_ts":"2026-08-06T10:00:00.000Z","seq":3,
   "ttl_remaining_ms":3599000}]}
  pending is [] for an empty inbox. ttl_remaining_ms is null when the policy
  declares no defaults.approval_ttl (no TTL means no lapse).

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("queue")}`;

export const STATUS_HELP = `approval status — system health, not the inbox

Usage:
  approval status [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --policy <path>  policy file whose bytes attestation is judged against
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

THIS IS NOT "approval queue". queue is what a human must answer; status is what
an operator must fix. Writes nothing. It reports, in one object:

  attestation      attested | hash-mismatch | not-attested | unreadable, with
                   the seq of the governing policy.updated record
  verification     the latest chain verdict, and the record count (null when
                   corrupt)
  dangling         executions that STARTED AND NEVER FINISHED. Nothing repairs
                   one automatically; it clears when a human records the real
                   outcome with "approval execution resolve"
  budgets          headroom per configured GLOBAL limit, from a zero-cost probe
                   evaluated now. Class limits are absent by design: they need a
                   matched rule, and therefore a specific action
  loop_escalations tasks with three consecutive execution.failed events
  payload_store    whether .approval/payloads/ exists, how many files it holds,
                   how many the log records as pruned, and how many are unbound.
                   INFORMATIONAL: it moves neither the verdict nor the exit code
  anomalies        ADDITIVE and present only when non-empty: gate-typed events
                   whose ts steps backwards by more than 2s. INFORMATIONAL

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
   "payload_store":{"present":true,"files":2,"pruned":0,"orphans":0,
     "note":"..."}}
  ok is true whenever status ran; healthy is the verdict. attestation.seq is
  null for not-attested and unreadable. payload_store.pruned counts distinct
  hashes a payload.pruned event names and orphans counts store files no record
  binds; note carries the unrebuildable warning verbatim.

${EXIT_CODES_POINTER} (1 when anything needs attention, including a torn tail)
${JSON_ERRORS}
${why("status")}`;

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

THIS IS NOT "approval status". status reports the health of the SYSTEM recorded
in the log; doctor reports whether this MACHINE can run the system at all.
APPENDS NOTHING, sends nothing, repairs nothing: every failure carries a fix the
human runs themselves, and every fix begins with a command you can paste.

Eleven checks, in the order in which their failures cascade:
  build-freshness    dist/src/cli/main.js is present and not older than src/
  identity           APPROVAL_HUMAN names a human:<id>
  attestation        the live policy bytes match the latest policy.updated
  log                the hash chain verifies
  telegram           getMe against --api-base, when both variables are set
  web-port           channels.web.port can be bound on 127.0.0.1
  payload-store      .approval/payloads/ can be written
  audit-sampling     whether the supervised-action sampler is actually running
  envelope-integrity every registered task file still carries its envelope
  vault              .approval/vault.enc is gitignored, unlockable, readable
  environment        the variables your policy NAMES will be there, and what
                     .approval/env says about where each one comes from

No value of any credential appears in the output, on any path.

JSON shape (stdout, one object):
  {"ok":false,"checks":[
    {"check":"build-freshness","status":"pass","detail":"..."},
    {"check":"identity","status":"fail","detail":"...","fix":"..."}, …]}
  status is "pass" | "fail" | "skip". fix is present only when there is
  something to do, and it always begins with a runnable command. ok is true when
  no check failed — a skip does not make it false. The eleven checks always
  appear, in this order.

${EXIT_CODES_POINTER} (1 when ANY check failed; 4 only when doctor itself could
not look)
${JSON_ERRORS}
${why("doctor")}`;

export const AUDIT_HELP = `approval audit — the retrospective review of sampled supervised actions

Usage:
  approval audit list   [--all] [--log <path>] [--json]
  approval audit review <seq|action-key> [--note "<text>"] [--as human:<id>]
                        [--log <path>] [--json]

Subcommands:
  list      the open sampled-audit backlog: audit.sampled with no audit.reviewed
  review    record that a HUMAN looked at one sampled action

SUPERVISED actions execute immediately and are audited AFTERWARDS: the daemon
samples a fraction of them into a backlog a person works through.

THERE IS NO "approval audit sample". Selection is the runtime's, derived with an
operator-held secret, because a caller who could sample — or decline to sample —
an action of its choosing would hold the control that exists to oversee it. If
no secret is configured, SAMPLING IS OFF and this backlog stays empty; "audit
list" reports that beside the backlog.

${EXIT_CODES_POINTER}
${why("audit")}`;

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

Reads a VERIFIED log and writes nothing: the same set .approval/QUEUE.md renders
and the daemon counts, from the same projection. A review closes a sample only
when it comes AFTER it in the chain and names the same action.

JSON shape (stdout, one object):
  {"ok":true,
   "sampling":{"enabled":false,"rate":0.1,"secret_env":"APPROVAL_SAMPLE_SECRET",
               "reason":"secret-unset"},
   "open":2,
   "samples":[{"seq":9,"ts":"...","action_key":"...","task":"...",
               "subject_seq":7,"reviewed_seq":null}]}
  sampling.reason is null when sampling is running, and otherwise one of
  policy-unreadable, rate-absent, rate-zero, rate-invalid, secret-env-unnamed,
  secret-unset. The SECRET ITSELF is never printed by any code path;
  sampling.secret_env is the variable's NAME.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-list")}`;

export const AUDIT_REVIEW_HELP = `approval audit review — record that a human reviewed a sample

Usage:
  approval audit review <seq|action-key> [--note "<text>"] [--as human:<id>]
                        [--log <path>] [--json]

Arguments:
  <seq|action-key> a bare integer is the SEQ OF THE audit.sampled RECORD; any
                   other value is an action key with exactly one open sample.
                   An action key with several open samples refuses
                   ambiguous-subject.

Flags:
  --note <text> what you concluded. OPTIONAL — this event records only that a
                person looked
  --as human:<id>  the reviewer; defaults to APPROVAL_HUMAN. HUMAN-ONLY
  --log <path>  log file to read and append to
  --json        machine-readable output
  -h, --help    this text

What it appends: audit.reviewed, naming the sample's action key and task, with
payload {"subject_seq":<seq of the audit.sampled>,"reviewed":true,"note"?:"..."}

NO ATTESTATION IS REQUIRED: review records an observation, exercises no policy
authority, authorizes nothing, and spends no budget.

Refuses (exit 1): not-sampled, already-reviewed, ambiguous-subject,
actor-not-human. All leave the log untouched.

JSON shape (stdout, one object):
  success  {"ok":true,"seq":11,"sample_seq":9,"action_key":"...","task":"...",
            "actor":"human:alice"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
           on stderr

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-review")}`;

export const EXECUTION_HELP = `approval execution — recovery verbs for executions the runtime could not close

Usage:
  approval execution resolve <action-key> --outcome completed|failed
                            --note "<text>" [--as human:<id>] [--log <path>]
                            [--json]

Subcommands:
  resolve   record the outcome a HUMAN OBSERVED for a dangling execution

A DANGLING EXECUTION is what a crash between execution.started and its outcome
leaves behind. "approval status" reports it; "approval queue" does not, because
nobody is being asked to decide anything. Nothing closes one automatically.

${EXIT_CODES_POINTER}
${why("execution")}`;

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
  --as human:<id>  the person recording the observation; defaults to
                   APPROVAL_HUMAN. HUMAN-ONLY — an agent closing its own
                   dangling execution is the executing party reporting on
                   itself.
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

What it appends: execution.completed or execution.failed, with payload
  {"note":"<text>","attested_by_human":true,"exit_code":null}

exit_code is NULL, not 0 and not 127: nobody ran anything, and a fabricated exit
code would read exactly like an observed one. NO ATTESTATION IS REQUIRED —
resolve records a fact a human observed, exercises no policy authority, spends
no budget and mints no token.

Refuses (exit 1) when there is nothing to close: not-started, already-finished.
Both leave the log untouched.

JSON shape (stdout, one object):
  success  {"ok":true,"action_key":"...","task":"...",
            "event":"execution.completed","outcome":"completed","seq":7,
            "attested_by_human":true,"actor":"human:alice"}
  refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
           on stderr

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("execution-resolve")}`;

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
             Grant/Reject forms and a batch gesture
  telegram   deliver the queue to a Telegram chat and long-poll for
             Approve/Reject taps

A channel is TRANSPORT: it renders what the runtime derived and reports the
gesture a human made. Every decision collected here is recorded by the same
human-only gate "approval grant" and "approval reject" call, with every rule —
TTL, budgets, attestation, idempotency — applied unchanged.

${EXIT_CODES_POINTER}
${why("channel")}`;

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
                       Unset, the bytes come from .approval/payloads/. Either
                       way they are hashed and checked against the request's
                       recorded payload_hash; material that does not match is
                       REFUSED, never rendered.
  --as human:<id>      the person deciding; defaults to APPROVAL_HUMAN. Required
                       only when a decision could be recorded.
  --interactive        prompt even though stdin is not a terminal (scripted
                       input, wrappers, tests)
  --json               machine-readable output; never interactive
  -h, --help           this text

Renders every pending manual request with the [computed]/[claimed] markers of
SPEC.md §9 and the full payload verbatim inside delimiters:

  --- BEGIN FULL PAYLOAD (bound sha256 <64hex>) ---
  { … }
  --- END FULL PAYLOAD ---

A manual request whose material nobody holds is SKIPPED and reported on stderr.

INTERACTIVE ONLY WITH A TERMINAL. With a TTY on stdin (or --interactive) each
request is answered g) grant, r) reject, s) skip; a reject DEMANDS a note. A
grant prints its single-use execution token ONCE. WITHOUT a TTY, and always with
--json, the queue is printed and the command EXITS 0 WITHOUT READING STDIN.

JSON shape (stdout, one object):
  {"ok":true,"channel":"cli","interactive":false,
   "pending":[{"action_key":{"kind":"computed","value":"task-042:chaser",
     "source":"log"},
     "summary":{"kind":"claimed","value":"chase invoice 41",
       "author":"agent:drafter"}, …}],
   "skipped":[{"action_key":"...","code":"payload-unavailable",
     "message":"..."}]}
  pending holds the TAGGED requests verbatim, so a machine reader sees the same
  computed/claimed split a human does. pending is [] for an empty queue.

${EXIT_CODES_POINTER} (1 is also a gate refusal surfaced from a decision; an
empty queue is 0)
${why("channel-cli")}`;

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
                       operator holds outside the store; unset, the bytes come
                       from .approval/payloads/. Either way they are hashed and
                       checked against the recorded payload_hash
  --as human:<id>      the person deciding; defaults to APPROVAL_HUMAN.
                       REQUIRED at startup — this page exists to record
                       decisions, so a server whose buttons could not record
                       one is refused before the socket is bound (exit 2)
  --json               print the listening/stopped lines as JSON objects
  -h, --help           this text

Runs until interrupted (ctrl-c / SIGTERM). It is a PULL channel: nothing is
delivered anywhere, and the page is the notification surface.

BINDS 127.0.0.1 AND NOTHING ELSE, and there is NO AUTHENTICATION in v0.1: the
loopback interface IS the access control, and every decision is recorded against
--as / APPROVAL_HUMAN. The same caveat is printed in a banner on the page.
Fields are marked [computed]/[claimed] and every value is HTML-escaped; the full
payload is shown verbatim in a delimited block labelled with its bound sha256.
Batching is one gesture over a ticked set, and the log still records one event
per member. NO JAVASCRIPT REQUIRED.

THE EXECUTION TOKEN IS SHOWN ON THE PAGE, ONCE, and never written to the log, a
URL, or the --json stream.

JSON shape (stdout, one object per line):
  {"event":"listening","channel":"web","url":"http://127.0.0.1:4680/",
   "host":"127.0.0.1","port":4680,"actor":"human:alice"}
  {"event":"stopped","notified":3,"views":7,"decisions":2,"refused":1}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("channel-web")}`;

export const INIT_HELP = `approval init — scaffold a working directory (SPEC.md §10.1)

Usage:
  approval init [--dir <path>] [--json]

Flags:
  --dir <path>   directory to scaffold (default: the working directory)
  --json         machine-readable output
  -h, --help     this text

Writes four things into <dir> (default: the working directory):
  APPROVAL.md         SPEC.md §5.1's canonical policy, verbatim. A STARTING
                      POINT, not your policy: read every class before you sign
                      for it
  .approval/log/      the log DIRECTORY, empty. "approval policy attest" is what
                      creates events.jsonl
  .approval/QUEUE.md  the read-only queue projection in its empty state
  .gitignore          three lines merged under a "${GITIGNORE_MARKER}" marker:
                      ${GITIGNORE_ENTRY_LINES}

IT APPENDS NOTHING AND ATTESTS NOTHING, and IT NEVER OVERWRITES: init plans
every target first, writes only what is missing, and reports the rest in
"existing" with a per-file code (policy-exists, log-dir-exists, queue-exists,
gitignore-entries-present). .gitignore is the one file that is merged, and no
existing line is rewritten. .approval/payloads/ is deliberately NOT ignored:
those bytes are what each approval bound to.

A path of the WRONG KIND is a refusal, not a report: a directory named
APPROVAL.md, or a regular file where .approval/ belongs, exits 4 with
error.code "path-conflict" and NOTHING is written.

JSON shape (one object on stdout):
  {"ok":true,"dir","written":["APPROVAL.md",...],
   "existing":[{"path","code"}],"next_steps":["…"]}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("init")}`;

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
  autonomous class   allow, and NOTHING is appended
  supervised class   allow, after registering the task; no approval event exists
  manual class       register + request, then WAIT for a human decision. Allow
                     on granted; deny on rejected, revoked, expired or timeout
  gate.self          the "approval" CLI itself is pass-through

THE VERDICT IS NEVER "ask": a decision taken outside the log is a decision
nothing can audit. The classifier is BEST EFFORT and reads the command text and
nothing else, never the agent's self-reported "description".

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

EXIT 0 CARRIES THE VERDICT: allow and deny are both exit 0 with JSON on stdout,
because Claude Code reads stdout as a decision only on exit 0. Exit 2 is
reserved for a MISCONFIGURED hook, where blocking is the right failure mode.
See docs/claude-code-hook.md for the settings.json entry, which a HUMAN commits.

${EXIT_CODES_POINTER} (claude-code uses only 0 and 2, as above)
${why("hook")}`;

export const IMPORT_HELP = `approval import — turn existing permissions prose into a draft policy

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Commands:
  agents-md parse an AGENTS.md-style permissions section ("allowed without
            prompting" / "require approval first" / "never") into draft policy
            classes for a human to confirm (SPEC.md §12)

${EXIT_CODES_POINTER}
${JSON_ERRORS}`;

export const IMPORT_AGENTS_MD_HELP = `approval import agents-md — permissions prose -> draft policy classes

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Flags:
  --out <path>     write the draft YAML (without the fence) to <path> instead of
                   printing it. REFUSES to overwrite an existing file
  --json           machine-readable output
  -h, --help       this text

Reads one markdown file, finds its permissions section, and prints a DRAFT
\`\`\`yaml approval-policy block. THE DRAFT AUTHORIZES NOTHING: this verb never
writes APPROVAL.md, never appends to the log, never attests, and consults no
attestation. Review the draft, paste it into APPROVAL.md, and run
"approval policy amend".

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

Fail closed: a bullet the table cannot place is preserved verbatim as a comment
and listed under UNMAPPED; "never" bullets are rendered manual with a "# never:"
comment (v0.1 has no forbid level, and manual is not never); a class claimed by
two sections resolves to the STRICTER autonomy and both bullets are named in a
warning; unrecognised headings are reported, never silently skipped; a file with
no permissions section is exit 0 with an empty draft and a warning. No approvers
and no channels are generated.

--json prints:
  {"ok":true,
   "source":"<path as given>",
   "out":"<path>"|null,
   "classes":[{"class","autonomy","from","section"}],
   "unmapped":[{"text","section"}],
   "ignored":["<heading>"],
   "warnings":["<text>"]}
"from" is the bullet that DECIDED the autonomy (the stricter one on a conflict).

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("import-agents-md")}`;

export const PAYLOAD_HELP = `approval payload — work with the bytes an approval binds to

Usage:
  approval payload hash <file|-> [--json]

Commands:
  hash      print the payload_hash of a JSON document: SHA-256 over its RFC 8785
            canonical serialization (SPEC.md §6.2)

${EXIT_CODES_POINTER}
${JSON_ERRORS}`;

export const PAYLOAD_HASH_HELP = `approval payload hash — the content binding for a payload

Usage:
  approval payload hash <file|-> [--json]

Flags:
  --json           machine-readable output
  -h, --help       this text

Reads one JSON document from <file>, or from stdin when the argument is "-", and
prints its payload_hash: SHA-256 (lowercase hex) over the RFC 8785 (JCS)
canonical serialization of the parsed VALUE. This is the same function the
runtime uses, so the printed hash is byte-identical to the one a request and its
grant record. Reads no log, writes no file, appends nothing.

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
verifies the bytes. Reach for it when writing the declared payload_hash into a
task file, or when an adapter must present a binding for material this runtime
does not hold. Bytes that do not parse as JSON are a usage error (exit 2), not a
hash.

JSON shape (stdout, one object):
  {"ok":true,"hash":"<64hex>"}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("payload-hash")}`;

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
Every displayed field is visibly COMPUTED or CLAIMED, per SPEC.md §9; full
payloads are deliberately NOT inlined, because the queue collects no decision.

Deterministic: the evaluation instant is read once and handed to the pure
renderer. Writes exactly one file, atomically, and only that file. A log that
does not verify refuses (exit 1) and writes nothing.

JSON shape (stdout, one object):
  {"ok":true,"out":"/abs/.approval/QUEUE.md","bytes":2481,
   "head":{"seq":7,"hash":"<64hex>"},"pending":2,"skipped":0,
   "audit_backlog":0,"now":"2026-08-06T10:00:00.000Z"}
  head is null for an empty log. skipped counts live requests the renderer could
  not summarize (they are listed in the file with their reason, never dropped).
  refusal  {"ok":false,"error":{"code":"log-corrupt|log-torn-tail|
            log-unreadable|write-failed","message":"..."}} on stderr

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("render")}`;

// ---------------------------------------------------------------------------
// Channels (APRV-26)
// ---------------------------------------------------------------------------

export const TELEGRAM_HELP = `approval channel telegram — the Telegram push channel

Usage:
  approval channel telegram listen [--once] [--as human:<id>] [--payloads <f>]
                                   [--policy <path>] [--dir <path>]
                                   [--log <path>] [--api-base <url>]
                                   [--poll-timeout <seconds>] [--json]
  approval channel telegram health [--json]

Configuration is ENVIRONMENT-ONLY: APPROVAL_TG_TOKEN holds the bot token and
APPROVAL_TG_CHAT the approver chat id. APPROVAL.md carries only those variable
NAMES, and there is no flag that would put a bot token into a shell history.

Anyone in the configured chat can approve as the actor this process was started
with, so the chat's membership is part of your trust boundary. Use a private
chat with the bot.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("channel-telegram")}`;

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
                   action's payload value. Unset, the bytes come from
                   .approval/payloads/, filed by approval request --payload.
                   Either way they are re-hashed and checked against the
                   recorded binding; material that does not match is refused,
                   never rendered
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
VARIABLES (channels.telegram.token_env / chat_id_env, defaulting to
APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT). There is no flag for either value.

DELIVERY IS PER CYCLE, NOT ONLY AT STARTUP: before every getUpdates the listener
re-derives the pending queue from the verified log and sends what it has not
sent, so a request appended while it runs reaches the phone without a restart. A
failed send is retried on every later cycle. Each message carries the computed
fields, the agent's CLAIMED fields under their own heading, the full payload
verbatim, and an inline Approve/Reject keyboard.

A callback FROM THE CONFIGURED CHAT is recorded through the same human-only gate
the CLI verbs use. A callback from ANY OTHER chat is counted as an anomaly,
answered with a refusal, and NEVER written to the log. Delivery bookkeeping is
IN MEMORY ONLY: a restarted listener re-sends everything still pending.

THE EXECUTION TOKEN IS PRINTED ON THIS TERMINAL'S STDOUT AND IS NEVER SENT TO
TELEGRAM — a chat transcript is not a credential store. REJECT COLLECTS NO
REASON (an inline keyboard has no text input); use "approval reject --note" when
the reason matters. BATCHING IS DEFERRED.

Runs until interrupted, or with --once for a single batch. The loop survives the
network: timeouts, dropped sockets and 5xx are counted, complained about on
stderr, and retried with a doubling backoff.

JSON shape (stdout, ONE OBJECT PER LINE):
  {"event":"notified","action_key":"task-042:chaser","delivery_id":"41"}
  {"event":"decision","action_key":"task-042:chaser","decision":"grant",
   "ok":true,"seq":7,"state":"granted","token_issued":true}
  {"event":"decision","action_key":"...","decision":"grant","ok":false,
   "code":"already-decided","token_issued":false}
  {"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
   "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
   "key-mismatch":0}}
  The raw execution token is NEVER in the JSON stream.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("channel-telegram-listen")}`;

export const TELEGRAM_HEALTH_HELP = `approval channel telegram health — is this runtime configured for Telegram?

Usage:
  approval channel telegram health [--policy <path>] [--dir <path>] [--json]

Flags:
  --policy <path>  policy file naming the credential variables
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --json           machine-readable output
  -h, --help       this text

Reports whether the bot token and chat id variables are set. Exit 0 when both
are, 1 when either is missing. The token's VALUE never appears in the output.
WHICH VARIABLES ARE READ COMES FROM THE POLICY (channels.telegram.token_env /
chat_id_env, defaulting to APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT).

MAKES NO NETWORK CALL. The live counters — deliveries, decisions, ignored
callbacks, recovered poll errors — belong to a RUNNING listener.

JSON shape (stdout, one object):
  {"ok":true,"channel":"telegram","token_env":"APPROVAL_TG_TOKEN",
   "token_set":true,"chat_env":"APPROVAL_TG_CHAT","chat_id":"12345"}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("channel-telegram-health")}`;

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

${EXIT_CODES_POINTER}
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
pidfile, or manage its own lifecycle: backgrounding is the operator's business
in v0.1. A clean stop exits 0 and leaves no lockfile and no half-written queue.

Each tick, in order:
  ENVELOPE DRIFT   a task file whose state: contradicts the log gets an
                   envelope.drift event (actor system:daemon), once per claim
  TTL SWEEP        every live request whose TTL lapsed gets an approval.expired
                   through the same "approval expire" the CLI calls; idempotent
  WRITE-BACK       every task file whose state: still disagrees is rewritten to
                   match the log, AFTER those appends. Exactly the state: line
                   changes; a file the writer cannot round-trip safely is left
                   alone with a write-back-refused warning
  LOOP ESCALATION  tasks with three consecutive execution.failed are reported
                   when they escalate and when they clear
  QUEUE            .approval/QUEUE.md is regenerated through the same renderer
                   "approval render" uses, temp-then-renamed

Watching is a latency optimization, never a correctness dependency: every tick
re-scans the folder and re-derives everything from the verified log. A log that
does not verify STOPS the daemon rather than degrading it.

GIT EVIDENCE (--git-evidence, OFF BY DEFAULT). A second, independent record of
the same bytes. THE LOG HOME MUST BE ITS OWN REPOSITORY ROOT and must not sit
inside any outer working tree; a nested layout is REFUSED with log-dir-nested.
It never pushes, fetches, or names a branch, and a git failure is a warning.
Refusals at startup: git-unavailable and log-dir-missing exit 4;
log-dir-not-repo and log-dir-nested exit 2. See docs/git-evidence.md.

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
  payload retention: with payload_retention set in policy, each tick appends
  payload.pruned and THEN removes the payload file for every payload whose
  action has been terminal longer than the duration, and for orphaned store
  files. With the key absent nothing is ever pruned.
  "rendered" is emitted when the queue's summary CHANGES; the file itself is
  rewritten every tick, because TTL countdowns move even when the log does not.
  With --git-evidence, one further line per committing tick:
  {"event":"git_evidence","commit":"a1b2c3d","seq":10,
   "hash":"<sha256 of the head record>","records":2}
  and, on a git failure, {"event":"git_evidence_failed","step":"commit",
  "message":"..."} on STDERR. Neither ever stops the loop.

${EXIT_CODES_POINTER} (a clean stop is 0; 1 when the chain does not verify)
${JSON_ERRORS}
${why("daemon-run")}`;

// ---------------------------------------------------------------------------
// The vault (APRV-68)
// ---------------------------------------------------------------------------

/** One line, not a paragraph: the rest of the reasoning is in the reference. */
const VAULT_NO_GET = `THERE IS NO "approval vault get", and it is not an oversight: a credential's
only sanctioned journey is from the vault into an adapter, inside the
verified-token window. Names are visible; values are not.`;

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
APPROVAL_HUMAN. The file is AES-256-GCM over a JSON map of name -> credential,
under a scrypt key derived from the environment variable the policy names in
vault.passphrase_env (default APPROVAL_VAULT_PASSPHRASE). There is no
--passphrase flag, and nothing here APPENDS TO THE LOG.

${VAULT_NO_GET}

What the vault DEFENDS and what it does NOT defend — including the agent that
can read the passphrase variable, and a compromised host — is stated in full in
docs/cli-reference.md#vault. Read it before you decide what to keep here.

${EXIT_CODES_POINTER} (1 for anything the runtime decided — a wrong passphrase,
an altered file, a name the vault does not hold)
${JSON_ERRORS}
${why("vault")}`;

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

HUMAN-ONLY. THE VALUE IS NEVER A COMMAND-LINE ARGUMENT: there is no --value
flag, because a secret on a command line is a secret in the shell history and in
"ps". The value comes from STDIN:

  pass show smtp/app | approval vault set smtp-password
  approval vault set api-key <<'EOF'
  sk-live-…
  EOF

or from a variable named with --value-env:

  APPROVAL_TMP_SECRET="$(op read op://vault/item/field)" \\
    approval vault set api-key --value-env APPROVAL_TMP_SECRET

One trailing newline is stripped from stdin and nothing else; an empty value is
refused rather than stored. Every write re-encrypts the WHOLE map under a FRESH
nonce and lands atomically, so an interrupted write leaves the previous vault
intact.

${VAULT_NO_GET}

JSON shape (stdout, one object):
  {"ok":true,"name":"smtp-password","created":true,"count":2,
   "path":"/…/.approval/vault.enc"}
  created is false when the name was already present and has been replaced. The
  VALUE appears in no field, on either the success or the failure path.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("vault-set")}`;

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

HUMAN-ONLY. Prints the credential NAMES, sorted, with a count and the file path.
No value is printed on any path, including the failure paths.

A VAULT NOBODY CREATED IS A STATE, NOT A FAULT: when the file does not exist
this says so and exits 0, and the passphrase is not read at all. A wrong
passphrase and an altered file both refuse "vault-unreadable" and are NOT
distinguished.

JSON shape (stdout, one object):
  {"ok":true,"present":true,"path":"/…/.approval/vault.enc","count":2,
   "names":["api-key","smtp-password"]}
  and, for a vault that does not exist,
  {"ok":true,"present":false,"path":"…","count":0,"names":[]}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("vault-list")}`;

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

HUMAN-ONLY. A name the vault does not hold refuses "credential-absent" (exit 1)
rather than reporting success. The remaining credentials are re-encrypted under
a fresh nonce and written atomically. Removing a credential an adapter still
needs makes that adapter refuse credential-unavailable at execution time.

JSON shape (stdout, one object):
  {"ok":true,"name":"api-key","count":1,"path":"/…/.approval/vault.enc"}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("vault-remove")}`;

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
the action's idempotency_key AND its payload_hash. The runtime, not the adapter,
owns the sequence: recompute the hash, verify and consume the token, append
execution.started, call the adapter, append the outcome.

${EXIT_CODES_POINTER} (5 when no valid token was presented and nothing was sent;
1 for everything else the runtime decided)
${JSON_ERRORS}
${why("adapter")}`;

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
  recipient. Addresses are plain ASCII local@domain. Unknown keys are refused
  rather than ignored.

Two fields are stamped by the runtime and are NOT part of the hash:
  Date        the moment of the send
  Message-ID  SHA-256 over the action key and the payload hash, at the From
              domain — deterministic, so an operator holding the log can trace a
              bounce back to an approval

A non-ASCII body is sent quoted-printable and a non-ASCII subject as RFC 2047
encoded-words; an all-ASCII body is sent 8bit, byte for byte as approved.

Configuration comes from the VAULT, read inside the verified-token window and
from nowhere else: smtp.host smtp.port smtp.security smtp.user smtp.password.
smtp.security is "implicit", "starttls" (a MANDATORY upgrade) or "none", and a
credential is never sent over "none". Storing exactly one of user/password is
refused. No credential value reaches the log, this command's output, or an error
message.

Failure codes (in adapter_code):
  email-payload-invalid   the approved bytes are not a well-formed email
  email-config-invalid    the vault holds unusable SMTP configuration
  credential-unavailable | credential-refused
                          the vault could not supply a name. Nothing was sent
  smtp-connect-failed | smtp-tls-failed | smtp-timeout | smtp-protocol-error
  smtp-<NNN>              the server refused a verb; NNN is its own reply code
                          (smtp-535 authentication, smtp-550 mailbox, …)

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

${EXIT_CODES_POINTER} (5 when no valid token was presented; 1 for every refusal
including a refused send)
${JSON_ERRORS}
${why("adapter-email")}`;

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

No other verb loads that file (SPEC.md §11.1 invariant 7). The file is inert; a
human evaluating this output is what makes it take effect.

The file: one KEY=VALUE per line, # comments and blank lines ignored, no quoting
and no interpolation, mode 0600 (anything else is refused with the chmod to run),
and gitignored by "approval init". VALUE says WHERE the value lives:

  KEY=keychain:<service>       macOS: security find-generic-password -a "$USER"
                               -s <service> -w
  KEY=secret-service:<label>   Linux: secret-tool lookup approval <label>
  KEY=env:                     inherited from the shell that launched you
  KEY=<value>                  a plaintext literal — PERMITTED, and always
                               reported as plaintext by --check and by --json
  KEY=literal:<value>          the same, spelled out, for a value that begins
                               with something that looks like a scheme

A value with some other word: prefix is a LITERAL, not an error. Near misses of
the real schemes (keyring:, secret_service:, plaintext:, vault:, …) are reserved
and refused. THE VALUE IS NEVER PUT IN AN ARGV.

Which variables are answered for: APPROVAL_HUMAN, the Telegram token and chat id,
the vault passphrase, the sampling secret when one is named, and any other
string-valued key ending in _env anywhere in the loaded policy. ALREADY-EXPORTED
VALUES WIN, and are reported "set-in-environment". An ABSENT file is not an
error.

Exit 0 even when variables are unresolved, because the output is destined for
eval; unresolved variables are printed as # comments naming the repair. --check
is the path with an opinion: 1 when a variable the policy NAMED is unresolved.

JSON shape (stdout, one object):
  {"ok":true,"path":"/…/.approval/env","present":true,
   "variables":[{"name":"APPROVAL_TG_TOKEN","status":"resolved-from-keychain",
                 "source":"keychain:approval-tg","plaintext":false,
                 "declared":true,"value":"…","fix"?:"…","refusal"?:{…}}]}
  status is one of set-in-environment | resolved-from-keychain |
  resolved-from-secret-service | resolved-literal | unset. "value" is present
  only when there is one AND --check was not passed. "ok" is the --check verdict
  on every path.

${EXIT_CODES_POINTER} (4 when the file could not be read or its mode is not
0600; 1 when its contents were refused, or --check found a named variable
unresolved)
${JSON_ERRORS}
${why("env")}`;

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
  sampling  mint the audit sampling secret, store it, and print the policy line
            that turns sampling on
  channel   configure one CHANNEL's transport credential: for telegram, collect
            the bot token, prove it with getMe, discover the approver chat, and
            record both variables
  adapter   fill the VAULT with one ADAPTER's credentials, asked for from the
            manifest that adapter declares, and prove them against the service
            without sending anything

CHANNEL AND ADAPTER ARE TWO NOUNS, not one list (SPEC.md §4). A channel's setup
fills the OS keystore and .approval/env, the map of where the values that unlock
the machine live; an adapter's setup fills .approval/vault.enc, which holds the
values a gated adapter SPENDS. There is no verb that prints one back.

EVERY SUBCOMMAND REFUSES WHEN STDIN IS NOT A TERMINAL, and when --json is given,
and exits 2 printing the exact non-interactive commands to run instead.

WHAT IT WRITES, AND WHAT IT WILL NOT:
  writes  .approval/env (one KEY=VALUE line per variable, mode 0600, every other
          line and comment preserved) and items in the OS keystore
  never   appends to the log, attests anything, or edits APPROVAL.md. When a
          policy line is needed it prints the \`approval policy amend\` ceremony
          and stops

WHERE SECRETS GO:
  macOS (security on PATH)     keychain:<service>
  Linux (secret-tool on PATH)  secret-service:<service>
  neither                      offered as a PLAINTEXT literal in .approval/env,
                               taken only on a typed \`yes\`, and reported as
                               plaintext by \`approval env --check\` forever after

  approval-tg-token            the bot token
  approval-vault-passphrase    the vault passphrase
  approval-sampling-secret     the audit sampling secret

A VALUE YOU ALREADY HOLD IS NEVER HANDLED BY THIS PROCESS: the Telegram token is
collected by the keystore helper's OWN no-echo prompt. Values this runtime
GENERATES go to the helper on its stdin.

${EXIT_CODES_POINTER} (2 also means "this is interactive and your stdin is not a
terminal"; 1 means the far end refused)
${JSON_ERRORS}
${why("setup")}`;

export const SETUP_IDENTITY_HELP = `approval setup identity — declare who the human is

Usage:
  approval setup identity [--log <path>] [--dir <path>] [--policy <path>]

Asks for a \`human:<id>\` identity, validates it against the ^human:.+ pattern
\`policy attest\` enforces, and writes APPROVAL_HUMAN=human:<id> into
.approval/env. Nothing is appended to the log.

A BARE ID IS ENOUGH: answer \`alice\` and the line reads APPROVAL_HUMAN=human:alice.
An answer that does not fit gets one line saying why and the same question again;
Ctrl-C or Ctrl-D writes nothing.

NOT HUMAN-ONLY, unlike every other setup subcommand: a verb that required
APPROVAL_HUMAN before it would let you set APPROVAL_HUMAN could only be run by
someone who did not need it. The terminal is the control on this path.

Identity here is declared, not proved: whoever can set this variable and write to
the log can act as this human, and v0.1 makes no cryptographic claim about who
attested (SPEC.md §11).

The line it writes is INERT until you run \`eval "$(approval env)"\`. Refuses when
stdin is not a terminal, printing the export line to use instead.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("setup-identity")}`;

export const SETUP_VAULT_HELP = `approval setup vault — mint and store the vault passphrase (HUMAN-ONLY)

Usage:
  approval setup vault [--as human:<id>] [--log <path>] [--dir <path>]
                       [--policy <path>]

Generates 32 random bytes, base64-encodes them, stores the result in the OS
keystore as approval-vault-passphrase, and writes the source line for the
variable your policy names in vault.passphrase_env (APPROVAL_VAULT_PASSPHRASE by
default). The value is not printed here or anywhere else.

WARNS FIRST if .approval/vault.enc already exists: a vault cannot be re-keyed by
changing a variable, so every credential in it would become unreadable. The
warning comes before the generation, and the confirmation defaults to no.

The generated value reaches the keystore on the helper's STDIN. If this build of
the helper will not take stdin, the fallback passes it in an argv and says so.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("setup-vault")}`;

export const SETUP_SAMPLING_HELP = `approval setup sampling — mint the audit sampling secret (HUMAN-ONLY)

Usage:
  approval setup sampling [--as human:<id>] [--log <path>] [--dir <path>]
                          [--policy <path>]

Generates the operator-held secret that selects which supervised actions are
sampled for retrospective review (SPEC.md §5.2), stores it as
approval-sampling-secret, and writes its source line. Selection is HMAC-SHA-256
over the event hash under this secret; seeding from event content alone is
forbidden, because the agent authoring the event controls that content.

IF YOUR POLICY NAMES NO audit.sampling_secret_env, the secret is recorded under
the conventional name APPROVAL_SAMPLING_SECRET and SAMPLING STAYS OFF. This verb
does not edit an attested policy file: it prints the block to add and the
\`approval policy amend\` ceremony that attests it.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("setup-sampling")}`;

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
set\` reads it, and this verb does not resolve .approval/env — run \`approval
setup vault\` and then \`eval "$(approval env)"\` first. With the variable unset,
nothing is stored and no vault is created.

WHAT IT REPORTS: the path, the count, the names written and the names left
alone. Never a value, on any path, including a failed probe.

${EXIT_CODES_POINTER} (1 means the service refused the stored configuration, or
the vault would not open; the values are KEPT either way and the undo is
printed)
${JSON_ERRORS}
${why("setup-adapter")}`;

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
anything is stored.

THE PROBE SENDS NOTHING: it is the same SMTP session a send runs — connect,
EHLO, STARTTLS, AUTH — and then QUIT. It defaults to yes and can be declined;
declining stores the values and says they are unverified. A FAILED PROBE KEEPS
THE VALUES, prints the SMTP code and the server's first line with the credential
redacted, and prints the undo:

  approval vault remove smtp.password --as human:<id>

${EXIT_CODES_POINTER} (1 means the server refused, or the vault would not open
with the passphrase in your environment)
${JSON_ERRORS}
${why("setup-adapter-email")}`;

export const SETUP_CHANNEL_HELP = `approval setup channel — configure one channel's transport credential (HUMAN-ONLY)

Usage:
  approval setup channel <name> [--as human:<id>] [--api-base <url>]
                                [--log <path>] [--dir <path>] [--policy <path>]

Known channels:
  telegram  the bot token and the approver chat: APPROVAL_TG_TOKEN and
            APPROVAL_TG_CHAT, or the names channels.telegram.token_env /
            chat_id_env declare

A CHANNEL IS NOT AN ADAPTER, and the two setup verbs fill different stores. A
channel needs a transport credential: it goes into the OS keystore, and
.approval/env records where. An adapter holds the credentials a side effect
spends, so \`approval setup adapter <name>\` fills the vault instead.

An older build spelled the Telegram one without the \`channel\` noun. That form
exits 2 and names this one; there is deliberately no alias.

${EXIT_CODES_POINTER} (2 also means "this is interactive and your stdin is not a
terminal"; 1 means the far end refused)
${JSON_ERRORS}
${why("setup-channel")}`;

export const SETUP_CHANNEL_TELEGRAM_HELP = `approval setup channel telegram — the bot token and the approver chat (HUMAN-ONLY)

Usage:
  approval setup channel telegram [--as human:<id>] [--api-base <url>]
                                  [--log <path>] [--dir <path>] [--policy <path>]

Five steps: store the token, prove it with getMe, WAIT for you to message the
bot, read the chat id back, and write both variables (the names come from
channels.telegram.token_env / chat_id_env, or the defaults).

The wait is a continuous long poll of up to 90 seconds, so when you send the
message does not matter and no Enter is asked for; Ctrl-C stops it. If nothing
arrives it asks getWebhookInfo and prints what Telegram says about this bot.

STOP \`approval channel telegram listen\` FIRST. Two processes long-polling one
bot is a 409 from the Bot API, and the loser is whichever asked second.

THE TOKEN IS NEVER TYPED INTO THIS PROCESS on a machine with a keystore: the
helper's own no-echo prompt collects it. With no keystore, it is read with no
echo and — after a typed \`yes\` — written as a plaintext literal. The chat id is
written as a LITERAL: a chat id is not a secret; the token is.

NO getUpdates FROM THIS VERB CARRIES AN OFFSET, EVER. An offset is an
ACKNOWLEDGEMENT, and a decision tap consumed here would never reach the listener
waiting for it. allowed_updates is ["message"], so a pending callback_query is
not even delivered here.

HUMAN-ONLY, and enforced: it stores a credential and writes .approval/env. --as
expects a human:<id>; an agent: or system: actor is refused at exit 2.

${EXIT_CODES_POINTER} (1 means the far end refused: an invalid token, a 409 from
a running listener, or no message reaching the bot before the deadline)
${JSON_ERRORS}
${why("setup-channel-telegram")}`;

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

${EXIT_CODES_POINTER} (2 here is a startup refusal: no agent identity, a human:/system: identity, an
  unknown flag, or an unknown subcommand; 0 is a clean shutdown)
${JSON_ERRORS}`;
