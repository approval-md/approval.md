# The run payload binds the script the argv names

**A grant over a script path used to bind the path.** `approval run` recomputes
its `payload_hash` from the argv and the cwd it is about to spawn, so a human who
approved `bash /tmp/install.sh` approved a NAME, and the bytes behind that name
were whatever the file held at execution time. The requester controls the file
between the request and the grant. Nothing was exploited when this was found
(APRV-398, grant at seq 60837; the script was written before the grant and its
digest is in that task's notes), but the shape was the hazard: the payload hash
is supposed to BE the binding, and for a script invocation it bound a string.

Since APRV-401 the bytes are inside the hash.

## The rule

When the argv names a script, the payload carries that file's size and SHA-256:

```json
{"argv":["bash","scripts/install.sh"],
 "cwd":"/repo",
 "script":{"argv_index":1,
           "path":"/repo/scripts/install.sh",
           "bytes":412,
           "sha256":"fef0e2c47aead8c075d490a9c32b3d1a56bb5e2a51c48643df2551fbd7225202"}}
```

The argv names a script in exactly two shapes:

1. **A known interpreter followed by a path operand.** The interpreters are the
   six shells (`bash`, `sh`, `zsh`, `dash`, `ksh`, `fish`), `node`/`nodejs`,
   `python`/`python3`, `perl`, `ruby` and `deno` — every one of them a name
   `core/command-class.ts` already knows, from its unwrappable-shell set, its
   `node` branch and its inline-source table. `/usr/bin/bash` counts: the match
   is on the last path segment. The operand is the first word after the
   interpreter that resolves to a readable regular file, so options and
   subcommands are walked past rather than stopped at: `deno run job.ts` binds
   `job.ts` and not `run`.
2. **A path at `argv[0]`.** `./install.sh` or `/tmp/install.sh` with no
   interpreter word: the kernel reads the shebang and the script is the program.
   This is the same fact with the interpreter implied rather than typed.

In both shapes the path is resolved against the payload's own `cwd` — never
against the directory the hashing process stands in — and the entry is dropped
if the path is not a readable regular file.

`script` is **omitted when nothing is bound**, and an invocation naming no
readable script therefore hashes to exactly the value it hashed before this rule
existed. Every record already in a log, and every declaration already written
into a task file, still verifies. The absence is the ordinary shape of a payload
with no script to bind; it is not a claim that a runtime looked.

Both ends apply the same rule to the same tree, so every skip is safe. A file
that was unreadable when the declaration was written and readable when the run
happens GAINS the entry and the hashes differ; one that existed and was deleted
LOSES it and the hashes differ. The rule does not have to guess correctly what a
command will do, because a disagreement between the two ends is a refusal.

## What this does NOT reach

1. **An inline program.** `bash -c '…'`, `node -e '…'`, `python3 -c '…'`: the
   program is a word of the argv, so it was always bound and there is no file to
   read. Each interpreter's inline flags are listed beside it in
   `core/run-payload.ts`.
2. **The interpreter itself.** Its bytes are the host's rather than the
   requester's, and resolving a program name through `PATH` would make the
   payload a function of the environment the process holds, which SPEC §11 says
   is never read implicitly. An operator who cannot trust their own `/usr/bin`
   has a problem no payload field repairs.
3. **A launcher this runtime does not name.** The interpreter list is a
   positive list, so a wrapper nobody has added binds nothing. That is the
   documented limit rather than an oversight, and widening it is a task rather
   than a guess: see the note at the end.
4. **Anything transitive.** A bound script that sources another file, pipes a
   download into a shell, or execs a third program binds only its OWN bytes.
   The digest is a binding, not a sandbox. A piped installer (`curl … | sh`)
   has no file operand at all and is unbindable here for the same reason it is
   opaque to the classifier.
5. **The instant between the hash and the spawn.** The digest is taken, then
   `execution.started` is appended, then the child is spawned. A file rewritten
   inside that window runs unbound. Closing it needs an executor that holds the
   BYTES rather than the path, which is the adapter contract of SPEC §10.4 and
   not this verb.
6. **The card is not the check.** The digest an approver reads is inside payload
   material the requester supplied, so it is claimed like the rest of that
   material. What protects the approver is that `approval run` recomputes the
   value from the real tree and refuses on any difference: a payload claiming a
   flattering digest cannot execute, it can only waste a tap. This is SPEC §11.1
   invariant 4 in its ordinary form — a self-reported field that can cause a
   refusal and can never remove one.

## The runbook

```sh
# 1. The declaration, for the task file's action:
approval payload run --hash -- bash scripts/install.sh

# 2. The bytes, for the request (and therefore for the approver's card):
approval payload run -- bash scripts/install.sh \
  | approval request APRV-000 --action "aprv-000:install:2026-09-21" \
      --as agent:lane-b --payload -

# 3. The run, in the SAME directory, with the token the grant printed:
approval run "aprv-000:install:2026-09-21" --token <token> --as agent:lane-b \
  -- bash scripts/install.sh
```

If the script changes between steps 2 and 3, step 3 refuses:

```
approval: payload-mismatch: … The binding also covers the script's bytes
(amended SPEC.md §6.2, APRV-401): argv[1] /repo/scripts/install.sh, 412 bytes,
sha256 fef0… . Nothing was appended.
```

The repair is a fresh request over the new bytes, not a flag. That is the whole
point: the human approved the old script.

## The verb is local, and deliberately not remote

`approval payload run` is **not published** on the MCP wrapper or on `approval
serve`. It digests a file named by the command's own words, which arrive as
trailing argv where no transport guard confines a path the way the store
confinement confines `payload hash`'s positional. A remote caller could
otherwise ask for the SHA-256 of any file the server process can read — say
`-- bash /etc/shadow` — and learn both that the path exists and what its bytes
fingerprint to.

`--cwd` is declared path-typed in the verb registry anyway, because that is the
true statement about the flag whether or not a transport publishes the verb.

The value is only true where the command will run, in any case: compute the
binding there, which is where `approval run` will recompute it.

## SPEC status

SPEC.md has **not** been amended, because the gate was down for this session and
this repository's rule is that an agent proposes a hunk and a human applies it.
The behaviour shipped ahead of the sentence that describes it, which is a
divergence and is called out here rather than left for a reader to find.

One hunk, in §6.2's `payload_hash` row. The sentence today reads:

```
SHA-256 over the RFC 8785 canonical serialization of the action's concrete
payload: for a message send, the full body and recipients; for `approval run`,
the argv array and cwd; for a record write, the proposed record content.
```

The proposed replacement:

```
SHA-256 over the RFC 8785 canonical serialization of the action's concrete
payload: for a message send, the full body and recipients; for `approval run`,
the argv array, the cwd, and the size and SHA-256 of the script that argv
names, omitted entirely when it names none; for a record write, the proposed
record content. A script is a known interpreter followed by a path operand, or
a path at argv[0]; binding it is what makes a grant over `bash install.sh` an
approval of the SCRIPT rather than of its name, since the requester controls
that file between the request and the grant and a payload naming it without
hashing it authorizes bytes no approver saw. An executor MUST recompute the
digest from the tree it is about to spawn into and MUST refuse
`payload-mismatch` on any difference, which is the existing rule of §10.4
applied to the same material. An inline program is already part of the argv;
the interpreter's own bytes, a launcher the implementation does not name,
anything the script itself reads or executes, and the interval between the
recomputation and the spawn are outside the binding, and an implementation
MUST NOT claim otherwise. (Amended APRV-401.)
```

Nothing else in SPEC changes. The refusal code is the existing
`payload-mismatch`, with its registry row (§11.2) unaltered, because the fact it
reports is unchanged: the bytes about to run are not the bytes that were bound.
No event type, no schema and no renderer version moves.

## The card, and the view that was not built

The run payload has no structural view in `core/wysiwys.ts`, so it renders under
the `opaque` kind, whose view is the canonical JSON **whole**: the path, the byte
count and the digest are inside the block every channel prints verbatim, and
inside the `display_hash` the gate records. That is why this task changed no
channel code.

A dedicated `command-run` view would read better than JSON — the command over its
real lines, the cwd beneath it, then the script's path, size and digest. It was
not built here, and the reason is worth stating: SPEC §9 names the renderer
version `approval.md/wysiwys/2` normatively, a new kind changes the bytes that
module emits, and by that module's own rule a change to those bytes is a new
version. A version bump is a SPEC amendment, and this session could not make one.
It is a legibility improvement rather than a security one, since the binding is
the hash either way. Filed as APRV-430.

## The limit that is a choice, and the argument against it

The interpreter list is a positive list, which means it is **fail-open by
omission**: the day a lane runs a launcher nobody added, the binding silently
stops covering the script's bytes. The operator's ruling names that limit
deliberately ("interpreters the classifier does not name" are out of scope), and
this implementation keeps it.

The alternative considered, and implemented first before the ruling was found on
this branch, was to bind EVERY argv word that resolves to a readable regular
file. It has no allowlist to fall behind, and it fails in the safe direction: a
bound file that changes costs one fresh request, while an unbound script that
changes is a substitution nobody sees. Its cost is the mirror of that: a command
naming a file that legitimately churns (a lockfile, a build output, a config)
would refuse until it is re-requested, and refusals that cost a tap for nothing
teach an operator to stop reading them, which is the one lesson this design
cannot afford to teach (the same argument SPEC §10.4 makes about the AgentMail
pre-spend check).

The narrow rule is what ships. The argument above is recorded here so that
widening it later is a decision with its reasoning already written down rather
than a rediscovery.
