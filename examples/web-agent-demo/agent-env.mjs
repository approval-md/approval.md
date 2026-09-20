/**
 * The agent child's world: its home, and the closed environment it is spawned
 * with (APRV-177, extracted by APRV-168).
 *
 * `server.mjs` is the only thing that spawns that child, and for a long time
 * this was three constants and a function inside it. It moved here the day a
 * rehearsal proved that two other programs need the SAME answer rather than a
 * description of it:
 *
 *   - `examples/demo-provision.mjs --check`, whose preflight now resolves the
 *     finale's credential in the child's shape before a room is booked, and
 *   - `tests/demo-finale-credential.test.ts`, which runs the real adapter verb
 *     in that shape and would prove nothing at all against a copy of it.
 *
 * A second copy of an environment contract is a contract that drifts, and the
 * thing it would drift away from is a scrub whose whole job is to be exact.
 *
 * Nothing here reads a credential, and nothing here writes a file.
 */

import { join } from "node:path";

/**
 * The agent child's entire world outside the repository (APRV-177).
 *
 * Before this existed the child was handed the operator's `HOME`, and a
 * `claude -p` given the operator's home directory is given the operator: their
 * installed plugins, their connected MCP servers, their user memory, their
 * slash commands and their hooks all loaded into a session an attendee is
 * typing prompts at. `--allowedTools mcp__approval__*` kept any of it from
 * being *used* silently, which is not the same as it not being there — a demo
 * that behaves differently on every laptop, and puts the operator's setup on a
 * projector, is a demo with an unowned dependency.
 *
 * So the child gets a home the demo owns, generated fresh at startup and thrown
 * away with the instance: `HOME` here, `CLAUDE_CONFIG_DIR` at `claude-config/`
 * inside it, and in that directory exactly two files `server.mjs` writes — a
 * settings file with no hooks and no plugins, and a `CLAUDE.md` that says what
 * the session is.
 */
export function agentHomeFor(demoDir) {
  return join(demoDir, "agent-home");
}

/** `CLAUDE_CONFIG_DIR` for that home. */
export function agentConfigDirFor(demoDir) {
  return join(agentHomeFor(demoDir), "claude-config");
}

/**
 * The credential names that cross into the child, and the complete list of
 * them (APRV-177).
 *
 * This used to be the prefix test `ANTHROPIC_*` / `CLAUDE_*`, which is the
 * wrong shape for the job: it passes whatever the operator's shell happens to
 * hold under those prefixes, including `CLAUDE_CONFIG_DIR` itself, which would
 * hand the child straight back the personal configuration the rest of this
 * design exists to keep out of it. An allowlist can only pass what is on it.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is the documented path: the child's `HOME` is the
 * demo's, so a keychain login in the operator's account is invisible to it and
 * a token from `claude setup-token` is what actually authenticates. The
 * `ANTHROPIC_*` three are the API-key alternative for a machine set up that
 * way.
 */
export const AGENT_CREDENTIAL_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
];

/**
 * The names no value may travel under, whatever list it is on: the gate's own
 * secrets and identity.
 */
export const SCRUBBED_NAMES = /APPROVAL|VAULT|TELEGRAM|TG_/u;

/**
 * The environment the agent child gets: PATH, a home the demo generated, and
 * exactly the credential the server was given. Nothing else.
 *
 * The read verbs run with PATH and nothing else, and the agent would too if it
 * did not need to authenticate. What it does NOT get is as deliberate:
 *
 *   - not the operator's `HOME`, and so not their plugins, their connected MCP
 *     servers, their memory, their slash commands or their hooks (APRV-177 —
 *     see {@link agentHomeFor});
 *   - not the gate's own secrets. `APPROVAL_HUMAN` would let the child speak
 *     as a human, and the vault passphrase and the Telegram token are the
 *     approver's, not the agent's. `server.mjs` should not be holding any of
 *     them in the first place (it warns at startup if it is), and it certainly
 *     does not hand them on;
 *   - not any other variable of the operator's shell, whatever it is named.
 *     The list is closed, so a name nobody thought about here does not travel.
 *
 * `XDG_*` are pinned under the demo home rather than left unset, because an
 * unset one falls back to `~/.config` and `~/.cache` — which, with `HOME`
 * already redirected, is harmless, and pinning them says so out loud instead of
 * relying on it.
 *
 * **`HOME` is why the finale needed APRV-168.** The adapter that sends the
 * demo's email runs under this environment, holding a token a human approved,
 * and the vault passphrase it needs is a `keychain:` line in the instance's own
 * `.approval/env`. macOS finds the login keychain through `HOME`, so that
 * lookup answered "no such item" until `core/env-file.ts` learned to retry it
 * with the passwd home. Nothing about this scrub changed, and nothing about it
 * should: the passphrase is resolved BY THE CHILD, inside the token window, and
 * never travels from a process that should not be holding it.
 */
export function agentEnv(demoDir, sourceEnv = process.env) {
  const home = agentHomeFor(demoDir);
  const env = {
    PATH: sourceEnv.PATH ?? "",
    HOME: home,
    CLAUDE_CONFIG_DIR: agentConfigDirFor(demoDir),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
  };
  for (const name of AGENT_CREDENTIAL_ENV) {
    const value = sourceEnv[name];
    // Belt and braces: no gate credential can wear one of these names by
    // accident either.
    if (value === undefined || SCRUBBED_NAMES.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** Which credential names actually made the crossing. For the banner. */
export function agentCredentialNames(sourceEnv = process.env) {
  return AGENT_CREDENTIAL_ENV.filter((name) => sourceEnv[name] !== undefined);
}
