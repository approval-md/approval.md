# Codex hook event fixtures

The individual JSON files are synthetic, native-shaped inputs for the APRV-310
probe sanitizer. They contain no captured transcript, credential, account
identifier, or real model output.

`native-v5.sanitized.jsonl` is the separately reviewed output of the bounded
Codex CLI 0.152.1 native v5 run. It contains 15 sanitized events. That older
sanitizer replaced every identifier with one generic placeholder, so the file
does not prove Pre/Post correlation or distinct tool-call identity. It does
prove the observed event and input shapes and that successful and exit-7 Bash
calls both produced an empty-string `tool_response`. New native runs use stable,
domain-separated pseudonyms that preserve relationships without retaining raw
identifiers.

`native-v6.sanitized.jsonl` is the reviewed 18-event follow-up. It proves exact
once Pre/Post correlation for allowed Bash and patch calls, distinct tool-call
identities, identity allow acceptance, and shell and patch denial. It also
captures the blocking directory fact: a controlled Bash effect landed in the
requested nested tool working directory, while `tool_input` contained only
`command` and both the event cwd and hook process cwd remained the scratch root.
The adapter therefore cannot bind that tool call to its real execution
directory from the native event.

`native-v7-patch-workdir.sanitized.jsonl` is the reviewed one-call focus run.
An `apply_patch` heredoc sent through `exec_command` with a nested workdir was
reported only as `Bash`, with the full heredoc command and no directory field.
The effect landed in the nested directory. No PostToolUse was observed. The
production adapter's new unconditional Bash refusal covers this observed route;
the native v7 hook itself allowed the call. This run does not establish a native
directory contract for direct `apply_patch` tool calls.
