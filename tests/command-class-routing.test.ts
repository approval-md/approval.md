/**
 * `protected_paths` routing to `policy.edit` sub-classes (APRV-266).
 *
 * Its own file rather than more of `tests/command-class.test.ts`, because
 * routing asks a different question of the classifier than the rest of that
 * suite does. Everything there pins the class of a COMMAND against a fixed
 * table; this pins the class of a PATH against a table one policy supplies,
 * and the interesting properties are about the shape of the tier stack rather
 * than about any one command.
 *
 * Four things are load-bearing here and each has its own section:
 *
 * 1. Routing answers with the class the policy named, for both the shell
 *    classifier and the path predicate the file-tool gate uses.
 * 2. The tier order: below `log.mutate`/`policy.core`, above built-in
 *    `policy.edit`. A route can re-label the CI workflow directory and can
 *    never reach the log or the gate's own organs (SPEC.md §11.1 invariant 9).
 * 3. A malformed route matches NOTHING rather than falling back, so the worst
 *    outcome — an author reading a rate that is not the rate in force — cannot
 *    happen even if a caller skipped the loader's validation.
 * 4. Byte-identity: a string-only policy classifies exactly as it did before
 *    the object form existed. This is the compatibility promise, and it is
 *    asserted by classifying the same corpus twice rather than by inspection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCommand,
  emittableClass,
  isProtectedPath,
  parseProtectedEntry,
  protectedPathClass,
  CLASSIFIER_CLASSES,
  POLICY_EDIT_SUBCLASS,
  RESERVED_POLICY_EDIT_SUBCLASSES,
  type ProtectedPathEntry,
} from "../src/core/command-class.js";

/** The routing this repository's own policy is shaped like. */
const ROUTED: readonly ProtectedPathEntry[] = [
  { path: "design/", class: "policy.edit.design" },
  { path: ".github/workflows/", class: "policy.edit.ci" },
  { path: "SPEC.md", class: "policy.edit.spec" },
  "docs/constitution.md",
];

// ---------------------------------------------------------------------------
// 1. A routed entry answers with the class it names
// ---------------------------------------------------------------------------

test("a routed path takes the sub-class its entry names, at any depth", () => {
  for (const path of [
    "design/x.md",
    "./design/x.md",
    "design/sub/deep/x.md",
    "/abs/repo/design/x.md",
  ]) {
    assert.equal(protectedPathClass(path, ROUTED), "policy.edit.design", path);
  }
  for (const path of ["SPEC.md", "./SPEC.md", "/abs/repo/SPEC.md"]) {
    assert.equal(protectedPathClass(path, ROUTED), "policy.edit.spec", path);
  }
});

test("a bare string entry beside routed ones still means policy.edit", () => {
  assert.equal(protectedPathClass("docs/constitution.md", ROUTED), "policy.edit");
});

test("a routed path is still a protected path", () => {
  // `isProtectedPath` is what the hook's file-tool gate and the CI guard ask
  // before they ask which surface it is. A routing that made a path stop
  // counting as protected would be the exact narrowing APRV-107 forbids.
  assert.equal(isProtectedPath("design/x.md", ROUTED), true);
  assert.equal(isProtectedPath("README.md", ROUTED), false);
});

test("the shell classifier reports the routed class for a write to that path", () => {
  const result = classifyCommand("sed -i '' s/a/b/ design/notes.md", ROUTED);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["policy.edit.design"]);
  assert.equal(result.segments[0]?.path, "design/notes.md");
});

test("reading a routed path is still a read", () => {
  // Routing changes which class a WRITE takes and nothing else. `cat` over a
  // protected path has never been `policy.edit` and must not become
  // `policy.edit.design` either.
  const result = classifyCommand("cat design/notes.md", ROUTED);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("the strictest surface still wins within one segment", () => {
  // A segment naming both a routed path and the gate's own organs is a
  // `policy.core` segment. A routed sub-class ranks where `policy.edit` ranks,
  // which is below `policy.core`, so nothing here changed.
  const result = classifyCommand("cp design/notes.md APPROVAL.md", ROUTED);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["policy.core"]);
});

// ---------------------------------------------------------------------------
// 2. The tier order
// ---------------------------------------------------------------------------

test("a route can re-label a built-in policy.edit path", () => {
  // The whole point: `.github/workflows/` is protected by the runtime whatever
  // a policy says, and a project that wants every CI edit on the phone while
  // its specification is sampled needs to be able to name that surface.
  assert.equal(protectedPathClass(".github/workflows/ci.yml", ROUTED), "policy.edit.ci");
  assert.equal(protectedPathClass("CLAUDE.md", ROUTED), "policy.edit");
});

test("a route can NEVER reach the log or the gate's own organs", () => {
  // The loader refuses such a policy outright (`protected-route-floor`), so
  // this asserts the second line of defence: even handed the entry directly,
  // the matcher answers with the built-in surface. §11.1 invariant 9 — a
  // policy widening its own protected surface mints no authority — holds at
  // the one place a policy could otherwise have reached past it.
  const reaching: readonly ProtectedPathEntry[] = [
    { path: ".approval/", class: "policy.edit.home" },
    { path: "APPROVAL.md", class: "policy.edit.core" },
    { path: ".approval/log/", class: "policy.edit.log" },
  ];
  assert.equal(protectedPathClass(".approval/QUEUE.md", reaching), "policy.core");
  assert.equal(protectedPathClass("APPROVAL.md", reaching), "policy.core");
  assert.equal(protectedPathClass(".approval/log/events.jsonl", reaching), "log.mutate");
});

test("among routed entries the most specific wins, and order breaks a tie", () => {
  const nested: readonly ProtectedPathEntry[] = [
    { path: "design/", class: "policy.edit.design" },
    { path: "design/frozen/", class: "policy.edit.spec" },
  ];
  assert.equal(protectedPathClass("design/notes.md", nested), "policy.edit.design");
  assert.equal(protectedPathClass("design/frozen/adr-1.md", nested), "policy.edit.spec");

  const tied: readonly ProtectedPathEntry[] = [
    { path: "design/", class: "policy.edit.design" },
    { path: "design/", class: "policy.edit.spec" },
  ];
  assert.equal(protectedPathClass("design/notes.md", tied), "policy.edit.design");
});

// ---------------------------------------------------------------------------
// 3. Names, reserved and minted
// ---------------------------------------------------------------------------

test("the namespace is exactly one lowercase segment under policy.edit", () => {
  for (const name of [
    "policy.edit.spec",
    "policy.edit.harness",
    "policy.edit.ci",
    "policy.edit.design",
    "policy.edit.rfc",
    "policy.edit.house-rules",
    "policy.edit.a1",
  ]) {
    assert.equal(POLICY_EDIT_SUBCLASS.test(name), true, name);
  }
  for (const name of [
    "policy.edit",
    "policy.core",
    "log.mutate",
    "policy.edit.",
    "policy.edit.CI",
    "policy.edit.ci.release", // two segments: the namespace is closed at one
    "policy.editor",
    "policy.edit.1ci", // must start with a letter
    "files.write.workspace",
    "",
  ]) {
    assert.equal(POLICY_EDIT_SUBCLASS.test(name), false, name);
  }
});

test("the reserved names are reserved, and an author may mint beside them", () => {
  assert.deepEqual(Object.keys(RESERVED_POLICY_EDIT_SUBCLASSES).sort(), [
    "policy.edit.ci",
    "policy.edit.design",
    "policy.edit.harness",
    "policy.edit.spec",
  ]);
  for (const [name, meaning] of Object.entries(RESERVED_POLICY_EDIT_SUBCLASSES)) {
    assert.equal(POLICY_EDIT_SUBCLASS.test(name), true, name);
    assert.ok(meaning.length > 0, `${name} must document what it means`);
  }
  // A minted name is not second-class: it routes exactly as a reserved one
  // does, and carries only the meaning its own policy line gives it.
  const minted: readonly ProtectedPathEntry[] = [
    { path: "rfcs/", class: "policy.edit.rfc" },
  ];
  assert.equal(protectedPathClass("rfcs/0001.md", minted), "policy.edit.rfc");
});

test("a malformed route matches nothing rather than falling back to policy.edit", () => {
  // A silent fallback would be the worst of the three available answers: the
  // author reads their file and sees a rate that is not in force. The loader
  // refuses these, so this only ever fires for a caller that skipped it.
  for (const bad of ["policy.core", "log.mutate", "policy.edit", "files.write", "POLICY.EDIT.CI"]) {
    const entry: ProtectedPathEntry = { path: "rfcs/", class: bad };
    assert.equal(parseProtectedEntry(entry), null, bad);
    assert.equal(protectedPathClass("rfcs/0001.md", [entry]), null, bad);
  }
  // And a well-formed class over a malformed path is equally inert.
  for (const path of ["", "   ", "..", "../", "/"]) {
    const entry: ProtectedPathEntry = { path, class: "policy.edit.rfc" };
    assert.equal(parseProtectedEntry(entry), null, JSON.stringify(path));
  }
});

// ---------------------------------------------------------------------------
// 4. Reachability, asked with the policy in hand
// ---------------------------------------------------------------------------

test("emittableClass answers for the fixed table without any policy", () => {
  for (const cls of CLASSIFIER_CLASSES) {
    assert.equal(emittableClass(cls), true, cls);
  }
  assert.equal(emittableClass("not.a.class"), false);
});

test("a routed class is emittable exactly when an entry routes to it", () => {
  assert.equal(emittableClass("policy.edit.design", ROUTED), true);
  assert.equal(emittableClass("policy.edit.ci", ROUTED), true);
  // Declared in `classes` but routed nowhere: a line that will never fire, and
  // saying so at the ceremony is the whole point of the check that calls this.
  assert.equal(emittableClass("policy.edit.harness", ROUTED), false);
  assert.equal(emittableClass("policy.edit.design", []), false);
  // Outside the namespace, no policy can make it emittable.
  assert.equal(emittableClass("policy.core.custom", ROUTED), false);
});

// ---------------------------------------------------------------------------
// 5. Byte-identity for a string-only policy
// ---------------------------------------------------------------------------

/**
 * A corpus spanning every protected tier and a few unprotected commands.
 *
 * Classified twice — once through the old `readonly string[]` shape and once
 * through the widened `readonly ProtectedPathEntry[]` carrying the same
 * strings — and compared structurally. `deepEqual` over the whole
 * classification, not just the classes, because `rule` and `path` are what the
 * approver reads and a drift in either would be a changed prompt.
 */
const CORPUS: readonly string[] = [
  "echo x >> CLAUDE.md",
  "sed -i '' s/a/b/ AGENTS.md",
  "echo x >> APPROVAL.md",
  "cp .approval/QUEUE.md /tmp/queue.md",
  "echo x >> .approval/log/events.jsonl",
  "git checkout -- .github/workflows/ci.yml",
  "tee SPEC.md",
  "mv notes.md design/notes.md",
  "cat docs/constitution.md",
  "npm test",
  "git status",
  "rm -rf build",
];

test("a string-only policy classifies byte for byte as it always did", () => {
  const asStrings: readonly string[] = ["SPEC.md", "design/", "docs/constitution.md"];
  const asEntries: readonly ProtectedPathEntry[] = [...asStrings];
  for (const command of CORPUS) {
    assert.deepEqual(
      classifyCommand(command, asEntries),
      classifyCommand(command, asStrings),
      command,
    );
  }
  // And with no policy list at all, which is how a caller that forgot one is
  // handled: the built-ins alone, the strictly narrower answer.
  for (const command of CORPUS) {
    assert.deepEqual(classifyCommand(command, []), classifyCommand(command), command);
  }
});

test("a string-only policy never reaches the routed tier", () => {
  const asStrings: readonly ProtectedPathEntry[] = ["SPEC.md", "design/"];
  for (const path of ["SPEC.md", "design/x.md", "CLAUDE.md", ".github/workflows/ci.yml"]) {
    const surface = protectedPathClass(path, asStrings);
    assert.equal(
      POLICY_EDIT_SUBCLASS.test(surface ?? ""),
      false,
      `${path} resolved to ${String(surface)}, which is a routed class`,
    );
  }
});
