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
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval --help

Commands:
  log       inspect the append-only event log (verify | tail | export)
  policy    explain what APPROVAL.md does with an action class (check | test)
  reindex   rebuild the SQLite index projection from the log

Defaults:
  log    .approval/log/events.jsonl   (relative to the working directory)
  index  .approval/index.sqlite

${EXIT_CODES}

Machine-readable output: every command accepts --json and prints exactly one
JSON object per invocation. Run "approval <command> --help" for that command's
exact shape.
${JSON_ERRORS}

The log is append-only. No command here writes to it, and a torn tail is
reported, never repaired.`;

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

Subcommands:
  check   explain the autonomy resolution for <class>
  test    exact alias of check (SPEC.md §10.1 names both)

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
