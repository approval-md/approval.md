/**
 * Launching an agent harness is its own class (APRV-354).
 *
 * Before this, a command whose first word was `codex`, `muse`, `grok`, `claude`
 * or `cursor-agent` was `unclassified`. That is fail closed and it is also
 * blunt: it told an approver nothing, it gave a human no class to grant through
 * the ordinary manual path, and a lane that wanted a harness version read
 * `package.json` instead.
 *
 * What this suite pins:
 *
 * 1. every SPELLING reaches the same class — bare, absolute path, home-relative
 *    in both the `~` and `$HOME` forms, env-prefixed, and package-runner — with
 *    the argv bound, for each of the five harnesses;
 * 2. version and help probes are READS with their own rule id, because they
 *    print a string and start nothing;
 * 3. Muse binds its `--model` in both spellings, and a `-contributor` value
 *    takes a distinct rule id. A Standard id is treated exactly as no model at
 *    all: a self-reported field may raise scrutiny and may never lower it;
 * 4. nothing else moved. `approval` verbs, `codex update`, `npx` of a package
 *    this table does not know, and a wrapper that hides the binary all answer
 *    as they did;
 * 5. the classes are enumerable, and every launch and probe rule still counts
 *    as running code the runtime did not author.
 *
 * Pure: no disk, no clock, no log, and NO HARNESS IS EVER RUN. The subject is
 * the classifier, not the binaries — Carter's constraint on Muse makes that
 * non-negotiable, and it holds for all five.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSIFIER_CLASSES,
  CODE_EXECUTING_RULES,
  COMMAND_RULES,
  classifyCommand,
  emittableClass,
} from "../src/core/command-class.js";

function only(command: string): { class: string; rule: string; path?: string } {
  const result = classifyCommand(command);
  assert.equal(
    result.ok,
    true,
    `expected ${JSON.stringify(command)} to classify, got ${
      result.ok ? "" : `${result.code}: ${result.detail}`
    }`,
  );
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, command);
  return result.segments[0] as { class: string; rule: string; path?: string };
}

function refusal(command: string): { code: string; detail: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to be refused`);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, detail: result.detail };
}

// ---------------------------------------------------------------------------
// Criterion 1: five harnesses, six spellings each
// ---------------------------------------------------------------------------

/** binary, harness name, and the package spec a runner would name. */
const HARNESSES: readonly (readonly [string, string, string])[] = [
  ["codex", "codex", "@openai/codex"],
  ["muse", "muse", "muse"],
  ["grok", "grok", "grok"],
  ["claude", "claude", "@anthropic-ai/claude-code"],
  ["cursor-agent", "cursor", "cursor-agent"],
];

for (const [bin, name, pkg] of HARNESSES) {
  const cls = `harness.launch.${name}`;
  const rule = `harness-launch-${name}`;

  test(`${bin}: the bare spelling is ${cls}, with the argv bound`, () => {
    const segment = only(`${bin} run the task`);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
    assert.equal(segment.path, "run the task");
  });

  test(`${bin}: an absolute path is the same launch`, () => {
    const segment = only(`/opt/homebrew/bin/${bin} run the task`);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
    assert.equal(segment.path, "run the task");
  });

  test(`${bin}: a home-relative path is the same launch, in both spellings`, () => {
    for (const home of ["~", "$HOME"]) {
      const segment = only(`${home}/.local/bin/${bin} run the task`);
      assert.equal(segment.class, cls, home);
      assert.equal(segment.rule, rule, home);
      assert.equal(segment.path, "run the task", home);
    }
  });

  test(`${bin}: an env-prefixed invocation is the same launch`, () => {
    const segment = only(`FOO=1 BAR=2 ${bin} run the task`);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
    assert.equal(segment.path, "run the task");
  });

  test(`${bin}: the package-runner spelling is the same launch`, () => {
    const segment = only(`npx ${pkg} run the task`);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
    assert.equal(segment.path, "run the task");
  });

  test(`${bin}: a bare invocation with no arguments is still a launch, nothing bound`, () => {
    const segment = only(bin);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
    assert.equal(segment.path, undefined);
  });

  // Criterion 1, the probe half.
  for (const probe of ["--version", "-V", "--help", "-h", "help"]) {
    test(`${bin} ${probe} is a read, not a launch`, () => {
      const segment = only(`${bin} ${probe}`);
      assert.equal(segment.class, "read.shell");
      assert.equal(segment.rule, "harness-probe");
      assert.equal(segment.path, undefined);
    });
  }

  test(`${bin}: a probe word beside other arguments is a launch, not a probe`, () => {
    // Fail closed. The classifier cannot know which of the two the binary
    // honours, and the stricter reading of an ambiguous invocation is that a
    // session started.
    const segment = only(`${bin} help me refactor this`);
    assert.equal(segment.class, cls);
    assert.equal(segment.rule, rule);
  });
}

test("a versioned package spec still resolves, scope and version told apart", () => {
  const segment = only("npx @openai/codex@0.152.1 exec x");
  assert.equal(segment.class, "harness.launch.codex");
  assert.equal(segment.path, "exec x");
});

test("a package-runner probe is a read, like the direct spelling", () => {
  const segment = only("npx @openai/codex@0.152.1 --version");
  assert.equal(segment.class, "read.shell");
  assert.equal(segment.rule, "harness-probe");
});

test("npx flags before the package do not hide it", () => {
  const segment = only("npx -y @openai/codex exec x");
  assert.equal(segment.class, "harness.launch.codex");
  assert.equal(segment.path, "exec x");
});

test("codex app-server is a launch, which is what APRV-349's probe spawns", () => {
  const segment = only("codex app-server");
  assert.equal(segment.class, "harness.launch.codex");
  assert.equal(segment.rule, "harness-launch-codex");
  assert.equal(segment.path, "app-server");
});

// ---------------------------------------------------------------------------
// Criterion 2: Muse and its model
// ---------------------------------------------------------------------------

test("a muse launch binds the --model value, in both spellings", () => {
  for (const [command, bound] of [
    ["muse --model muse-1-standard", "--model muse-1-standard"],
    ["muse --model=muse-1-standard", "--model=muse-1-standard"],
  ] as const) {
    const segment = only(command);
    assert.equal(segment.class, "harness.launch.muse", command);
    assert.equal(segment.path, bound, command);
    assert.ok(segment.path?.includes("muse-1-standard"), command);
  }
});

test("a --model ending in -contributor takes a distinct rule id, in both spellings", () => {
  for (const command of ["muse --model muse-1-contributor", "muse --model=muse-1-contributor"]) {
    const segment = only(command);
    assert.equal(segment.class, "harness.launch.muse", command);
    assert.equal(segment.rule, "harness-launch-muse-contributor", command);
    assert.ok(segment.path?.includes("muse-1-contributor"), command);
  }
});

test("a contributor model reached through the package runner is marked too", () => {
  const segment = only("npx muse --model=muse-1-contributor");
  assert.equal(segment.class, "harness.launch.muse");
  assert.equal(segment.rule, "harness-launch-muse-contributor");
});

test("a Standard model id is treated exactly as no model at all", () => {
  // The whole of criterion 2's last clause: a self-reported field may RAISE
  // scrutiny and may never lower it, so the classifier must not have a branch
  // in which naming a model makes a launch look better than not naming one.
  const named = only("muse --model muse-1-standard");
  const unnamed = only("muse");
  assert.equal(named.class, unnamed.class);
  assert.equal(named.rule, unnamed.rule);
  assert.equal(named.class, "harness.launch.muse");
  assert.equal(named.rule, "harness-launch-muse");
});

test("a --model with no value is an ordinary launch, never a softer one", () => {
  const segment = only("muse --model");
  assert.equal(segment.class, "harness.launch.muse");
  assert.equal(segment.rule, "harness-launch-muse");
});

test("only muse reads a model; the other harnesses take no branch on it", () => {
  const segment = only("codex --model muse-1-contributor");
  assert.equal(segment.class, "harness.launch.codex");
  assert.equal(segment.rule, "harness-launch-codex");
});

// ---------------------------------------------------------------------------
// Criterion 1, the other half: nothing else moved
// ---------------------------------------------------------------------------

const UNMOVED: readonly (readonly [string, string, string])[] = [
  // The gate's own CLI, including the confined Codex entry point.
  ["approval codex start", "gate.self", "approval"],
  ["approval codex serve", "gate.self", "approval"],
  ["approval hook classify -- x", "gate.self", "approval"],
  // A harness UPGRADE swaps the binary that hosts the hook, and keeps the
  // stricter class it already had (APRV-228).
  ["codex update", "deps.upgrade", "harness-update"],
  ["claude update", "deps.upgrade", "harness-update"],
  // A package runner naming anything else is untouched. `codex-helper` is the
  // case that would break if this matched by substring.
  ["npx codex-helper", "files.write.workspace", "workspace-tool"],
  ["npx some-random-package", "files.write.workspace", "workspace-tool"],
  ["npx tsx scripts/x.ts", "files.write.workspace", "workspace-tool"],
  ["npx", "files.write.workspace", "workspace-tool"],
  ["tsc --noEmit", "files.write.workspace", "workspace-tool"],
  ["backlog task view APRV-354 --plain", "files.write.workspace", "workspace-tool"],
  ["npm test", "files.write.workspace", "npm-script"],
];

for (const [command, cls, rule] of UNMOVED) {
  test(`unchanged: ${command}`, () => {
    const segment = only(command);
    assert.equal(segment.class, cls, command);
    assert.equal(segment.rule, rule, command);
  });
}

test("a wrapper the classifier cannot see through stays unclassified", () => {
  // The binary is the first word, always. A launcher of another name is not a
  // harness row, and reading the SECOND word to find one would be exactly the
  // substring matching this suite exists to forbid.
  assert.equal(refusal("mywrapper codex exec x").code, "unclassified");
  assert.equal(refusal("./run-agent.sh codex exec x").code, "unclassified");
});

test("a binary name the tokenizer cannot expand stays unclassified", () => {
  assert.equal(refusal("$MUSE_BIN exec x").code, "unclassified");
});

test("a harness behind an opaque wrapper is still opaque", () => {
  for (const command of ["sudo codex exec x", "env codex exec x", "xargs codex"]) {
    assert.equal(refusal(command).code, "opaque", command);
  }
});

test("gemini is deliberately not in the family", () => {
  // Its `update` row stays; a bare `gemini` is unclassified, which is where it
  // was. Adding it is somebody's decision to make, not a side effect of this one.
  assert.equal(only("gemini update").class, "deps.upgrade");
  assert.equal(refusal("gemini").code, "unclassified");
});

// ---------------------------------------------------------------------------
// Criterion 5 (partial): the family is enumerable and still executes code
// ---------------------------------------------------------------------------

test("every harness class is in CLASSIFIER_CLASSES and emittable with no policy", () => {
  for (const [, name] of HARNESSES) {
    const cls = `harness.launch.${name}`;
    assert.ok(CLASSIFIER_CLASSES.includes(cls), CLASSIFIER_CLASSES.join(","));
    assert.equal(emittableClass(cls), true, cls);
  }
});

test("the bare family name is NOT a class the table emits", () => {
  // `harness.launch` is a namespace, not an action. Nothing emits it, so a
  // policy line naming it would never fire, and `harness.launch.*` does not
  // match it either (a trailing `.*` consumes one or more segments).
  assert.ok(!CLASSIFIER_CLASSES.includes("harness.launch"));
});

test("every launch and probe rule counts as running code the runtime did not author", () => {
  // Otherwise `npx @openai/codex` would have quietly stopped requiring a
  // sandbox by gaining a better class than `workspace-tool`.
  for (const [, name] of HARNESSES) {
    assert.ok(
      CODE_EXECUTING_RULES.includes(`harness-launch-${name}`),
      `harness-launch-${name} is not in CODE_EXECUTING_RULES`,
    );
  }
  assert.ok(CODE_EXECUTING_RULES.includes("harness-probe"));
  assert.ok(CODE_EXECUTING_RULES.includes("harness-launch-muse-contributor"));
});

test("each generated row is in COMMAND_RULES exactly once, below harness-update", () => {
  const ids = COMMAND_RULES.map((rule) => rule.id);
  const update = ids.indexOf("harness-update");
  assert.ok(update >= 0);
  for (const [, name] of HARNESSES) {
    const id = `harness-launch-${name}`;
    assert.equal(ids.filter((candidate) => candidate === id).length, 1, id);
    assert.ok(ids.indexOf(id) > update, `${id} must sit below harness-update`);
  }
});
