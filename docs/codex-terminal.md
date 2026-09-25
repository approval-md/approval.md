# Everyday Codex terminal bridge

`approval codex bridge --interactive` starts one `codex app-server` child and one thread in the selected workspace. It runs a preflight turn once, then reads prompts from the terminal and starts each turn after the previous turn completes. The Codex CLI must already be installed and signed in. The gate root must already have a configured and attested policy, a verified log, and a working human decision channel.

```sh
GATE_ROOT=/path/to/gate
WORKSPACE=/path/to/workspace

approval codex bridge --interactive \
  --dir "$GATE_ROOT" \
  --log "$GATE_ROOT/.approval/log/events.jsonl" \
  --workspace "$WORKSPACE"
```

`--dir` selects the gate root, where policy and default log discovery happen. `--log` can name that gate's log explicitly. `--workspace` selects where Codex works; it does not select the gate. `--prompt 'first task' --interactive` starts with that task and then opens the prompt. The one-shot command remains `approval codex bridge --prompt 'task'`. Interactive mode requires terminal stdin and refuses `--json`.

Run an already configured decision channel in another terminal while the bridge waits. The local channel needs no network service:

```sh
approval channel cli \
  --policy-dir "$GATE_ROOT" \
  --log "$GATE_ROOT/.approval/log/events.jsonl" \
  --as human:carter
```

If this gate already uses Telegram, its existing listener can instead run with `approval channel telegram listen --dir "$GATE_ROOT" --log "$GATE_ROOT/.approval/log/events.jsonl" --as human:carter`. A configured listener is not evidence that a request was delivered or answered; check the decision record and the listener's own output.

The terminal prints agent messages and approval progress. At `codex>`, enter another prompt, `/quit`, or Ctrl-D. Ctrl-C, a failed turn, or an unexpected app-server exit stops with a nonzero exit. Ending an idle prompt exits cleanly. A turn that failed is never reported as completed.

The bridge requests `approvalPolicy: "untrusted"` and `sandbox: "read-only"`. App-server setup and active-turn silence are bounded separately from `--wait`, which governs time spent waiting for a human decision. `--lifecycle-timeout` changes that protocol-silence bound. The owned child receives `SIGTERM` on shutdown and is killed if it does not exit.

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Configuration | The requested policy, sandbox, gate paths and channel settings | That a question reached this bridge or a person |
| Preflight observed | One probe command produced a question that reached this client | That every later question will arrive, or that an auto-reviewer is absent |
| Per-turn report | Turn id, terminal status and number of approval questions answered | The execution result of an accepted tool call |
| Coverage/native outcome | A separately verified, correlated native completion | Broader sessions, other children or uncorrelated effects |

The app-server child belongs to this process over stdio. Only sessions launched with this command use this bridge. An accepted question is an authorization, while actual execution remains **unknown** until a verified, correlated native completion can close it. JSON reports expose `turns[]` with `{id,status,answers}` and each answer's `threadId`, `turnId`, `itemId`, and `executionOutcome`. They do not infer success from a reply or a completed turn.

To diagnose a stop, run the same command with `--prompt 'task' --json` for a one-shot report. Read its `code`, `thread`, `preflight`, `turns`, and `answers` fields. `bridge-preflight-void` means the model ran no probe command, `bridge-approval-policy-mismatch` means the policy proof failed, `bridge-server-silent` means setup or an active turn stopped producing bound protocol traffic, and `bridge-request-mismatch` means a question did not name the active thread and turn. A refused question has no gate authorization. The full protocol evidence and its version limits are in [the app-server bridge note](codex-app-server-bridge.md).
