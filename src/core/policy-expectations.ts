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

import { CLASSIFIER_CLASSES } from "./command-class.js";
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
 * Every class the policy declares literally must appear here (the check below
 * enforces it in both directions), plus the default and namespace paths worth
 * stating. A ceremony that changes any of these resolutions updates this list in
 * the same breath, which is exactly the coupling the seq 7413 ceremony lacked.
 */
export const REPO_POLICY_EXPECTATIONS: readonly PolicyExpectation[] = [
  // manual — the side-effecting and self-modifying classes
  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },
  {
    actionClass: "network.call",
    autonomy: "manual",
    provenance: "rule",
    note: "re-tightened 2026-08-20 (attested seq 293) once APRV-114 taught the classifier that GET-shaped fetches are read.web; this class now covers only the mutating and ambiguous remainder",
  },
  { actionClass: "release.publish", autonomy: "manual", provenance: "rule" },
  {
    actionClass: "policy.edit",
    autonomy: "supervised",
    provenance: "rule",
    note: "supervised-live 0.1 since the seq 5147 ceremony (APRV-184): one edit in ten blocks on the gate, the rest execute and stay in the retrospective pool; with no usable sampling secret live selection fails closed and every edit gates",
  },
  { actionClass: "files.delete.out_of_scope", autonomy: "manual", provenance: "rule" },

  // human-only — a person acts; no verb mints or withdraws authority (APRV-185); declared at the seq 7355 ceremony
  {
    actionClass: "vcs.history.rewrite",
    autonomy: "human-only",
    provenance: "rule",
    note: "manual until seq 7355; a person rewrites shared history, never an agent",
  },
  {
    actionClass: "policy.core",
    autonomy: "human-only",
    provenance: "rule",
    note: "APPROVAL.md and .approval/* outside the log; split out of policy.edit by APRV-198 so the 0.1 sample never sits on the gate's own organs",
  },
  {
    actionClass: "log.mutate",
    autonomy: "human-only",
    provenance: "rule",
    note: "any write aimed at .approval/log/ (APRV-198)",
  },
  {
    actionClass: "account.credential",
    autonomy: "human-only",
    provenance: "rule",
    note: "keychain readers, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194)",
  },

  // autonomous — reads and in-workspace/branch-local writes
  {
    actionClass: "log.sync",
    autonomy: "autonomous",
    provenance: "rule",
    note: "manual from seq 513 until the seq 7413 ceremony reached the APRV-125 end state: an ff-pull with chain reconcile decides nothing, the chain and CI verify it",
  },
  {
    actionClass: "read.web",
    autonomy: "autonomous",
    provenance: "rule",
    note: "member of the read.* namespace",
  },
  {
    actionClass: "read.files.workspace",
    autonomy: "autonomous",
    provenance: "rule",
    note: "read.* trailing wildcard spans more than one segment",
  },
  { actionClass: "files.write.workspace", autonomy: "autonomous", provenance: "rule" },
  {
    actionClass: "deps.install",
    autonomy: "autonomous",
    provenance: "rule",
    note: "bare npm install / npm ci from the lockfile: it adds nothing the lockfile does not already pin",
  },
  { actionClass: "vcs.commit.branch", autonomy: "autonomous", provenance: "rule" },
  { actionClass: "vcs.push.branch", autonomy: "autonomous", provenance: "rule" },

  // supervised — pushing to main is sampled, not free
  { actionClass: "vcs.push.main", autonomy: "supervised", provenance: "rule" },
  {
    actionClass: "vcs.pr.create",
    autonomy: "supervised",
    provenance: "rule",
    note: "member of the vcs.pr.* namespace: opening and updating a pull request on a feature branch",
  },
  {
    actionClass: "log.advance",
    autonomy: "supervised",
    provenance: "rule",
    note: "supervised-live 0.1 since the seq 7413 ceremony (APRV-125 end state): committing the record of what already happened is bookkeeping, sampled after the fact; with no usable sampling secret live selection fails closed and every advance gates",
  },

  // defaults — undeclared classes fall to defaults.autonomy (manual)
  {
    actionClass: "communicate.email.external",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared class: the absence of a grant is not a grant",
  },
  {
    actionClass: "deps.upgrade",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared, so the manual default holds; since APRV-228 the classifier emits it for the harness self-update verbs (claude/codex/gemini update, uca) as well as npm update, and a ceremony that declares it must move this pin",
  },
  {
    actionClass: "files.delete.scratch",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared, so the manual default holds; APRV-267 taught the classifier to emit it for an rm confined to the session scratchpad or the system temp root, and until a ceremony declares it (autonomous is the intent) it gates exactly as files.delete.out_of_scope always did, which is why landing the rule ahead of the ceremony costs nothing",
  },
  {
    actionClass: "vcs.remote.meta",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared, so the manual default holds; APRV-268 taught the classifier to emit it for gh reads and metadata mutations on the checkout's own origin, and until a ceremony declares it (supervised is the intent) `gh pr update-branch`, `gh run rerun` and `gh api graphql` queries gate exactly as network.call did — the forms that were already read.vcs.remote (`gh pr view`, a `gh api` GET) move from autonomous to the manual default, which is a FRICTION INCREASE this pin makes visible and the ceremony reverses",
  },
  {
    actionClass: "read",
    autonomy: "manual",
    provenance: "default",
    // SPEC.md §5.2 (amended): a trailing `.*` matches ONE OR MORE segments, so
    // `read.*` is the namespace *under* `read` and does not cover the bare class
    // `read`. A policy wanting the bare class covered must list it as its own
    // rule; the repo policy does not, so `read` falls to the manual default.
    note: "bare namespace is NOT matched by read.* (SPEC.md §5.2)",
  },
];

/** One way the amended policy failed its pins. Machine-readable by `kind`. */
export interface ExpectationFailure {
  kind: "resolution" | "floor" | "unpinned" | "unreachable";
  actionClass: string;
  expected: string;
  actual: string;
  note?: string;
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
 * Four ways to fail, and the last two are the ones a ceremony hits: a class the
 * policy declares and nothing pins is a resolution nobody is watching, and a
 * class the command classifier cannot emit is a policy line that will never
 * fire.
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

  const pinned = new Set(expectations.map((expectation) => expectation.actionClass));
  const declared = Object.keys(load.policy.classes ?? {}).filter((pattern) => !pattern.includes("*"));
  for (const actionClass of declared) {
    if (!pinned.has(actionClass)) {
      failures.push({
        kind: "unpinned",
        actionClass,
        expected: "a pin in REPO_POLICY_EXPECTATIONS",
        actual: "the policy declares this class and nothing pins what it resolves to",
      });
    }
    if (!CLASSIFIER_CLASSES.includes(actionClass)) {
      failures.push({
        kind: "unreachable",
        actionClass,
        expected: "a class the command classifier can emit",
        actual:
          "no rule in src/core/command-class.ts emits it, so the policy line would never fire",
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/** The name of the module a human edits when a pin has to move. */
export const EXPECTATIONS_MODULE = "src/core/policy-expectations.ts";

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
