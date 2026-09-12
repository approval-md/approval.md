# Codex workspace planner

`planWorkspaceProposal` is the read-only planning boundary for a future Codex
workspace broker. It accepts only create, replace, delete, and move operations.
It validates every operation, resolves policy classes before reading source
file contents, and returns an immutable plan whose action legs all bind the
same canonical payload hash.

The planner accepts trusted context from its caller: a normalized real
workspace root, an `agent:<id>` actor, a loaded policy snapshot, and the
attested SHA-256 digest for that snapshot. Passing those values does not prove
that the caller has protected them. A future broker must derive them from its
own protected configuration, verify the attestation, retain exclusive write
custody, authorize every returned action leg, revalidate the plan, and only
then apply it.

## Closed input

Each proposal is a nonempty array containing at most 64 strict objects. Unknown
fields and unknown operation kinds are refused.

- `create`: `kind`, `path`, `after_base64`
- `replace`: `kind`, `path`, `expected_before_sha256`, `after_base64`
- `delete`: `kind`, `path`, `expected_before_sha256`
- `move`: `kind`, `from`, `to`, `expected_before_sha256`

Paths are relative NFC POSIX paths of at most 1,024 UTF-8 bytes. Absolute paths,
backslashes, control characters, malformed UTF-16, traversal, empty components,
case aliases, duplicates, endpoint chains, and overlapping endpoints are
refused. Every image is at most 1 MiB and must use canonical padded base64. The
combined before and after images are at most 8 MiB. A directory inspection is
limited to 4,096 entries.

The planner refuses symbolic or missing parents, dangling or leaf symlinks,
hard-linked files, special files, missing sources, existing destinations, and
preimage hash mismatches. It reads each source through a bounded
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK` descriptor and binds its bytes, digest,
size, metadata, root identity, and every inspected ancestor directory identity.
Filesystem identity integers are decimal strings so canonical JSON does not
lose precision.

Built-in human-only approval paths and any configured protected path whose
resolved class is human-only are refused before source contents are read. The
built-in protected-path classifier covers approval.md control files, including
its credential-bearing `.approval` paths. This planner does not discover or
classify arbitrary secret files. Operators must route any additional sensitive
paths to an appropriate human-only class in policy.

`revalidateWorkspacePlan` repeats validation, classification, and bounded reads,
then requires the entire canonical plan and payload hash to match. This detects
ordinary content, identity, ancestor, policy, actor, and root drift. These
path-based checks do not confine hostile concurrent renames and do not establish
OS custody. The future applying broker needs exclusive workspace write custody
for that guarantee.
