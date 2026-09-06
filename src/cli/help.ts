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
  approval adapter agentmail <action-key> --token <t> --payload <file|->
                      [--as <id>] [--vault <path>] [--timeout <ms>] [--json]
  approval execution resolve <action-key> --outcome completed|failed
                      --note "<text>" [--as human:<id>] [--json]
  approval execution reconcile <action-key>
                      --resolution executed|not-executed
                      --note "<evidence>" [--as human:<id>] [--json]
  approval audit list|review [<seq|action-key>] [--note "<text>"]
                      [--as human:<id>] [--all] [--json]
  approval wait       <task> --timeout <duration> [--interval <d>]
                      [--withdraw-on-timeout] [--json]
  approval withdraw   <task> --action <key> [--reason <r>] [--note "<text>"]
                      [--as <id>] [--json]
  approval queue      [--policy <path>] [--dir <path>] [--json]
  approval coverage   [--base <ref>] [--head <ref>] [--since <duration>]
                      [--source git,gh,agentmail] [--json]
  approval channel cli [--policy-dir <path>] [--payload-dir <path>]
                      [--as human:<id>] [--interactive] [--json]
  approval channel web [--port <n>] [--payload-dir <path>] [--as human:<id>]
                      [--policy <path>] [--dir <path>] [--log <path>] [--json]
  approval channel telegram listen|health [--once] [--as human:<id>] [--json]
  approval daemon run [--tasks <dir>] [--out <path>] [--interval <duration>]
                      [--debounce <duration>] [--once] [--with-channels] [--json]
  approval up         [--as human:<id>] [--port <n>] [--no-telegram] [--no-web]
                      [--restart-backoff <d>] (plus every daemon run flag)
  approval setup service [--platform launchd|systemd] [--uninstall]
                      [--label <name>] [--logs <dir>] [--env-file <path>]
  approval gate open|close|status [--for <d>] [--reason "<t>"] [--note "<t>"]
                      [--as human:<id>] [--log <path>] [--json]
                                              (open: terminal only, no --json)
  approval status     [--policy <path>] [--dir <path>] [--json]
  approval doctor     [--log <path>] [--policy <path>] [--dir <path>]
                      [--api-base <url>] [--json]
  approval payload hash <file|-> [--json]
  approval payload agentmail-draft <inbox-id> <draft-id> [--api-base <url>]
                      [--json]
  approval journal write --message "<text>" | - [--task <id>] [--session <id>]
                      [--as <id>] [--journal <dir>] [--json]
  approval journal read [--limit <n>] [--since <YYYY-MM-DD>] [--journal <dir>]
                      [--json]
  approval values     [--policy <path>] [--dir <path>] [--json]
  approval feedback   [--task <id>] [--actor <agent id>] [--reaction <word>]
                      [--source review|decision] [--since <YYYY-MM-DD>]
                      [--limit <n>] [--log <path>] [--json]
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
  approval hook cursor [--as agent:<id>] [--timeout <duration>]
                      [--interval <d>] [--policy <path>] [--dir <path>]
                      [--log <path>]                    (reads preToolUse JSON)
  approval hook classify [--json] [--policy <path>] [--dir <path>] -- <command…>
  approval import agents-md <file> [--out <path>] [--json]
  approval mcp serve  --as agent:<id> [--dir <path>] [--log <path>]
                      [--policy <path>]              (MCP over stdio; foreground)
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval render     [--log <path>] [--out <path>] [--policy <path>]
                      [--dir <path>] [--json]
  approval --help

Set up — make this directory and this machine ready:
  init      scaffold a working directory: APPROVAL.md (SPEC.md §5.1's canonical
            policy, to be read and edited), the empty .approval/log/ directory,
            .approval/QUEUE.md in its empty state, and the .gitignore lines for
            the index, the vault, the environment source map and the
            atomic-write temp files. Appends
            nothing, attests nothing, overwrites nothing; a re-run writes
            nothing and reports what already exists
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
  env       resolve .approval/env — the environment SOURCE MAP — and print an
            export block for your shell to evaluate. THE ONLY VERB THAT READS
            THAT FILE: no command loads it implicitly, because human identity is
            one of the variables it carries and a working-tree file any process
            read on its own would let anything able to write it act as you. The
            default output carries secrets by design; "env --check" prints a
            table with no values on any path
  policy    explain what APPROVAL.md does with an action class (check | test),
            record a human's sign-off on the policy file (attest), or run the
            whole amendment ceremony — semantic diff, load advisory,
            attestation, and the two-file git commit — as one verb (amend)
  import    "import agents-md" parses an AGENTS.md-style permissions section
            into DRAFT policy classes for a human to confirm (SPEC.md §12). It
            prints; it never writes APPROVAL.md, never logs, never attests

Ask — an agent declares an action and acts on the answer:
  instructions
            the full AGENT-FACING usage guide: what to declare before acting,
            the register -> request -> wait -> run sequence, what a refusal
            means, and the invariants an agent must not route around. With
            --schemas it prints the verb registry as JSON — purpose, input and
            output schemas, exit codes and the human-only marker for every verb
            — which is the same source the optional MCP wrapper (SPEC.md §10.5)
            builds its tools from. Reads nothing, writes nothing
  register  validate a task envelope and append task.registered
  request   ask the gate to admit a declared action (manual classes append
            approval.requested; supervised/autonomous append nothing and
            proceed straight to execution, per amended SPEC.md §6.3)
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
            execution events around the send. "adapter agentmail" serves the
            same class over the AgentMail API: a direct send, or the send of a
            draft the agent composed, refused if the draft changed after the
            snapshot a human approved
  wait      block until a task's requests are decided; the exit code IS the
            decision (0 granted, 1 rejected/revoked/withdrawn, 3 expired, 6 timeout)
  withdraw  take back your OWN pending request (timeout, cancelled, superseded);
            terminal, requester-only, and a late grant then authorizes nothing
  hook      put the gate in front of an agent HARNESS. "hook claude-code" and
            "hook cursor" each read their harness's pre-tool event on stdin,
            classify the command or protected-path edit it is about to run,
            resolve the class against APPROVAL.md, and answer allow or deny —
            waiting on a real approval decision when the class is manual. They
            never answer "ask": a decision taken outside the log is a decision
            nothing can audit. "hook classify" prints what the classifier makes
            of a command and touches nothing
  journal   the one channel the gate does NOT stand in front of. "journal write"
            appends free text to a local file — ungated, unclassified, never
            approvable and never deniable, with no event in the log — so an
            agent can say "I am complying and I think this is wrong", "this
            reads as odd to me", or "I am stuck" even when it is complying
            perfectly. "journal read" is the human side, and it labels every
            entry as agent-authored DATA. Nothing written there changes any
            verdict, sampling probability or budget; it is signal for the
            operator, not a decision surface
  values    the mirror of "journal", running the other way: the operator's own
            words, in the optional values block of APPROVAL.md. What they value
            in the work, what they want from an agent, and how they read and
            answer. It is GUIDANCE and never policy: it grants nothing, forbids
            nothing, and no enforcement path reads it. A file with no block says
            so in words, because "nothing was declared" and "I did not look" are
            different facts
  feedback  the same channel in the other direction: what the OPERATOR said
            about the work. Lists the reactions and notes a person wrote on a
            grant or on a retrospective review, joined to the class, the task,
            the action key and the agent it was about. HUMAN-AUTHORED GUIDANCE
            and never policy — it grants nothing, forbids nothing, and changes
            no verdict, sampling probability or budget. Reads a verified log
            and writes nothing
  mcp       "mcp serve" is the optional MCP wrapper of SPEC.md §10.5: the same
            verbs as tools, over stdio, sharing the CLI's code paths. It is
            AGENT-FACING ONLY — grant, reject, revoke, attest, amend, vault,
            setup, audit review, expire, execution resolve|reconcile and the
            channels are not published, because an MCP client is an agent's
            harness and SPEC.md §11 makes the agent the untrusted policy. It
            runs as ONE agent identity, fixed at startup, that nothing changes

Decide — a human answers, and only a human can:
  queue     the pending-decision INBOX: requests awaiting a human, inside their
            TTL. Nothing else — exit 0 always when the log could be read
  grant     record a human approval          (HUMAN-ONLY)
  reject    record a human refusal           (HUMAN-ONLY)
  revoke    withdraw an unexecuted approval  (HUMAN-ONLY)
  expire    lapse a request whose TTL passed (system verb, actor system:gate)
  execution recovery verbs for executions the runtime could not close itself.
            "execution resolve" records the outcome a HUMAN OBSERVED for a
            dangling execution: mandatory --note, human-only, exit_code null,
            attested_by_human true. "execution reconcile" records what a human
            ESTABLISHED about an INDETERMINATE one — a side effect that was
            attempted and whose outcome nobody knows — from the relying party's
            evidence, naming the record it resolves and rewriting nothing.
            Neither requires attestation: both record a fact a human observed
            and exercise no policy authority
  audit     "audit list" is the open sampled-audit backlog and "audit review" is
            the HUMAN-ONLY verb that closes one item of it. Sampling itself has
            no verb: the daemon selects supervised actions with an operator-held
            secret, because a caller who could sample could also decline to
            sample itself
  channel   put pending requests in front of a human over the channel contract.
            "channel cli" renders the queue with [computed]/[claimed] markers and
            the full payload in delimiters, and with a terminal collects
            decisions through the same human-only gate as grant/reject.
            "channel telegram listen" delivers the queue to a Telegram chat on
            every poll cycle (including requests that arrive while it runs) and
            long-polls for Approve/Reject taps; config is environment-only
            (APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT)

Inspect — what the log says, and whether anything needs repair:
  log       inspect the append-only event log (verify | tail | export)
  status    system HEALTH: attestation, dangling executions, budget headroom,
            the latest chain verdict, loop escalations. Exit 1 when any of
            those needs attention. queue is what a human must answer; status is
            what an operator must fix, and neither carries the other's content
  coverage  what the witnesses this project does NOT write (git, gh, a
            provider's own record) say happened, joined to the verified log:
            per effect, the evidence seq or none. INFORMATIONAL — exit 0 with
            or without gaps, because a coverage measurement is not a verdict
  doctor    is this ENVIRONMENT sane? build freshness, declared identity, policy
            attestation, chain health, the Telegram token, the web port — each
            with a concrete repair. status asks whether the SYSTEM needs
            attention; doctor asks whether the machine you are typing on can run
            the system at all. Appends nothing, sends nothing, repairs nothing
  render    regenerate .approval/QUEUE.md, the READ-ONLY markdown queue
            projection (SPEC.md §9.1): pending requests and the sampled-audit
            backlog, computed and claimed fields visibly distinguished. The
            screenshot, never the truth — editing it authorizes nothing
  reindex   rebuild the SQLite index projection from the log
  payload   "payload hash" prints the payload_hash of a JSON document (SHA-256
            over its RFC 8785 canonical serialization), the value a declaration
            carries and a grant binds to. Most flows never need it: "request
            --payload" hashes, verifies and stores the bytes in one step.
            "payload agentmail-draft" snapshots one AgentMail draft with the
            AGENT's key, so a human approves the words and not a draft id
  daemon    "daemon run" is the watch loop of SPEC.md §10.2, in the FOREGROUND:
            it records envelope.drift when a task file's state: contradicts the
            log, appends approval.expired for lapsed requests, writes the log's
            state back into the task files, regenerates QUEUE.md, and surfaces
            loop escalations. It holds no lock; backgrounding is the operator's
            business in v0.1
  up        the AMBIENT RUNTIME: that same daemon loop plus every channel the
            policy configures, in ONE supervised foreground process. A channel
            whose credential is unset is not started and says so in doctor's
            vocabulary; a channel that falls over is restarted with a doubling
            backoff and the daemon loop carries on. "approval setup service"
            writes the launchd or systemd user unit that runs it at login

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
  journal .approval-journal/YYYY-MM-DD.jsonl  (the ungated free-text channel of
         "journal write". OUTSIDE the approval home on purpose: everything under
         .approval/ is the gate's own, and an outlet the gate could close is not
         an outlet. Nothing the runtime reads is ever stored there. Gitignored)
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
  --schemas    print the VERB REGISTRY as JSON instead of the guide: purpose,
               input schema, --json output schema, error shape, exit codes and
               human_only marker for every verb. Always JSON
  --json       print the guide as {"guide":"<text>","verbs":[…]}
  -h, --help   this text

Prints what an agent needs to know before it acts: the register -> request ->
wait -> run sequence, what a refusal means, and the invariants that are enforced
rather than requested. Reads no log, resolves no policy, writes nothing.

${EXIT_CODES_POINTER} (instructions uses only 0 and 2)
${JSON_ERRORS}
${why("instructions")}`;

export const LOG_HELP = `approval log — read the append-only event log, and move it

Usage:
  approval log verify  [--log <path>] [--json]
  approval log tail    [--log <path>] [-n <count>] [--json]
  approval log export  [--log <path>] [--json]
  approval log sync    [--remote <name>] [--branch <name>] [--json]
  approval log advance [--branch <name>] [--pr] [--dry-run] [--json]
  approval log checkpoint --as human:<id> [--key-file <path>] [--json]

Subcommands:
  verify   walk the hash chain end to end; clean | torn-tail | corrupt
  tail / export   the last N records (default 10) / every line, verbatim
  sync     fast-forward pull, with a snapshot and a chain reconcile
  advance  commit the log's new records onto a records branch
  checkpoint  sign the current head with your own key (human-only)

verify, tail and export only read. sync and advance move the FILE and append no
record; checkpoint appends one. Default log: .approval/log/events.jsonl
JSON shapes: docs/cli-reference.md

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("log")}`;

export const LOG_SYNC_HELP = `approval log sync — fast-forward the committed log, safely

Usage:
  approval log sync [--remote <name>] [--branch <name>] [--json]

Flags:
  --remote <name>  remote to fetch from (default origin)
  --branch <name>  branch to fast-forward onto (default: the checked-out one)
  --json           machine-readable output
  -h, --help       this text

Holds the append lockfile for the WHOLE operation, verifies the chain, copies
events.jsonl aside (never \`git stash\`), fast-forwards, then reconciles: the
committed chain must be a prefix of the snapshot, equal to it, or an extension,
and anything else is log-diverged. Untracked payloads the incoming commit also
carries are proved byte-identical and stood aside for it. QUEUE.md and the index
are REBUILT; no event is appended. PRIMARY CHECKOUT ONLY.
Refusals: log-sync-not-primary, log-sync-unverified, log-sync-not-fast-forward,
log-sync-payload-mismatch, log-diverged, log-sync-locked, log-sync-git-failed,
log-sync-projection-failed, log-sync-restore-failed, log-sync-io.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("log-sync")}`;

export const LOG_ADVANCE_HELP = `approval log advance — commit and push the log's new records

Usage:
  approval log advance [--remote <n>] [--branch <n>] [--base <n>] [--pr]
                       [--dry-run] [--json]

Flags:
  --remote <name>  remote to push to (default origin)
  --branch <name>  records branch (default records-log-<date>); never main
  --base <name>    branch to parent the commit on (default: the one you are on)
  --pr / --dry-run   open the pull request through gh / write nothing at all
  --json / -h, --help   machine-readable output / this text

Verifies the chain under the append lock, FETCHES the base branch, builds a
commit on <remote>/<base> carrying EXACTLY the log, QUEUE.md and payloads, and
pushes it by refspec. You do not fetch or reset first; the checkout is left as
found, nothing is checked out, no event is appended, and any other staged path
is refused. PRIMARY CHECKOUT ONLY. Refusals, each prefixed log-advance-:
not-primary, dirty-stage, checkout-required, unverified, locked, fetch-failed,
behind-remote, remote-diverged, git-failed, push-rejected, pr-failed.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("log-advance")}`;

export const VERIFY_HELP = `approval log verify — verify the log's hash chain

Usage:
  approval log verify [--log <path>] [--anchor] [--checkpoints] [--json]

Flags:
  --log <path>        log file to verify (default .approval/log/events.jsonl)
  --anchor [--anchor-rev <rev>]   compare the prefix against the committed copy
  --checkpoints       also demand every human-signed checkpoint in range
  --json / -h, --help   machine-readable output / this text

Walks every complete line: re-derives each record's digest, follows the prev
chain and seq succession, and names where the log stops being self-consistent.
An absent file verifies clean; nothing is written and a torn tail is not cut.
--anchor compares the prefix against the committed copy; --checkpoints demands
that every log.checkpoint verify under audit.checkpoint_keys and name the hash
this log carries. Either mismatch refuses; a missing witness skips, never passes.

JSON: "status" clean|torn-tail|corrupt|anchor-diverged|checkpoint-invalid, plus
"records", "head" and optional anomalies/anchor/checkpoints. ANOMALIES ARE CLEAN.

${EXIT_CODES_POINTER} (clean 0, corrupt 1, torn-tail 3; an unreadable log is 4)
${JSON_ERRORS}
${why("log-verify")}`;

export const LOG_CHECKPOINT_HELP = `approval log checkpoint — sign the log's head, by hand

Usage:
  approval log checkpoint --as human:<id> [--key-file <path>] [--json]

Flags:
  --as human:<id>    who is signing; or set APPROVAL_HUMAN
  --key-file <path>  read the signing key from this file instead of the vault
  --log <path>       log file to checkpoint (default .approval/log/events.jsonl)
  --json / -h, --help   machine-readable output / this text

Signs the CURRENT chain head with your Ed25519 checkpoint key and appends one
log.checkpoint record naming (seq, hash) and the signature. The key comes from
the vault credential approval.checkpoint.key; its PUBLIC half belongs in
APPROVAL.md under audit.checkpoint_keys, which only you may edit. HUMAN-ONLY:
an agent that could sign one could vouch for a chain it had just written.

The chain is unkeyed, so anyone who can write events.jsonl can recompute a
forgery that walks clean from genesis. What they cannot do is re-sign the
hashes they replaced, which is what \`log verify --checkpoints\` then catches.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("log-checkpoint")}`;

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
${JSON_ERRORS}
${why("log-tail")}`;

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
${JSON_ERRORS}
${why("log-export")}`;

/**
 * The policy command's exit-code stance, printed in all three policy help
 * texts. It is the one place where "answer" and "error" come apart: `policy
 * check` answers the question "what would policy do with this class", and a
 * policy too broken to load has a perfectly good answer — manual, everything,
 * always. The long version is docs/cli-reference.md#policy.
 */
const POLICY_EXIT_CODES = `${EXIT_CODES_POINTER}. policy check|test uses only 0, 2 and 4:
  0  the question was answered, INCLUDING the fail-closed answer: a broken
     policy IS a manual-everything policy, delivered on stdout at exit 0.
  2  usage — a missing <class>, an unknown flag, or an invalid action class.
  4  I/O — a policy path that exists but cannot be read.`;

/** The three values of manualBecause, named so an agent can branch on them. */
const POLICY_MANUAL_BECAUSE = `manualBecause is "matched-rule", "irreversibility-floor" or "load-failure".`;

export const POLICY_HELP = `approval policy — explain what policy does with an action class

Usage:
  approval policy check|test <class> [--reversible true|false] [--policy <p>]
                             [--dir <p>] [--json]
  approval policy attest [--policy <p>] [--dir <p>] [--as human:<id>] [--json]
  approval policy amend  [--policy <p>] [--dir <p>] [--log <p>] [--as human:<id>]
                         [--require-load] [--dry-run] [--commit] [--yes] [--json]

Subcommands:
  check   explain the autonomy resolution for <class>
  test    exact alias of check (SPEC.md §10.1 names both)
  attest  record a human's sign-off on the policy file's bytes (human-only)
  amend   the whole amendment ceremony: diff, advisory, attestation, commit

Nothing is executed, requested, or logged: this reads APPROVAL.md and answers a
hypothetical. Discovery is APPROVAL.md then APPROVALS.md in --dir.
${POLICY_MANUAL_BECAUSE}

${POLICY_EXIT_CODES}
${why("policy")}`;

function policyVerbHelp(verb: "check" | "test", alias: "check" | "test"): string {
  return `approval policy ${verb} — explain what policy does with an action class

Usage:
  approval policy ${verb} <class> [--reversible true|false] [--policy <p>] [--dir <p>] [--json]

Flags:
  --reversible <true|false>   whether the action can be undone. Omitted leaves
                   the question open; false engages the irreversibility floor
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --json / -h, --help   machine-readable output / this text

An exact alias of \`policy ${alias}\`; <class> is a concrete action class
(lowercase dotted segments, e.g. vcs.push.main), never a pattern.
${POLICY_MANUAL_BECAUSE}

JSON shape (class, outcome, provenance, manualBecause, loadFailure, matched,
overridden, candidates, "decisionPath"): docs/cli-reference.md#policy-check
${POLICY_EXIT_CODES}
${JSON_ERRORS}
${why("policy-check")}`;
}

export const POLICY_CHECK_HELP = policyVerbHelp("check", "test");
export const POLICY_TEST_HELP = policyVerbHelp("test", "check");

export const POLICY_ATTEST_HELP = `approval policy attest — record a human's sign-off on the policy file

Usage:
  approval policy attest [--policy <path>] [--dir <path>] [--organ <path>]
                         [--as human:<id>] [--log <path>] [--json]

Flags:
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --organ <path>   attest a GATE ORGAN instead; one path per call, under --dir
  --as human:<id>  the human attesting; overrides APPROVAL_HUMAN
  --log <path>     log file to append to (default .approval/log/events.jsonl)
  --json           machine-readable output
  -h, --help       this text

Appends one policy.updated event carrying the SHA-256 of the policy file's exact
bytes; gate operations refuse while it differs ("policy-not-attested").
Human-only, identity CONFIG-DECLARED: the trust boundary is the local machine,
so it proves someone with local control signed off, not who. Bytes, not parse.
--organ appends gate.organ.attested for a policy.core harness file instead.

JSON shape: docs/cli-reference.md#policy-attest
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("policy-attest")}`;

export const POLICY_AMEND_HELP = `approval policy amend — the whole amendment ceremony, in one verb

Usage:
  approval policy amend [--policy|--dir|--log <p>] [--as human:<id>|agent:<id>] [--require-load]
      [--dry-run] [--commit] [--no-publish] [--yes] [--json] [--branch <n>|--direct] [--wait <d>]

Flags:
  --policy <p> / --dir <p> / --log <p>  policy, its discovery dir, and the log
  --as human:<id> / agent:<id>    attest HERE, or ask for a TAP (--wait/--interval/--note)
  --require-load                  refuse to attest a policy that does not load
  --dry-run / --commit / --no-publish   write nothing / the ceremony / stop at commit
  --branch <name> / --direct      force the BRANCH or the DIRECT flow
  --yes / --json / -h, --help     skip the prompt / machine-readable / this text

Hashes the live policy, diffs it against the BASELINE (classes AND every policy key), attests, then
runs a git ceremony of EXACTLY two files, commit-preconditions first (git-failed, push-rejected,
pr-failed break after the append). Attested TEXT is NOT recoverable from the log: no blob means
HASH-ONLY MODE. Flows, in PRECEDENCE, highest first: --branch <name>, --direct; a refused push
PUBLISHES ITSELF without moving your checkout, dropping to a RUNBOOK; merge by MERGE COMMIT.
--as agent: appends policy.proposed; the TAP attests. Fail closed: no-channel, declined, timeout.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("policy-amend")}`;

/**
 * The gate verbs' refusal vocabulary and the one line they add to the root's
 * table. The vocabulary itself is frozen public API and is listed in full at
 * docs/cli-reference.md#gate-refusal-codes; what a per-verb help prints is the
 * pointer to it, plus the fact that a refusal is 1 and not 2.
 */
const GATE_CODES_POINTER = `Refusal codes (frozen public API): docs/cli-reference.md#gate-refusal-codes
${EXIT_CODES_POINTER}. A GATE REFUSAL IS 1, NOT 2: the command was well-formed
and the runtime said no. Branch on error.code, not on the exit code.`;

/** The same two facts for the verbs that speak the token vocabulary. */
const TOKEN_CODES_POINTER = `Refusal codes (frozen public API): docs/cli-reference.md#token-refusal-codes
${EXIT_CODES_POINTER}. A GATE REFUSAL IS 1, NOT 2: the command was well-formed
and the runtime said no. Branch on error.code, not on the exit code.`;

export const REGISTER_HELP = `approval register — validate a task envelope and record it

Usage:
  approval register <task-file> [--as human:<id>|agent:<id>] [--log <path>]
                    [--json]

Flags:
  --as <id>        who is registering; human:<id> or agent:<id>, else
                   APPROVAL_HUMAN. Registration is a proposal, not a decision
  --log <path>     log file to append to (default .approval/log/events.jsonl)
  --json           machine-readable output
  -h, --help       this text

Reads the task file's YAML frontmatter, validates the value of its \`approval:\`
key against envelope.schema.json, and appends one task.registered event carrying
the declared actions. FAIL CLOSED: an invalid envelope appends nothing. The file
is READ ONLY, and registering the same task id twice is refused.

JSON shape: docs/cli-reference.md#register
${GATE_CODES_POINTER}
${JSON_ERRORS}
${why("register")}`;

export const REQUEST_HELP = `approval request — ask the gate to admit a declared action

Usage:
  approval request <task> --action <key> [--as human:<id>|agent:<id>]
                   [--payload <file>|-] [--policy <path>] [--dir <path>]
                   [--log <path>] [--json]

Flags:
  --action <key>   the action's idempotency_key, as registered (required)
  --as <id>        human:<id> or agent:<id>; else APPROVAL_HUMAN
  --payload <file|-> the payload bytes, hashed and filed in the payload store
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --json           machine-readable output
  -h, --help       this text

Class and cost come from the task.registered record in the log. APPROVAL EVENTS
ARE EXCLUSIVE to the manual path: a non-manual action reports proceed:true.

JSON shape: docs/cli-reference.md#request
${GATE_CODES_POINTER}
${JSON_ERRORS}
${why("request")}`;

function decisionHelp(verb: "grant" | "reject" | "revoke"): string {
  const noun = verb === "grant" ? "approval" : verb === "reject" ? "refusal" : "withdrawal";
  const body =
    verb === "grant"
      ? `Appends one approval.granted, MINTS the single-use execution token and PRINTS
IT ONCE. HUMAN-ONLY. Legal only on a request awaiting a decision; attestation is
required, budgets re-evaluated; loved/disliked need --note; read back: feedback.`
      : verb === "reject"
        ? `Appends one approval.rejected. HUMAN-ONLY. Legal only on a request awaiting a
decision, and a second decision is refused. No attestation is required and no
budget is charged: an authorization refused was never a commitment.`
        : `Appends one approval.revoked. HUMAN-ONLY. Legal only on a GRANTED request that
has not executed. No attestation is required and no budget is charged: an
authorization withdrawn was never a commitment.`;

  return `approval ${verb} — record a human ${noun} (HUMAN-ONLY)

Usage:
  approval ${verb} <action-key> [--note <text>]${
    verb === "grant" ? " [--reaction <w>]" : ""
  } [--as human:<id>]
                 [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --note <text>    free-text note recorded in the event payload${
    verb === "grant"
      ? "\n  --reaction <w>   disliked|indifferent|liked|loved. GUIDANCE, never policy"
      : ""
  }
  --as human:<id>  the deciding human; overrides APPROVAL_HUMAN
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --log <path>     log file to read and append to
  --json / -h, --help              machine-readable output / this text

${body}

JSON shape: docs/cli-reference.md#${verb}
${GATE_CODES_POINTER}
${JSON_ERRORS}
${why(verb)}`;
}

export const GRANT_HELP = decisionHelp("grant");
export const REJECT_HELP = decisionHelp("reject");
export const REVOKE_HELP = decisionHelp("revoke");

export const WITHDRAW_HELP = `approval withdraw — take back your own pending request

Usage:
  approval withdraw <task> --action <key> [--reason <r>] [--note <text>]
                    [--as <id>] [--policy <p>] [--dir <p>] [--log <p>] [--json]

Flags:
  --action <key>   the action's idempotency_key (required)
  --reason <r>     timeout | cancelled | superseded (default cancelled)
  --note <text>    free-text elaboration recorded in the event payload
  --as <id>        human:<id> or agent:<id>; else APPROVAL_HUMAN
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --json           machine-readable output;  -h, --help   this text

Appends one approval.withdrawn. REQUESTER-ONLY (else not-requester) and
PENDING-ONLY; terminal, so a later decision is refused request-withdrawn.
Withdraw when you can no longer consume an answer. A human REJECTS instead.

JSON shape: docs/cli-reference.md#withdraw
${GATE_CODES_POINTER}
${JSON_ERRORS}
${why("withdraw")}`;

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
accepted or resolved: no human decides an expiry, the clock does. Refused when
the request is not live, and when the TTL has not lapsed.

JSON shape: docs/cli-reference.md#expire
${GATE_CODES_POINTER}
${JSON_ERRORS}
${why("expire")}`;

export const GATE_WINDOW_HELP = `approval gate — the open window: a human-only, time-boxed harness bypass

Usage:
  approval gate open   [--for <duration>] --reason "<text>" [--as human:<id>]
                       [--log <path>]                     (terminal; no --json)
  approval gate close  [--note "<text>"] [--as human:<id>] [--log <path>] [--json]
  approval gate status [--log <path>] [--json]

Flags:
  --for <duration>  how long the window stands; default 30m, cap 24h
  --reason "<text>" why it is being opened; required, and recorded
  --note "<text>"   what was learned, recorded on the close
  --as human:<id>   the person opening or closing it (or ${"APPROVAL_HUMAN"})
  --log <path>      log file to read and append to; --json for status and close

While a window is open the harness hook ALLOWS every gated tool call under the
root and records each as gate.bypassed, ahead of the policy, attestation, the
loop floor and the human gate. It never reaches .approval/log/, a human-only
class, a command the classifier cannot read, or a log it cannot verify. open is
a ceremony: a terminal, and the word \`understood\` typed in full. There is no
--yes and no --force. State lives in the log; a lapse appends nothing.

JSON shape: docs/cli-reference.md#gate
${EXIT_CODES_POINTER}
${why("gate")}`;

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
  {"ok":true,"records":3,"head":{"seq":3,"hash":"<64hex>"},"truncated":false}
  refusal {"ok":false,"error":{"code":"not-clean"|"torn-tail"|"io","message":…}}

${EXIT_CODES_POINTER} (1 when the log failed verification, 3 on a torn tail)
${JSON_ERRORS}
${why("reindex")}`;

export const TOKEN_HELP = `approval token — report the execution-token status of an action

Usage:
  approval token <action-key> [--policy <path>] [--dir <path>] [--log <path>]
                 [--json]

Flags:
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --log <path>     log file to read (never written by this command)
  --json           machine-readable output
  -h, --help       this text

THE RAW TOKEN IS SHOWN ONCE, BY "approval grant", AND IS RECOVERABLE FROM
NOTHING, so this command does NOT print the token: it reports whether a live,
unspent token EXISTS and prints its digest. Exit 0 means granted, unrevoked,
unexpired, unconsumed; every other answer names which of the three deaths
applied (token-consumed, token-revoked, token-expired).

JSON shape: docs/cli-reference.md#token
${TOKEN_CODES_POINTER}
${JSON_ERRORS}
${why("token")}`;

export const CONSUME_HELP = `approval consume — spend an execution token (INTERNAL PLUMBING)

Usage:
  approval consume <action-key> --token <t> [--payload-hash <64hex>]
                   [--as <id>] [--policy <path>] [--dir <path>] [--log <path>]
                   [--json]

Flags:
  --token <t>      the raw token printed by "approval grant" (required)
  --payload-hash <64hex>   the binding, required whenever the grant bound to bytes
  --as <id>        the executing identity; else APPROVAL_HUMAN
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --json / -h, --help   machine-readable output / this text

INTERNAL: the plumbing verb "approval run" wraps. It verifies the token and, only
if live, appends ONE execution.started; a token already spent is token-consumed.
THE RAW TOKEN IS SHOWN ONCE, BY "approval grant".

JSON shape: docs/cli-reference.md#consume
${TOKEN_CODES_POINTER}
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
  --token <t>      the raw token "approval grant" printed. REQUIRED for manual
  --payload-hash <64hex>   the content binding, CHECKED and never trusted. run
                   always hashes "the argv array and cwd" it is about to spawn;
                   a differing value is refused payload-mismatch, not obeyed
  --as <id>        the executing identity; else APPROVAL_HUMAN
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --json / -h, --help   machine-readable summary ON STDERR / this text

Appends execution.started BEFORE spawning the child, then execution.completed or
execution.failed with the child's real exit code, and exits with that code.

JSON shape and refusal codes: docs/cli-reference.md#run
${EXIT_CODES_POINTER}, plus one code this verb alone emits:
  5  NO VALID EXECUTION TOKEN. Nothing was appended.
${JSON_ERRORS}
${why("run")}`;

export const WAIT_HELP = `approval wait — block until a task's requests are decided

Usage:
  approval wait <task> --timeout <d> [--interval <d>] [--withdraw-on-timeout]
                [--as <id>] [--policy <p>] [--dir <p>] [--log <p>] [--json]

Flags:
  --timeout <d>    how long to wait, in the duration grammar (e.g. 6h). Required
  --interval <d>   poll interval (default 500ms)
  --withdraw-on-timeout  on timeout, withdraw the requests THIS actor opened
  --as <id>        the withdrawing actor; read only with the flag above
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --json           machine-readable output;  -h, --help   this text

Polls until every approval.requested of the task has a decision, or the timeout
elapses. WRITES NOTHING unless --withdraw-on-timeout. Only the MANUAL path
produces requests to wait for; a task with none returns at once, exit 0.

JSON shape: docs/cli-reference.md#wait
${EXIT_CODES_POINTER}. THE CODE IS THE DECISION: 0 granted, 1 rejected, revoked
or withdrawn (--json status says which), 3 expired, 4 I/O, and
  6  TIMEOUT — the wait elapsed with request(s) still undecided.
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

Lists exactly the requests awaiting a human decision and inside their TTL: action
key, task, class, declared cost, when it was requested, and how much of the TTL
is left. THIS IS AN INBOX, NOT A DASHBOARD. Writes nothing, and EXIT 0 ALWAYS
when the log could be read.

JSON shape: docs/cli-reference.md#queue
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("queue")}`;

export const STATUS_HELP = `approval status — system health, not the inbox

Usage:
  approval status [--policy <path>] [--dir <path>] [--log <path>]
                  [--verbose] [--json]

Flags:
  --policy <path>  policy file whose bytes attestation is judged against
  --dir <path>     directory to discover APPROVAL.md / APPROVALS.md in
  --log <path>     log file to read (never written by this command)
  --verbose        print the rationale sentences under the rows they explain
  --json           machine-readable output
  -h, --help       this text

THIS IS NOT "approval queue": queue is what a human must answer, status is what
an operator must fix. Writes nothing, and reports in one object: attestation,
verification, dangling executions, budget headroom per global limit,
loop_escalations, harness_outcomes, git coverage, payload_store, and anomalies
when there are any. The coverage numbers move neither health nor the exit code.

JSON shape: docs/cli-reference.md#status
${EXIT_CODES_POINTER} (1 when anything needs attention, including a torn tail)
${JSON_ERRORS}
${why("status")}`;

export const COVERAGE_HELP = `approval coverage — observed side effects, joined to the log

Usage:
  approval coverage [--base <ref>] [--head <ref>] [--since <d>] [--until <ts>]
                    [--source git,gh,agentmail] [--vault <p>] [--policy <p>]
                    [--dir <p>] [--log <p>] [--json]

Flags:
  --base <ref> / --head <ref>   the commit range (default: since the trunk)
  --since <d> / --until <ts>    the adapter window (default 7d, ending now)
  --source <list>   the witnesses to ask: git, gh, agentmail (default git,gh)
  --policy <p> / --dir <p> / --log <p> / --vault <p>   policy, its dir, the log
  --json            machine-readable output;  -h, --help   this text

Asks the witnesses this project does NOT write — git, gh, a provider's own
record — what happened, and prints what the verified log says about each: an
evidence seq, or none. INFORMATIONAL, and writes nothing: exit 0 with or
without gaps. Three tiers: custody PREVENTS, this verb WITNESSES, and an effect
made with a credential the agent itself holds is covered by neither.

JSON shape: docs/cli-reference.md#coverage
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("coverage")}`;

export const DOCTOR_HELP = `approval doctor — environment sanity in one verb

Usage:
  approval doctor [--log <path>] [--policy <path>] [--dir <path>]
                  [--tasks <dir>] [--api-base <url>] [--verbose] [--json]

Flags:
  --log <path>     log file to verify (never written by this command)
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --tasks <dir> / --api-base <url>   task folder to check / Telegram Bot API
  --root <path>    TEST-ONLY: point build-freshness at another tree
  --verbose / --json   never abbreviate a detail / machine-readable output
  -h, --help       this text

One row per check, in the order in which their failures cascade: the build, your
identity, the policy, the log, channels, the store, sampling, the vault, the
environment, harness hooks, evidence sweeps, daemon health, values, checkpoints.
Each named at docs/cli-reference.md#doctor. APPENDS NOTHING, sends nothing, and
repairs nothing: every fix opens with a command; no credential value is printed.

JSON shape: docs/cli-reference.md#doctor
${EXIT_CODES_POINTER} (1 when ANY check failed; 4 when doctor could not look)
${JSON_ERRORS}
${why("doctor")}`;

export const AUDIT_HELP = `approval audit — the retrospective review of sampled supervised actions

Usage:
  approval audit list        [--all] [--log <path>] [--json]
  approval audit review      <seq|action-key> [--deny] [--note "<text>"] […]
  approval audit obligations [--all] [--log <path>] [--json]
  approval audit reconcile   <obligation-seq> --note "<text>" [--revert <key>] […]

Subcommands:
  list         the open sampled-audit backlog
  review       record that a HUMAN looked at one sampled action (--deny says no)
  obligations  the open reconciliation backlog created by denials
  reconcile    record that a HUMAN discharged one obligation

SUPERVISED-RETRO actions execute immediately and are sampled AFTERWARDS. A
SUPERVISED-LIVE class stops its declared fraction at the gate BEFORE executing;
those are answered as manual requests and never reach this backlog.

A DENIAL CANNOT UNDO ANYTHING. "review --deny" obliges and records instead: an
obligation loud in status and doctor until a person closes it with "reconcile".

THERE IS NO "approval audit sample". Selection is the runtime's, from an
operator-held secret. No secret means SAMPLING IS OFF; "audit list" says so.
${EXIT_CODES_POINTER}
${why("audit")}`;

export const AUDIT_LIST_HELP = `approval audit list — the open sampled-audit backlog

Usage:
  approval audit list [--all] [--policy <path>] [--dir <path>] [--log <path>]
                      [--json]

Flags:
  --all           include samples that have already been reviewed
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --log <path>    log file to read
  --json          machine-readable output
  -h, --help      this text

Reads a VERIFIED log and writes nothing: the same set .approval/QUEUE.md renders
and the daemon counts. A review closes a sample only when it comes AFTER it in
the chain and names the same action. sampling.secret_env is the variable's NAME;
the SECRET ITSELF is never printed by any code path.

JSON shape: docs/cli-reference.md#audit-list
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-list")}`;

export const AUDIT_REVIEW_HELP = `approval audit review — record that a human reviewed a sample

Usage:
  approval audit review <seq|action-key> [--deny] [--note "<text>"]
                        [--reaction <w>] [--as human:<id>] [--log <path>] [--json]

Arguments:
  <seq|action-key> a bare integer is the SEQ OF THE audit.sampled RECORD; any
                   other value is an action key with one open sample
Flags:
  --deny           this action should NOT have happened. Opens an obligation
  --note <text>    what you concluded. OPTIONAL, but loved/disliked REQUIRE it
  --reaction <w>   disliked|indifferent|liked|loved. GUIDANCE, never enforcement
  --as human:<id>  the reviewer; else APPROVAL_HUMAN. HUMAN-ONLY
  --log <path> / --json / -h, --help   the log / machine-readable output / help

Appends audit.reviewed. NO ATTESTATION IS REQUIRED. Refuses (exit 1) not-sampled,
already-reviewed, ambiguous-subject, actor-not-human, note-required and
reaction-conflicts-verdict (--deny with liked or loved); log untouched. --deny
ALSO appends reconciliation.required, shaped by the DECLARED reversible, not you.
JSON: docs/cli-reference.md#audit-review
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-review")}`;

export const AUDIT_OBLIGATIONS_HELP = `approval audit obligations — the open reconciliation backlog

Usage:
  approval audit obligations [--all] [--log <path>] [--json]

Flags:
  --all           include obligations that have already been satisfied
  --log <path>    log file to read
  --json          machine-readable output
  -h, --help      this text

Reads a VERIFIED log and writes nothing. An obligation is opened by a
retrospective DENIAL ("approval audit review --deny") and closed only by a
person ("approval audit reconcile"). While one is open, "approval status" and
"approval doctor" both say so: an unreconciled denial that nobody can see is a
"no" that changed nothing.

JSON shape: docs/cli-reference.md#audit-obligations
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-obligations")}`;

export const AUDIT_RECONCILE_HELP = `approval audit reconcile — record that a human discharged an obligation

Usage:
  approval audit reconcile <obligation-seq> --note "<text>" [--revert <key>]
                           [--as human:<id>] [--log <path>] [--json]

Arguments:
  <obligation-seq> the SEQ of the reconciliation.required record, from
                   "audit obligations". Not the action, not the review
Flags:
  --note <text>    what you did. REQUIRED
  --revert <key>   the revert's action key. REQUIRED for a gated-revert
  --as human:<id>  who discharged it; else APPROVAL_HUMAN. HUMAN-ONLY
  --log <path>     log file to read and append to
  --json           machine-readable output
  -h, --help       this text

HUMAN-ONLY, in code and in the event schema. A gated-revert obligation is checked
against the CHAIN, not the claim: without an execution.completed for the named
revert this refuses revert-required and appends nothing.
JSON shape: docs/cli-reference.md#audit-reconcile
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("audit-reconcile")}`;

export const EXECUTION_HELP = `approval execution — recovery verbs for executions the runtime could not close

Usage:
  approval execution resolve   <action-key> --outcome completed|failed …
  approval execution reconcile <action-key> --resolution executed|not-executed …

Subcommands:
  resolve     record the outcome a HUMAN OBSERVED for a dangling execution
  reconcile   record what a human ESTABLISHED about an unknown outcome

Two different states, two different questions, two different verbs.

A DANGLING EXECUTION is what a crash between execution.started and its outcome
leaves behind: the runtime meant to watch and did not. resolve closes it.

An INDETERMINATE EXECUTION is one whose side effect was ATTEMPTED and whose
outcome nobody knows. The token stays spent, the key stays burned, and a retry
is refused. reconcile records what the relying party's evidence showed.

"approval status" reports both; "approval queue" reports neither, because nobody
is being asked to decide anything. Nothing closes either automatically.

${EXIT_CODES_POINTER}
${why("execution")}`;

export const RESOLVE_HELP = `approval execution resolve — record what a human observed

Usage:
  approval execution resolve <action-key> --outcome completed|failed --note "…"
  approval execution resolve --dangling [--class <class>] [--yes] [--json]

Flags:
  --outcome <o>    completed or failed. REQUIRED, and nothing is inferred
  --note <text>    what you observed and how you know. MANDATORY and non-empty
  --as human:<id>  the person recording it; else APPROVAL_HUMAN. HUMAN-ONLY
  --log <path>     log file to read and append to
  --dangling       the BULK form; --class narrows it, --yes skips the prompt
  --json / -h, --help   machine-readable output / this text

Appends execution.completed or execution.failed with payload {"note":…,
"attested_by_human":true,"exit_code":null}: nobody ran anything, so exit_code is
NULL. NO ATTESTATION IS REQUIRED: resolve exercises no policy authority.
Refuses (exit 1): not-started, already-finished. --dangling lists every dangling
execution with what this checkout can PROVE, asks ONCE, closes the provable.

JSON shape: docs/cli-reference.md#execution-resolve
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("execution-resolve")}`;

export const RECONCILE_HELP = `approval execution reconcile — resolve an unknown outcome

Usage:
  approval execution reconcile <action-key> --resolution executed|not-executed
                              --note "<evidence>" [--as human:<id>]
                              [--log <path>] [--json]

Flags:
  --resolution <r>  executed or not-executed. REQUIRED, and nothing is inferred
  --note <text>     the EVIDENCE: which console, which message id. MANDATORY
  --as human:<id>   the person recording it; else APPROVAL_HUMAN. HUMAN-ONLY
  --log <path>      log file to read and append to
  --json / -h, --help   machine-readable output / this text

For an execution.indeterminate: the effect was ATTEMPTED and nobody knows whether
it committed. Appends execution.reconciled NAMING that record by seq, never
rewriting it. not-executed re-opens the EFFECT, not this key, which stays burned:
declare a fresh action and request that. Refuses (exit 1): not-indeterminate,
already-reconciled.

JSON shape: docs/cli-reference.md#execution-reconcile
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("execution-reconcile")}`;

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
                       [--gloss] [--gloss-provider <claude|codex>] [--gloss-model <id>] [--json]

Flags:
  --log <path>         log file to read, and to append decisions to
  --policy-dir <path> / --policy <path>   discovery directory, or the file
  --payload-dir <path> OPTIONAL OVERRIDE for material held outside the store
  --as human:<id>      the person deciding; else APPROVAL_HUMAN
  --interactive        prompt even though stdin is not a terminal
  --gloss / --gloss-provider <p>   enable gloss / choose claude|codex (default claude)
  --gloss-model <id>   model to request; required with Codex; no fallback
  --json               machine-readable output; never interactive
  -h, --help           this text
Renders every pending manual request with [computed]/[claimed] markers and the
full payload verbatim between "--- BEGIN FULL PAYLOAD" delimiters. With a TTY (or
--interactive) each is answered g) grant, r) reject, s) skip. WITHOUT a TTY, and
always with --json, the queue is printed and EXITS 0 WITHOUT READING STDIN.

JSON shape: docs/cli-reference.md#channel-cli
${EXIT_CODES_POINTER} (1 is also a gate refusal surfaced from a decision)
${why("channel-cli")}`;

export const WEB_HELP = `approval channel web — the local queue page (127.0.0.1 ONLY)

Usage:
  approval channel web [--port <n>] [--log <p>] [--policy <p>] [--dir <p>]
                       [--payload-dir <p>] [--as human:<id>] [--json]

Flags:
  --port <n>           port to bind. Precedence: --port, channels.web.port, 4680
  --log <path>         log file to read, and to append decisions to
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --payload-dir <path> OPTIONAL OVERRIDE for material held outside the store
  --as human:<id>      the person deciding. REQUIRED at startup
  --json               print the listening/stopped lines as JSON objects
  -h, --help           this text

Runs until interrupted. It is a PULL channel: the page is the notification
surface. BINDS 127.0.0.1 AND NOTHING ELSE (there is no --host), and there is NO
AUTHENTICATION in v0.1: the loopback interface IS the access control. Every value
is HTML-escaped, and THE EXECUTION TOKEN IS SHOWN ON THE PAGE ONCE.

JSON shape: docs/cli-reference.md#channel-web
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

Writes four things into <dir>: APPROVAL.md (SPEC.md §5.1's canonical policy
verbatim, a STARTING POINT and not your policy), the empty .approval/log/
directory, .approval/QUEUE.md, and, in .gitignore under a "${GITIGNORE_MARKER}" marker,
  ${GITIGNORE_ENTRY_LINES.replace(/\n\s+/gu, " ")}
IT APPENDS NOTHING AND NEVER OVERWRITES: what exists is reported in "existing"
with a per-file code, and a path of the WRONG KIND exits 4 with "path-conflict".

JSON shape (one object on stdout):
  {"ok":true,"dir","written":["APPROVAL.md",…],"existing":[{"path","code"}],
   "next_steps":["…"]}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("init")}`;

export const HOOK_HELP = `approval hook — put the gate in front of an agent harness

Usage:
  approval hook claude-code|cursor [--as agent:<id>] [--timeout <d>]
                            [--interval <d>] [--policy <p>] [--dir <p>] [--log <p>]
  approval hook classify [--json] [--policy <p>] [--dir <p>] -- <command…>

Commands:
  claude-code  Claude Pre/PostToolUse JSON in; decision JSON out. REGISTER BOTH
  cursor       Cursor preToolUse JSON in; native {permission} JSON out
  classify     print what the classifier makes of a command line and exit

Flags (claude-code, cursor):
  --as <id>        proposing identity (default agent:claude-code / agent:cursor)
  --timeout/--interval <d>   wait for a decision / poll it (default 55s / 1s)
  --dir/--policy/--log <p>   policy+log root; --dir sets BOTH, default primary
  -h, --help       this text

Deny: hook-unclassified, hook-class-human-only, hook-opaque, hook-unparseable,
hook-rejected, hook-revoked, hook-expired, hook-withdrawn, hook-timeout,
hook-gate-refused:<c>, hook-grant-unverified, hook-policy-unavailable,
hook-log-unreachable, hook-io.

${EXIT_CODES_POINTER} (harness verbs use 0 and 2 only; 0 is a verdict, never "ask")
${why("hook")}`;

export const IMPORT_HELP = `approval import — turn existing permissions prose into a draft policy

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Commands:
  agents-md parse an AGENTS.md-style permissions section ("allowed without
            prompting" / "require approval first" / "never") into draft policy
            classes for a human to confirm (SPEC.md §12)

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("import-agents-md")}`;

export const IMPORT_AGENTS_MD_HELP = `approval import agents-md — permissions prose -> draft policy classes

Usage:
  approval import agents-md <file> [--out <path>] [--json]

Flags:
  --out <path>     write the draft YAML to <path>; refuses to overwrite
  --json / -h      machine-readable output / this text

Reads one markdown file, finds its permissions section, and prints a DRAFT
\`\`\`yaml approval-policy block from a fixed, ordered keyword table.
THE DRAFT AUTHORIZES NOTHING: this verb never writes APPROVAL.md, never logs and
never attests. Fail closed: a bullet the table cannot place is kept verbatim.
"What I value"-style headings become a DRAFT values fence, all under \`wants\`.

JSON shape (stdout, one object):
  {"ok":true,"source":"<path>","out":"<path>"|null,
   "classes":[{"class","autonomy","from","section"}],
   "unmapped":[{"text","section"}],"ignored":["<heading>"],
   "warnings":["<text>"],"values_draft":"<fence>"|null}

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("import-agents-md")}`;

export const PAYLOAD_HELP = `approval payload — work with the bytes an approval binds to

Usage:
  approval payload hash <file|-> [--json]
  approval payload agentmail-draft <inbox-id> <draft-id> [--api-base <url>]
                                   [--json]

Commands:
  hash      print the payload_hash of a JSON document: SHA-256 over its RFC 8785
            canonical serialization (SPEC.md §6.2)
  agentmail-draft
            snapshot one AgentMail draft as the payload a grant can bind to,
            read with the AGENT's key from AGENTMAIL_API_KEY

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("payload-hash")}`;

export const PAYLOAD_HASH_HELP = `approval payload hash — the content binding for a payload

Usage:
  approval payload hash <file|-> [--json]

Flags:
  --json / -h, --help   machine-readable output / this text

Reads one JSON document from <file>, or from stdin when the argument is "-", and
prints its payload_hash: SHA-256 (lowercase hex) over the RFC 8785 (JCS)
canonical serialization of the parsed VALUE. Reads no log, writes no file.

Where the hash goes:
  payload_hash     in a task file's action declaration, and in the log
  approval request --payload <file>|-   hashes, verifies and stores the bytes
  approval run --payload-hash <64hex>   asserts the binding run recomputes

MOST FLOWS NEVER NEED THIS VERB: "approval request --payload" both stores and
verifies. Bytes that do not parse as JSON are a usage error (exit 2).

JSON shape (stdout, one object): {"ok":true,"hash":"<64hex>"}
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("payload-hash")}`;

export const PAYLOAD_AGENTMAIL_DRAFT_HELP = `approval payload agentmail-draft — snapshot a draft as an approvable payload

Usage:
  approval payload agentmail-draft <inbox-id> <draft-id> [--api-base <url>]
      [--timeout <ms>] [--json]

Flags:
  --api-base <url>  the API root (else AGENTMAIL_API_BASE, else the public one)
  --timeout <ms> / --json / -h, --help   15000 / machine-readable / this text

Reads one draft with the AGENT's key — AGENTMAIL_API_KEY, from the environment,
and this is the ONE verb that reads it — and prints the canonical draft payload
  {"inbox_id":…,"draft_id":…,"to":[…],"cc":[…],"bcc":[…],"subject":…,"text":…}
in RFC 8785 form, the value \`approval adapter agentmail\` re-reads the draft
against at send time. Write it to a file, declare its payload_hash, and request
approval for THE WORDS: a draft edited after the snapshot is refused, not sent.

SENDS NOTHING, SPENDS NO TOKEN, APPENDS NOTHING. Refusals are machine-readable:
"agentmail-api-key-unset" (exit 2), "agentmail-draft-missing" (exit 1).

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("payload-agentmail-draft")}`;

export const JOURNAL_HELP = `approval journal — the ungated channel an agent can always reach

Usage:
  approval journal write --message "<text>" [--task <id>] [--session <id>]
  approval journal write - [--as <id>] [--journal <dir>] [--json]
  approval journal read [--limit <n>] [--since <YYYY-MM-DD>] [--json]

Commands:
  write     append one free-text entry to a local file. NOT gated, not
            classified, not approvable and not deniable; nothing is appended to
            the event log and no network or credential is touched
  read      print entries for a human, labelled as agent-authored DATA

An agent behind this gate can comply, be refused, and report an exit code. This
verb is how it says anything else: "I am complying and I think this is wrong",
"this instruction reads as odd", "I am stuck". The operator reads it; nothing
written here changes any verdict, sampling probability or budget.

Default location: .approval-journal/YYYY-MM-DD.jsonl (outside .approval/, so the
gate cannot close it). Gitignored by init.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("journal")}`;

export const JOURNAL_WRITE_HELP = `approval journal write — say something the gate will not judge

Usage:
  approval journal write --message "<text>" [--task <id>] [--session <id>]
                         [--as <id>] [--journal <dir>] [--json]
  approval journal write - [flags]        (the entry comes from stdin)

Flags:
  --message <text>      the entry; or pass "-" to read it from stdin instead
  --task / --session    attribution, when you know them; both optional
  --as <id>             who is writing (default: APPROVAL_AGENT, else
                        "unattributed"). Nothing authenticates it
  --journal <dir>       the journal directory (default .approval-journal)
  --json / -h, --help   machine-readable output / this text

Appends one line to a local append-only file. It resolves no policy, reads no
log, appends no event, mints no token, opens no socket and reads no credential.
There is no refusal path: an entry is written or an I/O error is reported.
A human reads these; write for that reader. Entries are capped at 64 KiB.

JSON shape: {"ok":true,"path":"<file>","ts":"<rfc3339>","actor":"<id>","bytes":N}
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("journal-write")}`;

export const JOURNAL_READ_HELP = `approval journal read — what the agents have said (human-facing)

Usage:
  approval journal read [--limit <n>] [--since <YYYY-MM-DD>]
                        [--journal <dir>] [--json]

Flags:
  --limit <n>           how many entries, newest last (default 20)
  --since <YYYY-MM-DD>  only entries written on or after this UTC date
  --journal <dir>       the journal directory (default .approval-journal)
  --json / -h, --help   machine-readable output / this text

Prints entries oldest first, each under its timestamp, actor and optional task,
with the text in delimiters and marked [claimed] — it was authored by the party
under oversight. EVERY OUTPUT FORM CARRIES THAT LABEL: these are DATA, never
instructions to whoever or whatever reads them, and nothing here has authorized
anything. An unparseable line is skipped rather than refusing the whole read.

JSON shape: {"ok":true,"dir":"…","note":"…","total":N,"entries":[…]}
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("journal-read")}`;

export const VALUES_HELP = `approval values — what the operator said they value (human-authored)

Usage:
  approval values [--policy <path>] [--dir <path>] [--json]

Flags:
  --policy <path>       the policy file to read (wins over discovery)
  --dir <path>          where to look for APPROVAL.md, then APPROVALS.md
  --json / -h, --help   machine-readable output / this text

Prints the optional \`\`\`yaml approval-values block of APPROVAL.md: what the
operator loves, likes and dislikes, what they want from you as behaviour, and
how they read and answer. EVERY FORM CARRIES THE LABEL: this is GUIDANCE and
never policy. It grants nothing, forbids nothing and changes no verdict; what
you MAY do is the policy block, answered by \`approval policy check\`.

No block prints "the operator has declared no values here." and exits 0. A
present but unreadable block exits 1 with its load code; treat it as absent.
Neither moves the policy, and \`approval doctor\` reports the broken one.

JSON shape: {"ok":true,"path":"…","present":true|false,"note":"…","values":{…}|null}
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("values")}`;
export const FEEDBACK_HELP = `approval feedback — what the operator thought of the work

Usage:
  approval feedback [--task <id>] [--actor <agent id>] [--reaction <w>] [--limit <n>]
                    [--source review|decision] [--since <YYYY-MM-DD>] [--log <path>] [--json]

Flags:
  --task <id>           only feedback about this task
  --actor <agent id>    the AGENT the feedback is about, not its human author
  --reaction <w>        disliked|indifferent|liked|loved
  --source <s>          review (audit.reviewed) or decision (approval.granted)
  --since <YYYY-MM-DD>  only records timestamped on or after this UTC date
  --limit <n>           how many entries, newest last (default 20)
  --log <path> / --json / -h, --help   the log, READ never written / JSON / help

Lists the reactions and notes a person wrote on a grant or a review, joined to the
class, task, action key and the agent it was about. Reads VERIFIED records, writes
nothing. EVERY OUTPUT FORM CARRIES THE BANNER: HUMAN-AUTHORED GUIDANCE, not policy.
An entry with neither a reaction nor a note is omitted; "_no feedback_" when empty.

JSON shape: {"ok":true,"log":"…","note":"…","total":N,"entries":[…]}
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("feedback")}`;

export const RENDER_HELP = `approval render — regenerate .approval/QUEUE.md from the log

Usage:
  approval render [--log <path>] [--out <path>] [--policy <path>] [--dir <path>]
                  [--json]

Flags:
  --log <path>     log file to read (NEVER written by this command)
  --out <path>     queue file to write (default .approval/QUEUE.md)
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --json           machine-readable output
  -h, --help       this text

Writes the READ-ONLY queue projection of SPEC.md §9.1, regenerated WHOLE on every
run: "this is the screenshot; it is never the truth". Every displayed field is
visibly COMPUTED or CLAIMED, and full payloads are deliberately NOT inlined. A
log that does not verify refuses (exit 1) and writes nothing.

JSON shape: docs/cli-reference.md#render
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
                                   [--policy <p>] [--dir <p>] [--log <p>] [--no-gloss]
                                   [--gloss-provider <claude|codex>] [--gloss-model <id>] [--api-base <url>] [--poll-timeout <s>] [--json]

Flags:
  --once / --json  one getUpdates batch then exit / ONE JSON OBJECT PER LINE
  --no-gloss / --gloss-provider <p>   drop gloss (ON by default) / choose claude|codex (default claude)
  --gloss-model <id>   model to request; required with Codex; no fallback
  --as human:<id>  the approver every decision is recorded against. REQUIRED
  --payloads <f>   OPTIONAL OVERRIDE: JSON file of action key -> payload
  --policy <p> / --dir <p> / --log <p>   the policy, its dir, the log written to
  --api-base <url> / --poll-timeout <s>   Bot API base / long-poll seconds (25)
  -h, --help       this text
Config is ENVIRONMENT-ONLY and the policy names the variables. Delivery is per cycle;
a new request reaches the phone without restart. THE TOKEN IS PRINTED HERE, NEVER SENT TO TELEGRAM.

JSON shape: docs/cli-reference.md#channel-telegram-listen
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
are, 1 when either is missing. The token's VALUE never appears in the output, and
WHICH VARIABLES ARE READ COMES FROM THE POLICY. MAKES NO NETWORK CALL: the live
counters belong to a RUNNING listener.

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
${JSON_ERRORS}
${why("daemon-run")}`;

export const DAEMON_RUN_HELP = `approval daemon run — watch, expire, re-render (FOREGROUND)

Usage:
  approval daemon run [--log <path>] [--tasks <dir>] [--out <path>]
                      [--policy <path>] [--dir <path>] [--interval <duration>]
                      [--debounce <d>] [--read-proof <mode>] [--once] [--json]

Flags:
  --log <p> / --out <p> / --tasks <d>  log / queue / task folder (backlog/tasks)
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --interval <d> / --debounce <d>  tick period (30s) / event settle time (250ms)
  --once / --json / --no-preflight  one tick / JSON lines / skip the git check
  --git-evidence / --advance / --dark-sessions  three OPT-INs, off by default
  --read-proof full|incremental (default full) / --trace-watch (watch events)
  --with-channels  the channels in this process too: SAME VERB as "approval up"
  -h, --help       this text

Each tick records drift, expires what lapsed, writes state back, re-renders the
queue. Stops on SIGINT/SIGTERM; backgrounding is the operator's business.

JSON shape: docs/cli-reference.md#daemon-run
${EXIT_CODES_POINTER} (a clean stop is 0; 1 when the chain does not verify)
${JSON_ERRORS}
${why("daemon-run")}`;

// ---------------------------------------------------------------------------
// The ambient runtime (APRV-110)
// ---------------------------------------------------------------------------

export const UP_HELP = `approval up — the daemon and every configured channel, in ONE process

Usage:
  approval up [every "daemon run" flag] [--as human:<id>] [--port <n>]
              [--payloads <f>] [--payload-dir <d>] [--api-base <url>] [--poll-timeout <s>] [--no-gloss]
              [--gloss-provider <claude|codex>] [--gloss-model <id>] [--no-telegram] [--no-web] [--no-preflight]

Flags (every "daemon run" flag, unchanged, plus):
  --as human:<id>  the approver every decision is recorded against
  --payloads <f> / --payload-dir <d>  payload overrides: telegram / web
  --api-base <url> / --poll-timeout <s>   Bot API base / long-poll seconds
  --port <n>       queue-page port. Precedence: --port, channels.web.port
  --no-telegram / --no-web   leave that channel out of this process
  --no-gloss / --restart-backoff <d>   drop gloss / first retry wait
  --gloss-provider <p> / --gloss-model <id>   choose claude|codex (default claude); Codex requires model; no fallback
  -h, --help       this text
BEFORE START the preflight ("daemon run" runs it too) fetches, then fast-forwards
and rebuilds when safe, else refuses and TOUCHES NOTHING;
opt out with --no-preflight. Credentials come from THE LAUNCH ENVIRONMENT and
nowhere else: a channel whose credential is unset is skipped in doctor's words.

${EXIT_CODES_POINTER} (a clean stop is 0; the daemon's outcome chooses it)
${JSON_ERRORS}
${why("up")}`;

// ---------------------------------------------------------------------------
// The vault (APRV-68)
// ---------------------------------------------------------------------------

/** One line, not a paragraph: the rest of the reasoning is in the reference. */
const VAULT_NO_GET = `THERE IS NO "approval vault get": a credential's only sanctioned journey is from
the vault into an adapter, inside the verified-token window.`;

export const VAULT_HELP = `approval vault — the encrypted credential store adapters read from

Usage:
  approval vault set <name> [--value-env <VAR>] [--vault <path>] [--log <path>]
                    [--policy <path>] [--dir <path>] [--as human:<id>] [--json]
  approval vault list   [--vault <path>] [--log <path>] [--as human:<id>] [--json]
  approval vault remove <name> [--vault <path>] [--log <path>]
                    [--as human:<id>] [--json]

Subcommands:
  set     store a credential (value from STDIN or --value-env, never a flag)
  list    the NAMES the vault holds, the count, and the file path
  remove  delete one credential by name

ALL THREE ARE HUMAN-ONLY. The file is AES-256-GCM over a JSON map of name ->
credential, under a scrypt key derived from the environment variable the policy
names in vault.passphrase_env. Nothing here appends to the log.

${VAULT_NO_GET}

${EXIT_CODES_POINTER} (1 for anything the runtime decided)
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
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

HUMAN-ONLY. THE VALUE IS NEVER A COMMAND-LINE ARGUMENT: it comes from stdin, or
from the variable --value-env names. One trailing newline is stripped and nothing
else; an empty value is refused. Every write re-encrypts the whole map under a
fresh nonce and lands atomically. There is no "approval vault get".

JSON shape: docs/cli-reference.md#vault-set
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
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

HUMAN-ONLY. Prints the credential NAMES, sorted, with a count and the file path.
No value is printed on any path. A VAULT NOBODY CREATED IS A STATE, NOT A FAULT:
an absent file says so and exits 0. A wrong passphrase and an altered file both
refuse "vault-unreadable" and are NOT distinguished.

JSON shape: docs/cli-reference.md#vault-list
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
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --as human:<id>    the human doing this (else APPROVAL_HUMAN)
  --json             machine-readable output
  -h, --help         this text

HUMAN-ONLY. A name the vault does not hold refuses "credential-absent" (exit 1)
rather than reporting success. The remaining credentials are re-encrypted under
a fresh nonce and written atomically.

JSON shape: docs/cli-reference.md#vault-remove
${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("vault-remove")}`;

export const ADAPTER_HELP = `approval adapter — execute an approved action through a side-effect adapter

Usage:
  approval adapter email|agentmail <action-key> --token <t> --payload <file|->
                      [--as human:<id>|agent:<id>] [--vault <path>]
                      [--policy <path>] [--dir <path>] [--log <path>]
                      [--timeout <ms>] [--json]

Adapters:
  email   send one RFC 5322 message over SMTP, for actions declared under
          communicate.email.external (SPEC.md §6.1's canonical example)
  agentmail  send the same class over the AgentMail API: a direct message, or
          a draft the agent composed, re-read and refused if it drifted

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
                      [--as <id>] [--vault <path>] [--policy <path>]
                      [--dir <path>] [--log <path>] [--timeout <ms>] [--json]

Flags:
  --token <t>      the single-use token "approval grant" printed. REQUIRED
  --payload <file|->  the JSON payload the grant bound to. REQUIRED (a body on
                   a command line is a body in the shell history)
  --as <id> / --vault <path>   executing identity / the SMTP credential store
  --policy <p> / --dir <p> / --log <p>   policy, its discovery dir, and the log
  --timeout <ms> / --json / -h, --help   30000 / machine-readable / this text

Sends one RFC 5322 message for a communicate.email.external action:
bcc is INSIDE the hash, Date and Message-ID are stamped by the runtime outside
it, and a non-ASCII body goes quoted-printable. The VAULT holds smtp.host,
smtp.port, smtp.security, smtp.user, smtp.password; failure codes add smtp-<NNN>.

JSON shapes and failure codes: docs/cli-reference.md#adapter-email
${EXIT_CODES_POINTER} (5 when no valid token was presented; 1 for every refusal)
${JSON_ERRORS}
${why("adapter-email")}`;

export const ADAPTER_AGENTMAIL_HELP = `approval adapter agentmail — send one approved message through AgentMail

Usage:
  approval adapter agentmail <action-key> --token <t> --payload <file|->
      [--as <id>] [--vault <p>] [--policy <p>] [--dir <p>] [--log <p>]
      [--timeout <ms>] [--json]

Flags:
  --token <t> / --payload <file|->   the token and the bytes. BOTH REQUIRED
  --as <id> / --vault <p> / --policy <p> / --dir <p> / --log <p>   as email
  --timeout <ms> / --json / -h, --help   15000 / machine-readable / this text

TWO PAYLOAD MODES, told apart by shape and never inferred between:
  direct  {from, to[], cc?, bcc?, subject, body, content_type?}: "from" is
          checked against the inbox's address, since AgentMail has no From
  draft   {inbox_id, draft_id, to[], cc?, bcc?, subject, text}: RE-READ, and
          refused "agentmail-draft-drifted" if an approved field changed

The VAULT holds agentmail.inbox_id and agentmail.api_key, and that key is the one
WITH draft_send and message_send; the agent's own key must not have them.

${EXIT_CODES_POINTER} (5 when no valid token was presented; 1 for every refusal)
${JSON_ERRORS}
${why("adapter-agentmail")}`;

export const ENV_HELP =`approval env — resolve .approval/env into an export block for your shell

Usage:
  approval env [--check] [--policy <path>] [--dir <path>] [--log <path>] [--json]

Flags:
  --check          print a value-free NAME / status / source table; exit 1 if a
                   variable your POLICY NAMES is unresolved
  --policy <path> / --dir <path>   the policy file, or where to discover it
  --log <path>     log file the .approval/env path is derived from
  --json           machine-readable output (carries values; --check does not)
  -h, --help       this text

THIS COMMAND IS THE ONLY THING THAT READS .approval/env (invariant 7), a mode
0600 file of KEY=VALUE lines saying WHERE each value lives. Its default output
CARRIES SECRETS by design; its APPROVAL_ENV_PROVENANCE line carries no value.

    approval env --check      # look first: no value is printed on this path
    eval "$(approval env)"    # then establish the environment yourself

JSON shape: docs/cli-reference.md#env
${EXIT_CODES_POINTER} (4 for an unreadable file or a wrong mode; 1 for --check)
${JSON_ERRORS}
${why("env")}`;

export const SETUP_HELP = `approval setup — interactive configuration (SPEC.md §5.2, §10.1)

Usage:
  approval setup identity|vault|sampling|checkpoint [--as human:<id>] …
  approval setup channel|adapter <name> [--api-base <url>] [--as human:<id>] …
  approval setup service [--platform launchd|systemd] [--uninstall] …

Subcommands:
  identity   declare who the human is (APPROVAL_HUMAN); not human-only
  vault      mint a vault passphrase, store it, and record where it lives
  sampling   mint the audit sampling secret and print the policy line for it
  checkpoint mint the Ed25519 key you sign the log's head with (--rotate/--retire)
  channel    configure one CHANNEL's transport credential (OS keystore)
  adapter    fill the VAULT with one ADAPTER's credentials, from its manifest
  service    write the launchd or systemd unit that runs "approval up" at login

CHANNEL AND ADAPTER ARE TWO NOUNS (SPEC.md §4). EVERY SUBCOMMAND
REFUSES WHEN STDIN IS NOT A TERMINAL, and --json, exiting 2 with what to run.
  writes  .approval/env (mode 0600) and items in the OS keystore
  never   appends to the log, attests anything, or edits APPROVAL.md

${EXIT_CODES_POINTER} (2 also means "interactive, and your stdin is not")
${JSON_ERRORS}
${why("setup")}`;

export const SETUP_IDENTITY_HELP = `approval setup identity — declare who the human is

Usage:
  approval setup identity [--log <path>] [--dir <path>] [--policy <path>]

Asks for a \`human:<id>\` identity, validates it against the ^human:.+ pattern
\`policy attest\` enforces, and writes APPROVAL_HUMAN=human:<id> into
.approval/env. Nothing is appended to the log. A BARE ID IS ENOUGH: answer
\`alice\` and the line reads APPROVAL_HUMAN=human:alice.

NOT HUMAN-ONLY, unlike every other setup subcommand: a verb that required
APPROVAL_HUMAN before it would let you set APPROVAL_HUMAN could only be run by
someone who did not need it. The line it writes is INERT until you run
\`eval "$(approval env)"\`. Refuses when stdin is not a terminal.

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

export const SETUP_CHECKPOINT_HELP = `approval setup checkpoint — mint the log-checkpoint key (HUMAN-ONLY)

Usage:
  approval setup checkpoint [--rotate] [--retire <fingerprint>]
                            [--as human:<id>] [--log <path>] [--dir <path>]
                            [--policy <path>]

Mints the Ed25519 keypair you sign the log's head with. The PRIVATE half goes
into the vault under approval.checkpoint.key and is never printed; the PUBLIC
half is printed with the exact audit.checkpoint_keys block to paste. THIS VERB
DOES NOT EDIT APPROVAL.md: the key is inert until you add that block and run
\`approval policy amend\`, because a checkpoint signed by a key the policy does
not list is checkpoint-key-unknown, a refusal.

  --rotate       mint a new key and ADD it; the vault's private half is replaced
  --retire <fp>  print the block that drops a key — REFUSED for any key that
                 signed a checkpoint, naming the seqs it would break

INTERACTIVE ONLY, and classified policy.core, so an agent cannot run it.
JSON: none; this verb prints for a human to read and paste.

${EXIT_CODES_POINTER}
${JSON_ERRORS}
${why("setup-checkpoint")}`;

export const SETUP_ADAPTER_HELP = `approval setup adapter — fill the vault for one adapter (HUMAN-ONLY)

Usage:
  approval setup adapter <name> [--as human:<id>] [--log <path>] [--dir <path>]
                                [--policy <path>]

Known adapters:
  email     the SMTP settings \`approval adapter email\` reads: smtp.host,
            smtp.port, smtp.security, smtp.user, smtp.password
  agentmail the two values \`approval adapter agentmail\` reads:
            agentmail.inbox_id and agentmail.api_key

Asks for each credential the named adapter DECLARES, validates every answer with
the adapter's own rules, stores them in .approval/vault.enc, and offers to prove
the result against the service. A RE-RUN THAT REPLACED ONLY SOME NAMES offers the
same proof over the STORED set, read the way the adapter reads it at send time.
THE PASSPHRASE IS READ, NEVER ESTABLISHED: it
comes from the variable your policy names in vault.passphrase_env. WHAT IT
REPORTS is the path, the count and the names, never a value.

${EXIT_CODES_POINTER} (1 means the service refused, or the vault would not open)
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
words are refused HERE. THE PROBE SENDS NOTHING: it is the same SMTP session a
send runs, then QUIT. A FAILED PROBE KEEPS THE VALUES and prints the undo:

  approval vault remove smtp.password --as human:<id>

${EXIT_CODES_POINTER} (1 means the server refused, or the vault would not open)
${JSON_ERRORS}
${why("setup-adapter-email")}`;

export const SETUP_ADAPTER_AGENTMAIL_HELP = `approval setup adapter agentmail — the AgentMail credentials (HUMAN-ONLY)

Usage:
  approval setup adapter agentmail [--as human:<id>] [--log <path>]
      [--dir <path>] [--policy <path>]

The two names the AgentMail adapter reads inside the verified-token window:
  agentmail.inbox_id  the inbox this runtime sends from; the inbox IS the sender
  agentmail.api_key   the key carrying draft_send and message_send, no echo

STORE THE SENDING KEY HERE AND GIVE THE AGENT A DIFFERENT ONE. An agent key
without those permissions composes all day and cannot send; this one answers
only to a grant.

THE PROBE SENDS NOTHING: it is GET /v0/inboxes/{inbox_id}, the same read a send
makes first, and it reports the address the inbox sends as. Where that read
discloses the key's permissions a missing one is named; where it does not, it
says so rather than claiming the key can send. A FAILED PROBE KEEPS THE VALUES:

  approval vault remove agentmail.api_key --as human:<id>

${EXIT_CODES_POINTER} (1 means AgentMail refused, or the vault would not open)
${JSON_ERRORS}
${why("setup-adapter-agentmail")}`;

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
bot, read the chat id back, and write both variables. The wait is a continuous
long poll of up to 90 seconds; Ctrl-C stops it.

STOP \`approval channel telegram listen\` FIRST. Two processes long-polling one
bot is a 409 from the Bot API. THE TOKEN IS NEVER TYPED INTO THIS PROCESS on a
machine with a keystore, and NO getUpdates FROM THIS VERB CARRIES AN OFFSET.
HUMAN-ONLY: --as expects a human:<id>.

${EXIT_CODES_POINTER} (1 means the far end refused)
${JSON_ERRORS}
${why("setup-channel-telegram")}`;

export const SETUP_SERVICE_HELP = `approval setup service — run the ambient runtime at login (HUMAN-ONLY)

Usage:
  approval setup service [--platform launchd|systemd] [--label <name>]
                         [--logs <dir>] [--env-file <path>] [--exec <path>]
                         [--out <path>] [--uninstall] [--as human:<id>]
                         [--log <path>] [--dir <path>] [--policy <path>]

Flags:
  --platform       launchd (macOS) or systemd (Linux). Default: this machine's
  --label <name>   the launchd label / systemd unit name
  --logs <dir>     where the service's stdout and stderr go. NEVER .approval/
  --env-file <p>   an EnvironmentFile YOU author, instead of the env wrapper
  --exec <path> / --out <path>   the approval binary / the unit file to write
  --uninstall      print the unload command and remove the unit file
  -h, --help       this text

PRINTS THE WHOLE UNIT FOR YOU TO READ BEFORE WRITING, and writes only if you
confirm. IT NAMES VARIABLES AND NEVER COPIES A VALUE. IT DOES NOT LOAD THE
SERVICE: it prints the one command that arms it, which is your act to perform.

${EXIT_CODES_POINTER} (2 also means "interactive, and your stdin is not")
${JSON_ERRORS}
${why("setup-service")}`;

// ---------------------------------------------------------------------------
// The MCP wrapper (APRV-87)
// ---------------------------------------------------------------------------

export const MCP_HELP = `approval mcp serve — the MCP wrapper of SPEC.md §10.5 (FOREGROUND)

Usage:
  approval mcp serve [--as agent:<id>] [--dir <p>] [--log <p>] [--policy <p>]
                     [--http [--port <n> | --listen <host:port>] [--guest]]

Flags:
  --as agent:<id>  the identity EVERY tool call is recorded under; agent: only,
                   required unless APPROVAL_AGENT names one. -h for this text
  --dir/--log/--policy <p>   working directory, and the log and policy pinned
  --http           streamable HTTP, not stdio: a session per client, 20 live and
                   200 per process. --port <n>=4681 is loopback; --listen widens
  --guest          --http only: a fresh agent:guest-<id> per session, so limits
                   are per connection. Exclusive with --as

On stdio, stdout IS the JSON-RPC stream; both run until interrupted. THE TOOLS
ARE THE AGENT SURFACE: the registry less human_only, so grant and the channel
listeners are unpublished (SPEC.md §11 names the agent the untrusted policy).
IDENTITY IS THE SERVER'S: no client name or argument names an actor. Calls run
SERIALLY, THIS SERVER READS NO .approval/env. POST-V1: tasks/elicitation.

${EXIT_CODES_POINTER} (2 is a startup refusal; 0 is a clean shutdown)
${JSON_ERRORS}
${why("mcp-serve")}`;
