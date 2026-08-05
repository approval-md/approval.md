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
  approval reindex    [--log <path>] [--index <path>] [--force] [--json]
  approval --help

Commands:
  log       inspect the append-only event log (verify | tail | export)
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
