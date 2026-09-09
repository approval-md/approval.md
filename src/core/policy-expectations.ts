/**
 * Policy PINS: what a policy file is expected to resolve to, as data (APRV-203).
 *
 * The repository's own policy file has always been pinned: the dogfood suite in
 * `tests/` asserts the autonomy and provenance the matcher resolves for every class
 * the policy declares, so an edit that changes what the gate does fails `npm test`
 * rather than being discovered by an agent doing something it should not have been
 * allowed to do. The pins lived inside that test file, which meant the amendment
 * ceremony could not read them: `approval policy amend` would attest, commit and
 * push a policy edit whose pins nobody had updated, and CI found out afterwards.
 *
 * So the pins moved here, to a module the test and the ceremony both import, and
 * `policy amend` runs {@link checkPolicyExpectations} against the AMENDED file
 * before it pushes anything. One home for the pins; two readers.
 *
 * ## Why this module knows about one particular repository
 *
 * These pins are facts about approval.md's own policy, and no other repository's
 * policy has anything to do with them. {@link expectationsFor} therefore answers
 * them only when the policy being amended belongs to the `approval-md` package
 * itself, and answers `null` everywhere else, where the ceremony simply says it
 * has no expectation set to check. A shipped CLI that applied this repository's
 * pins to a user's policy would refuse every amendment they ever made.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { emittableClass } from "./command-class.js";
import type { Autonomy, PolicyLoadResult } from "./policy-load.js";
import { resolve, type Provenance } from "./policy-match.js";

/** One pinned class resolution. */
export interface PolicyExpectation {
  actionClass: string;
  autonomy: Autonomy;
  provenance: Provenance;
  /** Why this pin reads the way it does. Printed with a failure. */
  note?: string;
}

/**
 * The pins for this repository's `APPROVAL.md`.
 *
 * ## What earns a pin (APRV-296)
 *
 * A pin is a class whose LOOSENING is a security regression, so the ceremony
 * refuses before the bytes are attested rather than after CI reads them. Three
 * families qualify and nothing else does: the `human-only` classes, where a
 * looser level would mint agent authority over the gate's own organs; the
 * `manual` classes whose looser level puts an irreversible or third-party
 * effect behind no human; and the fail-closed DEFAULT itself, pinned through
 * classes the policy deliberately does not declare, so a policy that stopped
 * defaulting to `manual` fails here even though every declared class still
 * resolves as written. Each pin's note says which of those it is and what the
 * loosening would cost.
 *
 * Until APRV-296 the list also pinned every OTHER class the policy declared,
 * in both directions, and the 2026-09-07 ceremony is what that cost: a one-line
 * TTL change plus one newly declared class turned into three failed runs,
 * because tuning `vcs.pr.create` or `log.advance` was also a code change to be
 * built before the ceremony would accept it. Those pins protected nothing —
 * loosening a class that is already `autonomous` is not a direction, and the
 * dangerous direction for `vcs.push.main` is held by the irreversibility floor
 * (SPEC.md §7), which `tests/dogfood.test.ts` pins on its own. Every
 * resolution change, pinned or not, still prints in the ceremony's semantic
 * diff and is still attested by a human who read it.
 *
 * A class this list does NOT name is accepted, in the ceremony and in the
 * dogfood suite alike: declaring a new `supervised` or `autonomous` class is a
 * policy amendment and needs no code change. The other direction still fails —
 * a pin naming a class the policy no longer resolves that way is a refusal,
 * which is the whole point of the list.
 */
export const REPO_POLICY_EXPECTATIONS: readonly PolicyExpectation[] = [
  // ---------------------------------------------------------------------
  // human-only — a person acts; no verb mints or withdraws authority
  // (APRV-185); declared at the seq 7355 ceremony. Loosening ANY of these to a
  // level an agent can reach is the regression SPEC.md §11.1 invariant 9
  // forbids: these four are the gate's own organs and the record of what
  // happened, and a policy may not grant an agent authority over them.
  // ---------------------------------------------------------------------
  {
    actionClass: "vcs.history.rewrite",
    autonomy: "human-only",
    provenance: "rule",
    note: "manual until seq 7355; a person rewrites shared history, never an agent. Loosened, an agent could rewrite the history that carries the log's commits, which is the evidence every later verification reads",
  },
  {
    actionClass: "policy.core",
    autonomy: "human-only",
    provenance: "rule",
    note: "APPROVAL.md and .approval/* outside the log; split out of policy.edit by APRV-198 so the 0.1 sample never sits on the gate's own organs. Loosened, an agent could edit the file that decides what agents may do, which is every other control at once",
  },
  {
    actionClass: "log.mutate",
    autonomy: "human-only",
    provenance: "rule",
    note: "any write aimed at .approval/log/ (APRV-198). Loosened, an agent could write the append-only log directly, and the log is the truth every projection and every verdict is rebuilt from",
  },
  {
    actionClass: "account.credential",
    autonomy: "human-only",
    provenance: "rule",
    note: "keychain readers, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194). Loosened, an agent could read the channel and vault secrets, and an agent holding the approver's credentials can approve itself",
  },

  // ---------------------------------------------------------------------
  // manual — the classes whose effects leave this repository or cannot be
  // undone. Loosening one moves a human decision into an agent's own hands.
  // ---------------------------------------------------------------------
  {
    actionClass: "deps.add",
    autonomy: "manual",
    provenance: "rule",
    note: "loosened, an agent adds a package this project then runs, in the build and in CI: code nobody here reviewed, reaching the supply chain with no human in the path",
  },
  {
    actionClass: "network.call",
    autonomy: "manual",
    provenance: "rule",
    note: "re-tightened 2026-08-20 (attested seq 293) once APRV-114 taught the classifier that GET-shaped fetches are read.web, so this class now covers only the mutating and ambiguous remainder. Loosened, an agent could write to a third-party system, which is an effect no local revert reaches",
  },
  {
    actionClass: "release.publish",
    autonomy: "manual",
    provenance: "rule",
    note: "loosened, an agent could publish bytes to a public registry under this project's name; a published version is permanent, and users install what it ships",
  },
  {
    actionClass: "policy.edit.ci",
    autonomy: "manual",
    provenance: "rule",
    note: "routed from .github/workflows/ at the 2026-09-06 ceremony (APRV-266): every CI and release-configuration edit is a tap. Loosened, an agent could edit the workflows that are this repository's other enforcement path, including the job that runs this very check",
  },
  {
    actionClass: "files.delete.out_of_scope",
    autonomy: "manual",
    provenance: "rule",
    note: "loosened, an agent could delete files outside its task's stated scope, and a deletion is found by a reader missing something rather than by the gate",
  },

  // ---------------------------------------------------------------------
  // the fail-closed DEFAULT, pinned through classes the policy does not
  // declare. `defaults.autonomy: manual` is asserted directly by the dogfood
  // suite; these three prove the same thing where it actually decides —
  // an action nobody wrote a rule for. Loosening the default is the widest
  // regression this file can catch: it grants every class nobody thought of.
  // ---------------------------------------------------------------------
  {
    actionClass: "communicate.email.external",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared class: the absence of a grant is not a grant. Loosened (a permissive defaults.autonomy, or a wildcard rule that swallowed it), an agent could send mail to a third party under this operator's name without a decision anybody made",
  },
  {
    actionClass: "deps.upgrade",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared, so the manual default holds; since APRV-228 the classifier emits it for the harness self-update verbs (claude/codex/gemini update, uca) as well as npm update. Loosened, an agent could move its own harness version or the dependency tree it runs on, unreviewed; a ceremony that declares the class moves this pin deliberately",
  },
  {
    actionClass: "read",
    autonomy: "manual",
    provenance: "default",
    // SPEC.md §5.2 (amended): a trailing `.*` matches ONE OR MORE segments, so
    // `read.*` is the namespace *under* `read` and does not cover the bare class
    // `read`. A policy wanting the bare class covered must list it as its own
    // rule; the repo policy does not, so `read` falls to the manual default.
    note: "bare namespace is NOT matched by read.* (SPEC.md §5.2). This pin holds the wildcard grammar itself: were `read.*` ever to cover the bare class, every read the classifier could not place would resolve autonomous instead of falling to the manual default",
  },
];

/**
 * One way the amended policy failed its pins. Machine-readable by `kind`.
 *
 * `unpinned` was a fourth kind until APRV-296, raised when the policy declared
 * a class this list did not name. It is gone with the rule that produced it: a
 * declared class carrying no pin is now accepted, so declaring a `supervised`
 * or `autonomous` class is a policy amendment and not also a code change.
 */
export interface ExpectationFailure {
  kind: "resolution" | "floor" | "unreachable";
  actionClass: string;
  expected: string;
  actual: string;
  note?: string;
}

/**
 * One pin, as the source line a human pastes into {@link REPO_POLICY_EXPECTATIONS}.
 *
 * The single-line form the list already uses for a pin with no note. A pin
 * worth a note gets one from the person who knows why it reads that way, which
 * is not something a resolution can supply — and since APRV-296 every pin in
 * that list is worth a note, because a pin exists only where loosening the
 * class would be a regression and the note is where that argument is written.
 *
 * No refusal prints this line any more. The ceremony used to hand it to an
 * operator whose policy declared an unpinned class; nothing is unpinned now, so
 * this is the spelling a human uses when they decide a NEW class belongs in the
 * safety set. Printed, never applied: no verb in this repository writes the
 * pins file.
 */
export function pinLine(actionClass: string, autonomy: string, provenance: string): string {
  return `  { actionClass: ${JSON.stringify(actionClass)}, autonomy: ${JSON.stringify(
    autonomy,
  )}, provenance: ${JSON.stringify(provenance)} },`;
}

/** One line per failure, in the shape a terminal and a `--json` array share. */
export function describeFailure(failure: ExpectationFailure): string {
  return `${failure.actionClass}: expected ${failure.expected}, got ${failure.actual}${
    failure.note === undefined ? "" : ` (${failure.note})`
  }`;
}

/**
 * Check a loaded policy against its pins.
 *
 * Three ways to fail. A pinned class that no longer resolves as pinned is the
 * one the list exists for: the pins name only classes whose loosening is a
 * regression (APRV-296), so a failure here is a policy that moved one of them.
 * A pinned resolution the irreversibility floor decided is a pin that stopped
 * measuring the rule. And a class the command classifier cannot emit is a
 * policy line that will never fire.
 *
 * What is NOT a failure, since APRV-296: a class the policy declares and this
 * list does not pin. The pins are a safety floor rather than an inventory, and
 * a policy declaring a new `supervised` or `autonomous` class needs no code
 * change to be accepted. The resolution still prints in the ceremony's semantic
 * diff, where a human reads it before attesting.
 */
export function checkPolicyExpectations(
  load: PolicyLoadResult,
  expectations: readonly PolicyExpectation[],
): { ok: boolean; failures: ExpectationFailure[] } {
  const failures: ExpectationFailure[] = [];
  if (!load.ok) {
    return {
      ok: false,
      failures: [
        {
          kind: "resolution",
          actionClass: "(the file)",
          expected: "a policy that parses",
          actual: `${load.code}: ${load.message}`,
        },
      ],
    };
  }

  for (const expectation of expectations) {
    const resolution = resolve(load, expectation.actionClass);
    const expected = `${expectation.autonomy}/${expectation.provenance}`;
    const actual = `${resolution.autonomy}/${resolution.provenance}`;
    if (actual !== expected) {
      failures.push({
        kind: "resolution",
        actionClass: expectation.actionClass,
        expected,
        actual,
        ...(expectation.note === undefined ? {} : { note: expectation.note }),
      });
      continue;
    }
    if (resolution.floorApplied) {
      failures.push({
        kind: "floor",
        actionClass: expectation.actionClass,
        expected: "no irreversibility floor on the default path",
        actual: "the floor decided this resolution",
      });
    }
  }

  const declared = Object.keys(load.policy.classes ?? {}).filter((pattern) => !pattern.includes("*"));
  for (const actionClass of declared) {
    // APRV-266: reachability is asked WITH the policy's own `protected_paths`,
    // because a `policy.edit` sub-class is emitted only where an entry routes a
    // path family to it. The question is the one this check always asked —
    // would this line ever fire? — and a routed class nothing routes to still
    // answers no, which is the case worth catching: a `policy.edit.ci` rule
    // whose routing was deleted looks like protection and is not.
    if (!emittableClass(actionClass, load.policy.protected_paths ?? [])) {
      failures.push({
        kind: "unreachable",
        actionClass,
        expected: "a class the command classifier can emit",
        actual:
          "no rule in src/core/command-class.ts emits it and no protected_paths entry routes to it, so the policy line would never fire",
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/** The name of the module a human edits when a pin has to move. */
export const EXPECTATIONS_MODULE = "src/core/policy-expectations.ts";

/**
 * The dogfood suite, in source and as the build output that actually runs
 * (APRV-274). Repo-relative, so a caller joins them onto the repository root.
 *
 * Both spellings are needed and they answer different questions. The SOURCE
 * says whether this repository has a dogfood suite at all, which is what keeps
 * the ceremony inert in somebody else's checkout. The BUILT file is what a
 * ceremony runs, and its absence beside a present source is a stale build: the
 * pins the suite would read are the ones in `dist/`, so a ceremony that ran the
 * suite there would be checking the previous edit's pins.
 */
export const DOGFOOD_SUITE_SOURCE = "tests/dogfood.test.ts";
export const DOGFOOD_SUITE_BUILT = "dist/tests/dogfood.test.js";

/**
 * The body of `const <constant> … = [ … ];` in `text`, or the whole text when
 * no such declaration is there.
 *
 * The scope is what keeps the reader honest about which `actionClass` mentions
 * are pins. The fallback is deliberately permissive rather than empty: this is
 * a display reader over somebody's edited file, and a version whose declaration
 * it cannot find is better reported approximately than reported as no pins at
 * all. A `constant` that is not a plain identifier is refused outright rather
 * than interpolated into a pattern.
 */
function pinsArrayOf(text: string, constant: string): string {
  if (!/^[A-Za-z_$][\w$]*$/u.test(constant)) return text;
  // `const <name>` and not a bare mention: the name appears in prose above the
  // declaration, and a match there would scope the read to a doc comment. The
  // type annotation between the name and the `=` may itself carry brackets
  // (`readonly PolicyExpectation[]`), so only the newline bounds the middle.
  const declared = new RegExp(`\\bconst\\s+${constant}\\b[^=\\n]*=\\s*\\[`, "u").exec(text);
  if (declared === null) return text;
  const from = declared.index + declared[0].length;
  const end = text.indexOf("\n];", from);
  return end < 0 ? text.slice(from) : text.slice(from, end);
}

/** One pin as the source text spells it: what class, resolving to what. */
export interface PinSourceEntry {
  actionClass: string;
  /** `autonomy/provenance` as written, or `null` where the text is unreadable. */
  resolution: string | null;
}

/**
 * How one class's pin moved between two versions of the pins module.
 *
 * `null` on a side means the class was NOT PINNED in that version, and it is
 * the only thing it means: an entry whose resolution the reader could not make
 * out reads `"unreadable"` there, so "nobody pinned this" and "the pin is
 * written in a shape this reader does not know" never arrive as the same fact.
 */
export interface PinChange {
  actionClass: string;
  before: string | null;
  after: string | null;
}

/**
 * The pins a version of the module TEXT declares (APRV-274).
 *
 * A DISPLAY reader and nothing else. It exists so the amendment ceremony can
 * show what the pins file did between the commit it is built on and the working
 * tree, and the committed side of that comparison is a git blob: TypeScript
 * source, with no build output to import. Nothing here gates anything. The pin
 * check that can refuse a ceremony resolves the COMPILED
 * {@link REPO_POLICY_EXPECTATIONS} against a loaded policy, exactly as it did
 * before this function existed, so a text this reader misreads costs a report
 * line and never a wrong verdict.
 *
 * The read is lexical and SCOPED to the named array literal, which matters:
 * this very module mentions `actionClass` outside the pins (in the failure it
 * builds for a policy that does not parse), and a reader that swept the whole
 * file would report that mention as a pin. Inside the array, entries are split
 * on `actionClass:`, and within one entry the first `autonomy:` and
 * `provenance:` string literals are its resolution. That holds for a list
 * written in the shape this module's own list is written in, where both fields
 * precede the free-text `note`. An entry it cannot read is reported with a
 * `null` resolution rather than dropped, so a pin that moved is never silently
 * absent from the report.
 */
export function readPinSource(text: string, constant = "REPO_POLICY_EXPECTATIONS"): PinSourceEntry[] {
  const entries: PinSourceEntry[] = [];
  const scoped = pinsArrayOf(text, constant);
  const boundaries = [...scoped.matchAll(/\bactionClass\s*:\s*"([^"]*)"/gu)];
  for (const [index, boundary] of boundaries.entries()) {
    const actionClass = boundary[1];
    if (actionClass === undefined || actionClass.length === 0) continue;
    const from = (boundary.index ?? 0) + boundary[0].length;
    const to = boundaries[index + 1]?.index ?? scoped.length;
    const body = scoped.slice(from, to);
    const autonomy = /\bautonomy\s*:\s*"([^"]*)"/u.exec(body)?.[1];
    const provenance = /\bprovenance\s*:\s*"([^"]*)"/u.exec(body)?.[1];
    entries.push({
      actionClass,
      resolution:
        autonomy === undefined || provenance === undefined ? null : `${autonomy}/${provenance}`,
    });
  }
  return entries;
}

/**
 * How the pins moved from one version of the module text to another, sorted by
 * class so two runs of the same ceremony print the same report.
 *
 * A class pinned twice in one version keeps the FIRST reading, which is what
 * the compiled list resolves to as well: {@link checkPolicyExpectations} walks
 * the array in order and a duplicate cannot change an earlier entry's verdict.
 */
export function diffPinSources(before: string, after: string): PinChange[] {
  const read = (text: string): Map<string, string> => {
    const map = new Map<string, string>();
    for (const entry of readPinSource(text)) {
      if (!map.has(entry.actionClass)) map.set(entry.actionClass, entry.resolution ?? "unreadable");
    }
    return map;
  };
  const from = read(before);
  const to = read(after);
  const changes: PinChange[] = [];
  for (const actionClass of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const was = from.get(actionClass) ?? null;
    const now = to.get(actionClass) ?? null;
    if (was === now) continue;
    changes.push({ actionClass, before: was, after: now });
  }
  return changes;
}

/** One pin change on one line, for a terminal and for a `--json` array. */
export function describePinChange(change: PinChange): string {
  return `${change.actionClass}: ${change.before ?? "not pinned"} -> ${change.after ?? "not pinned"}`;
}

/**
 * The pins that govern `policyPath`, or `null` when none do.
 *
 * The test is package identity and nothing looser: the nearest `package.json`
 * above the policy file names `approval-md`. A copy of the policy carried into
 * some other repository is not this repository's policy, and a user's own
 * `APPROVAL.md` is nobody's business but theirs.
 */
export function expectationsFor(policyPath: string): readonly PolicyExpectation[] | null {
  let at = dirname(policyPath);
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const raw = readFileSync(join(at, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      return parsed.name === "approval-md" ? REPO_POLICY_EXPECTATIONS : null;
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}
