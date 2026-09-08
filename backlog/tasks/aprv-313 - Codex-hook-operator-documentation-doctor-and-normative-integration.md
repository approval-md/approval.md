---
id: APRV-313
title: Codex hook operator documentation doctor and normative integration
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-08 21:13'
labels: []
dependencies:
  - APRV-312
priority: high
type: feature
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Help/examples/runbook specify opt-in shell/patch coverage, failure gaps, ten-minute outer timeout and nine-minute gate wait.
- [x] #2 Doctor distinguishes configured wiring from trusted/observed operation and checks Codex provenance.
- [x] #3 Narrow SPEC edits follow the gate; no live installation, daemon restart, dependencies or release.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. After adapter interfaces settle, add opt-in example outside live .codex paths and an activation/rollback runbook; document exact tested CLI and desktop pending separately. 2. Add doctor diagnostics for Codex Pre/Post configuration and harness provenance, explicitly not claiming trust or execution from file presence. 3. Parent prepares narrow SPEC changes for Codex verb, gate organs, MCP exclusion, patch/outcome contract and bounded coverage; route exact edits through primary gate before applying. 4. Focused doctor/help/docs checks, then final integration verification; leave APRV-315 pending.

The public verb, Pre/Post registration and 9m/600s timing are now settled in APRV-311. Begin disjoint doctor/examples/runbook work while APRV-312 patch internals proceed; keep native outcomes and desktop proof explicitly pending until observed.

Update operator wording around reviewed bounded behavior: experimental direct apply_patch gate, unconditional Bash refusal because native effective cwd is omitted, PostToolUse diagnostic-only, and observed crash/timeout/malformed failure continuation. Retain Bash|apply_patch matcher so shell-dispatched patches are refused rather than silently ungated. Keep CLI help and registry descriptions accurate; no live configuration. SPEC amendment remains unapplied and must be revised to this actual boundary before any request or approval.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SPEC remains unchanged. Proposed amendment (requires a valid protected-edit execution/delivery path):

### 10.6 Native Codex hook adapter (Amended APRV-313, pending sign-off)

The opt-in `approval hook codex` adapter reads synchronous native `PreToolUse` and `PostToolUse` events for `Bash` and `apply_patch`. It MUST reuse the verified gate, policy, budgets, approval waiting and grant-consumption paths. It MUST return a supported explicit allow or deny on pre-execution input, require stable session and tool-call identifiers, and refuse malformed input or unsupported tools delivered to it. Codex sandbox permissions remain independent; a native approval is never a substitute for an approval.md decision. The default gate wait is nine minutes and the example native hook timeout is ten minutes.

A patch approval MUST bind the complete raw patch, tool identity and execution directory. Every addition, update, deletion, and move source and destination MUST be inspected with the existing scope and protected-path rules; an unreadable or ambiguous patch is refused. Codex hook configuration (`.codex/hooks.json`, `.codex/hooks/` and `.codex/config.toml`) is a gate organ under §5.2. Examples MUST be delivered outside those live paths; installation and trust are operator actions.

Codex has its own `codex` harness provenance. A post-execution report MUST correlate with a verified delegated start for that Codex call and reuse `reported_by: post-tool-use`. Only an outcome shape verified against a named Codex version may close a start. `PostToolUse` alone is not evidence of success; unknown, interrupted, or unfinished results remain unclosed with a diagnostic, and tool-output text never enters the approval log.

Coverage is bounded to the native paths that deliver these hooks. Operator documentation MUST distinguish tested explicit denial from observed crash and timeout behavior, and identify unverified desktop behavior. Hook failure or timeout may leave no enforceable decision at the native boundary; this integration makes no universal enforcement or strict Claude parity claim. Doctor MUST distinguish configuration on disk from trusted and demonstrated operation, and MUST NOT infer either from configuration presence. (Amended APRV-313, pending sign-off.)

Other proposed narrow edits: add Codex hook/config gate organs to section5.2; add hook codex CLI row; extend MCP withheld count to four and list Codex; list Codex in M8. Exact seven before/after edits prepared at /private/tmp/aprv-313-spec-edits.json. Existing approval run binds argv/cwd, while file-hunk evidence uses file/before/after. Do not fake Claude provenance or deploy the new daemon/schema merely to self-authorize. Parent is retaining this boundary while independent implementation proceeds.

Operator slice reviewed: separate Codex wiring row; strict quoted absolute direct command profile, malformed async and echo/compound negative controls; TOML presence remains undetermined, no trust/execution inference. Inert example and human install/rollback runbook plus local POST witness prepared; README/count pins updated. Sol tsc/lint/focused doctor6 and docs guard22 exit0; parent full cli-doctor outside socket restriction passed70/70 exit0 (46.4s), resolving earlier inconclusive manually cancelled restricted runs. Loopback witness readiness/POST204/one marker/server exit0 verified. SPEC remains unchanged and proposed exact amendment is recorded above; native trust/outcome and morning activation remain pending.

Integration review added the missing codex-hook-wiring CLI reference roster row and prominent native-unverified/PostToolUse diagnostic status. Runbook now states exact input/cwd/patch restrictions and conservative cd syntax. No SPEC or live configuration edit. Final full-suite verification follows.

Final code/docs df570ea passed full npm test3920pass/1skip, lint/typecheck, conformance293/293 and complete CI parity, all exit0. Doctor roster/profile and help/runbook regressions pass. AC3 remains pending: SPEC is unchanged; exact proposed amendment remains in this task. Everyday configuration/trust and daemon deployment were not performed.

Resumed read-only review by Sol and Astra found an existing exact-file execution route through executeThroughAdapter with {tool:Edit,file:SPEC.md,before,after}; normal primary core appends share locking/compare-and-append with the daemon. This supplies truthful hunk evidence only after a real grant. Current policy.edit.spec is supervised-live at 1%; request has no explicit force-human option and CI requires approval.granted, so an unsampled request cannot satisfy protected-path evidence. Do not falsify reversibility/loop floors, manipulate draws, impersonate another harness, or fabricate records. User has been offered a temporary human-operated manual SPEC policy setting; no policy or SPEC change performed.

Prepared but did not register/apply the revised narrow SPEC amendment: /private/tmp/aprv-313-spec-bundle/SPEC.patch, manifest SHA45cf410ed781c989fef3312ff2ee5bfbf064226f6d8ab7fdc7cd44657d5305e0, driver /private/tmp/aprv-313-spec-driver.mjs SHA16bc6c3e3719f771f7c3762e0a6010bb1b997d38079764f4903fef6231d3008d. Seven exact before/after payloads, whole-file digest chain, primary-context/grant-only execution and no invented harness/provider evidence. Syntax/read-only drycheck/envelope validation exit0. Amendment now states experimental direct patch, mandatory early Bash refusal, diagnostic outcomes and observed fail-open limits. Current SPEC bytes remain unchanged; no grant exists, and policy/CI mismatch remains unresolved. Broader everyday activation is separately blocked by native contract.

CLI help/registry and operator docs now state experimental direct-patch support with every matched Bash call refused, retain full matcher, and mark normal installation/phone ceremony unavailable on0.152.1. Removed obsolete cwd advice; corrected v7 observation to native identity allow+nested effect+no Post, distinct from production refusal. Astra prose/source review clear; full npm3928 pass/1skip plus lint/typecheck/conformance exit0. Normative SPEC remains unapplied and unregistered.

2026-09-08 policy-authoritative continuation: Carter explicitly confirmed APPROVAL.md governs human approval. Reviewed temporary driver /private/tmp/aprv-313-spec-policy-driver.mjs calls primary request for each exact bound Edit payload, proceeds only on explicit proceed:true/requested:false, otherwise waits for a real grant; executeThroughAdapter remains the binding/budget/execution authority. Policy bytes are checked unchanged across request and act. Registration seq29911; steps1–4 executed under unchanged policy with starts29912/29914/29916/29918 and successful completions29913/29915/29917/29919. Step5 request29920 awaits real policy-required human decision; steps5–7 remain unapplied. Target complete digest is the manifest before-step5 digest; readonly bundle check exit0. No policy edit or invented approval. APRV316 fixes CI recognition of policy-authorized file evidence.

Final checkpoint this turn: all seven exact SPEC edits applied through the primary gate. Steps1–4 and6 were permitted without human grants; steps5 and7 received real human grants and executed through the token-only reviewed driver. Completions29913/29915/29917/29919/29923/29925/29929; full target SHA afbf2ac0cc85ad8360b479b41512e064f96e8f8e2368ad51789be08aee50a965; readonly bundle check exit0. SPEC changes remain uncommitted pending APRV316 CI evidence alignment and final checks. Policy unchanged. Feature HEAD d33d24a; reviewed Codex source/probe/docs commits b780c01,994f86c,76c9cf7,d33d24a are local, PR344 still draft at8ad3eb1. Earlier source validation:3928 tests pass/1skip, lint/typecheck/conformance exit0; no claim these are new APRV316 tests.

The seven exact narrow SPEC edits executed through the primary gate: five policy-permitted starts and two actual human grants. Final protected-path verification reconstructs committed SPEC byte-for-byte from those records and passes. Records delivery PR345 and PR347 merged. No live Codex installation/trust, daemon restart, dependency or release changes were made. Current feature commit8be51ad includes the reviewed exact-replay evidence verifier; full final validation and PR344 delivery are tracked in APRV314/316.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered opt-in examples, help, doctor configuration-versus-operation diagnostics, native probe limits and activation/rollback runbook. Seven narrow SPEC edits executed through primary policy, with five policy-authorized starts and two real human grants. Actual guard verifies exact replay to committed SPEC; recordsPR345/347 merged. Full3951pass/1skip,lint,typecheck,conformance all exit0. PR344 final delivery tracked in APRV314; live installation remains APRV315.
<!-- SECTION:FINAL_SUMMARY:END -->
