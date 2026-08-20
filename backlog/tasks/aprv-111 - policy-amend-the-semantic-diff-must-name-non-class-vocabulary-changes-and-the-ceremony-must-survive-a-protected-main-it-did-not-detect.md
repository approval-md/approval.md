---
id: APRV-111
title: >-
  policy amend: the semantic diff must name non-class vocabulary changes, and
  the ceremony must survive a protected main it did not detect
status: Done
assignee: []
created_date: '2026-08-20 09:07'
updated_date: '2026-08-20 18:49'
labels:
  - cli
  - policy
  - bug
milestone: m-12
dependencies: []
priority: medium
ordinal: 103000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-20 during the real protected_paths amendment (attested seq 48, commit 3edfb02, landed as PR #95). Two defects, one run. (1) The semantic differ probed 22 classes and reported "no semantic change" for an edit that added protected_paths: [SPEC.md]. The differ only asks whether class resolutions moved; policy vocabulary outside classes (protected_paths, audit.skew_tolerance, budgets, approvers, defaults such as approval_ttl and on_expiry, vault.passphrase_env, token_delivery when APRV-105 lands) is invisible to it, so a human can be shown "no semantic change" while signing bytes that widen or narrow the gate itself. The diff must render every recognised top-level key change in before -> after form (protected_paths: absent -> [SPEC.md]); unknown keys are named as unknown and listed, never silently ignored (fail closed on the DISPLAY side: an edit the differ cannot describe is called out as such, not summarized as no change). (2) The ceremony chose the direct flow and git push origin main was rejected by branch protection without a loud failure; the operator terminal showed the three commands as if they had run and the commit sat ahead of origin unpushed. APRV-92 built the branch flow for exactly this; the flow choice should probe the remote (a push --dry-run, or the protection state via the API when gh is present) and pick the branch flow on a protected main; when a push is rejected anyway, the verb must exit nonzero naming the rejection and print the branch-flow commands, never end looking finished. Tests: an amend over a policy adding protected_paths shows the key in the diff; an amend against a remote that rejects the push reports the rejection and exits nonzero (simulate with a pre-receive hook in a temp bare repo); a policy with an unknown top-level key is named in the diff output.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The semantic diff renders changes to every recognised non-class key in before -> after form and names unknown keys; "no semantic change" is printed only when the parsed policies are semantically identical
- [x] #2 On a protected main the ceremony takes the branch flow; a rejected push is a loud nonzero failure naming the fix, never a silent success; tests cover both with a temp bare repo
- [x] #3 npm test and lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 105 (branch aprv-111-amend-differ). The differ gained a derived vocabulary section: it walks both documents' own keys, flattens to dotted paths, and reports every differing pair before -> after, so future policy vocabulary (APRV-105's token_delivery) is covered with no differ edit; unknown top-level keys are listed and marked recognised: false whether or not the value moved; rejected-but-parsed YAML reaches the differ via a DISPLAY-ONLY raw field on a failed load, since an unknown key is otherwise invisible. 'no semantic change' prints only when probes and every compared key agree; an unparsed side says the document was not compared. Second defect deeper than filed: the direct flow printed git push among commands it had run while never running it; the push now runs, and a rejection is refusal push-rejected (exit 4) carrying git's verbatim output, the exact local state, and the branch+PR recovery, without moving the operator off a commit they signed. FINDING against the task's own proposal, verified empirically: git push --dry-run cannot detect branch protection (pre-receive never runs on a dry run) - documented in cli-reference and the test helper so it is not re-proposed. +10 tests including a temp bare repo with a real pre-receive refusal.
<!-- SECTION:NOTES:END -->
