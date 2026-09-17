import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { checkCodexHookWiring, registeredHarnesses } from "../src/cli/doctor.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-doctor-codex-"));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

function home(): string {
  counter += 1;
  const dir = join(scratch, String(counter));
  mkdirSync(dir);
  return dir;
}

function handler(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "command",
    command:
      '"/absolute path/to/approval" hook codex --dir "/absolute path/to/primary checkout" --as agent:codex --timeout 9m',
    timeout: 600,
    ...overrides,
  };
}

function hooks(dir: string, value: unknown): void {
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "hooks.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configured(pre = handler(), post = handler()): unknown {
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash|apply_patch", hooks: [pre] }],
      PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [post] }],
    },
  };
}

test("Codex doctor keeps absent configuration separate from trust and execution", () => {
  const check = checkCodexHookWiring(home());
  assert.equal(check.status, "skip");
  assert.match(check.detail, /NOT CONFIGURED on disk/u);
  assert.match(check.detail, /trust and observed execution.+unknown/u);
});

test("Codex doctor recognizes the exact synchronous Pre/Post pair without claiming trust", () => {
  const dir = home();
  hooks(dir, configured());
  const check = checkCodexHookWiring(dir);
  assert.equal(check.status, "pass", check.detail);
  assert.match(check.detail, /CONFIGURED on disk/u);
  assert.match(check.detail, /Bash\|apply_patch/u);
  assert.match(check.detail, /600 second outer timeout/u);
  assert.match(check.detail, /does not establish Codex trust, loading, or observed execution/u);
  assert.deepEqual(registeredHarnesses(dir), ["codex"]);
});

test("Codex doctor reports matcher, timeout, async, and missing outcome profile mismatches", () => {
  const cases: unknown[] = [
    {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [handler()] }],
        PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [handler()] }],
      },
    },
    configured(handler({ timeout: 599 })),
    configured(handler({ async: true })),
    configured(handler({ async: "true" })),
    configured(handler({ command: "echo 'approval hook codex'" })),
    configured(
      handler({
        command:
          'false; "/absolute path/to/approval" hook codex --dir "/absolute path/to/primary checkout" --as agent:codex --timeout 9m',
      }),
    ),
    { hooks: { PreToolUse: [{ matcher: "Bash|apply_patch", hooks: [handler()] }] } },
  ];
  for (const value of cases) {
    const dir = home();
    hooks(dir, value);
    const check = checkCodexHookWiring(dir);
    assert.equal(check.status, "skip", check.detail);
    assert.match(check.detail, /expected APRV-313 profile/u);
    assert.match(check.fix ?? "", /^approval hook codex --help/u);
  }
});

test("Codex doctor does not recognize quoted mentions or compound shell commands", () => {
  const commands = [
    "echo 'approval hook codex'",
    'false; "/absolute path/to/approval" hook codex --dir "/absolute path/to/primary checkout" --as agent:codex --timeout 9m',
  ];
  for (const command of commands) {
    const dir = home();
    hooks(dir, configured(handler({ command }), handler({ command })));
    assert.equal(checkCodexHookWiring(dir).status, "skip");
    assert.deepEqual(registeredHarnesses(dir), []);
  }
});

test("Codex doctor reports TOML presence as unsupported rather than configured", () => {
  const onlyToml = home();
  mkdirSync(join(onlyToml, ".codex"));
  writeFileSync(join(onlyToml, ".codex", "config.toml"), "[hooks]\n", "utf8");
  const unsupported = checkCodexHookWiring(onlyToml);
  assert.equal(unsupported.status, "skip");
  assert.match(unsupported.detail, /does not interpret inline TOML hook tables/u);

  const merged = home();
  hooks(merged, configured());
  writeFileSync(join(merged, ".codex", "config.toml"), "[hooks]\n", "utf8");
  const ambiguous = checkCodexHookWiring(merged);
  assert.equal(ambiguous.status, "skip");
  assert.match(ambiguous.detail, /Codex merges hook sources/u);
  assert.match(ambiguous.detail, /Trust and observed execution remain unknown/u);
});

/**
 * The rollback `docs/codex-activation.md` prescribes, rehearsed (APRV-315).
 *
 * It is a reversible rename and nothing else, so the property worth pinning is
 * that doctor's answer goes all the way back: not to a softer warning, but to
 * the same NOT CONFIGURED line a project that never installed the hook gets,
 * with the harness no longer registered. An agent cannot rehearse this by hand
 * — any path naming `.codex` classifies `policy.core`, human-only, wherever it
 * lives — so the rehearsal lives here, where the fixture is built inside the
 * test process and no Codex configuration on the machine is touched.
 */
test("the documented rollback returns Codex doctor to NOT CONFIGURED, and is reversible", () => {
  const dir = home();
  hooks(dir, configured());
  assert.equal(checkCodexHookWiring(dir).status, "pass");
  assert.deepEqual(registeredHarnesses(dir), ["codex"]);

  const installed = join(dir, ".codex", "hooks.json");
  const disabled = `${installed}.disabled`;
  renameSync(installed, disabled);

  const rolledBack = checkCodexHookWiring(dir);
  assert.equal(rolledBack.status, "skip");
  assert.match(rolledBack.detail, /NOT CONFIGURED on disk/u);
  assert.match(rolledBack.detail, /trust and observed execution are separate and remain unknown/u);
  assert.deepEqual(
    registeredHarnesses(dir),
    [],
    "a disabled file registers no harness: doctor reads the name Codex reads",
  );

  // The disabled copy is still on disk, and putting it back is the whole undo.
  renameSync(disabled, installed);
  assert.equal(checkCodexHookWiring(dir).status, "pass");
});

test("Codex doctor fails visibly for malformed project hook JSON", () => {
  const dir = home();
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".codex", "hooks.json"), "{", "utf8");
  const check = checkCodexHookWiring(dir);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /cannot be read as JSON/u);
  assert.match(check.detail, /trust or execution cannot be inferred/u);
});
