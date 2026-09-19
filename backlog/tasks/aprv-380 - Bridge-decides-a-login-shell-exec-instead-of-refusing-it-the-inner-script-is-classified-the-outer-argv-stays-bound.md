---
id: APRV-380
title: >-
  Bridge decides a login-shell exec instead of refusing it: the inner script is
  classified, the outer argv stays bound
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 15:06'
updated_date: '2026-09-19 16:32'
labels:
  - bridge
  - codex
  - classifier
dependencies: []
priority: high
ordinal: 294000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by lane 5 while landing APRV-362 (2026-09-19), reported to and filed on the orchestrator ruling.

THE FACT. The shape the 2026-09-18 probe recorded on every exec request is a login shell with the whole model command as one quoted argument. Put that string through the classify verb today and it is REFUSED, not classified: the answer is the opaque code, with a detail saying the shell runs a script. The refusal reaches a caller as hook-opaque, NOT hook-unclassified (lane 5 said unclassified in its first report; this is the correction). All six shell binaries are entries in the OPAQUE_BINS table in src/core/command-class.ts near line 2619, and the refusal site is near line 3043.

WHAT THE NATIVE CODEX ADAPTER DOES WITH THE SAME SHAPE: nothing different. There is no unwrap anywhere in the tree. Every adapter in src/cli/hook.ts reaches the same classifyForHook, and describeToolCall turns the classifier code into hook-opaque without inspecting which binary it was. So this task covers BOTH halves, as the orchestrator instructed: there is no existing native path for the bridge to reuse through decideHarnessCall, because the native path refuses this shape too.

AND THE REFUSAL IS DELIBERATE, which is why this is a design task and not a bug fix. The comment above OPAQUE_BINS states the position: a second parser for the same text is a second answer waiting to disagree with the shell own, so these refuse instead. Both docs/claude-code-hook.md and docs/cursor-hook.md teach the opaque refusal by this exact example. Reversing it needs an argument, not a patch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The design choice (narrow unwrap, or leave it opaque) is stated with its reasoning before any code
- [x] #2 A login-shell exec whose argv is exactly a known shell, one inline-script flag and one script word is decided rather than refused hook-opaque, and anything outside that shape stays opaque
- [x] #3 The registered payload still binds the outer argv and command as APRV-362 built them; the inner-script classification is additional evidence and never the binding
- [x] #4 The bridge and the native Codex adapter reach the same answer for the same shape, through one code path rather than two
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHY IT MATTERS NOW. The bridge (APRV-361) exists to gate native Codex shell work, and the most common real Codex exec shape is exactly the login-shell one. So the bridge today declines nearly everything a real session does. It is fail-closed, so nothing is unsafe; it is close to useless against the traffic it was built for. The bridge test suite passes only because its fixtures use bare commands.

WHAT AN UNWRAP MUST PRESERVE (orchestrator, explicit). The argv binding APRV-362 landed does not move. The INNER SCRIPT is what gets classified; the OUTER ARGV is what is bound and recorded. A grant must still bind the words the kernel receives, so the payload keeps its command and argv fields as APRV-362 built them, and any inner-script classification is additional evidence rather than a replacement binding.

THE DESIGN QUESTION TO ANSWER FIRST. Unwrapping means running the shell classifier over a string that arrived as one argv word, which is the second-parser hazard the OPAQUE_BINS comment names. Two shapes worth costing:
(a) NARROW UNWRAP. Only an exact three-word argv naming a known shell, exactly one inline-script flag, and one script word: anything else stays opaque. The script is classified by the existing classifyForHook and the union of its classes is the answer. Narrow enough that the second parser only ever sees text a shell was about to run anyway.
(b) LEAVE IT OPAQUE and make the bridge useful another way, for instance by having Codex hand over the inner command as a field rather than a rendering, which is a question for the upstream issues APRV-348 tracks.

Whoever takes this should state which, and why, before writing code.

AC1, THE DESIGN CHOICE, STATED BEFORE ANY CODE. Option (a), the NARROW UNWRAP, on the orchestrator ruling of 2026-09-19 and with its reasoning recorded here.

THE ARGUMENT, because the OPAQUE_BINS comment is a position and reversing it needs one. That comment says a second parser for the same text is a second answer waiting to disagree with the shell own. The hazard it names is PARSING SHELL TEXT A SECOND WAY: taking a string the shell will interpret and interpreting it differently. Unwrapping is not that. When the argv is exactly a known shell, one inline-script flag and one script word, with nothing else, the script IS the text the hook already classifies when Claude Code hands it a Bash call. It goes through the SAME classifier, the same lexer and the same segment rules that every other command on every other adapter goes through. No second parser is added, and the text is not read a second way: it is read the first way, by the only reader this runtime has.

WHAT STAYS OPAQUE, and the line is exact. Extra words of any kind, a login shell with a script FILE rather than an inline string, a flag combination outside the narrow set, an assignment prefix, a redirection on the wrapper, a substitution in the wrapper words, and a nested shell inside the script. Each of those is a shape where the effect depends on something the argv alone does not say, which is where the OPAQUE_BINS position still holds.

WHAT THE UNWRAP MUST PRESERVE (orchestrator, explicit): the outer argv is what is BOUND and recorded, exactly as APRV-362 built it; the inner script is what is CLASSIFIED; and the payload a human sees carries both. Nothing in the payload changes in this task.

WHY NOT (b), leave it opaque. The bridge exists to gate native Codex shell work and the observed exec shape is the login shell on every request, so a bridge that refuses it is fail-closed and useless against the traffic it was built for. Option (b) waits on an upstream change (APRV-348) that nobody has agreed to, and it leaves the gate declining every real session in the meantime.

WHERE IT GOES, so the answer is one code path (AC4): in classifyCommand, which every adapter and the bridge reach through the same describer. There is no second implementation to keep in step, and the native Codex adapter gains the behaviour by construction rather than by a copy.

THIS IS A CLASSIFIER-WIDE BEHAVIOUR CHANGE, not a Codex one. The unwrap lives in classifyCommand, which every adapter reaches (Claude Code, Cursor, the Agent SDK, Muse, Grok and native Codex) and which the app-server bridge reaches through decideHarnessCall. That is what AC4 asks for, one code path rather than two, and the orchestrator accepted it on 2026-09-19 on two conditions, both met below.

FOUR DOCS AND ONE FIXTURE MOVED, because the opaque teaching example in every one of them was the shape this task stops refusing: docs/claude-code-hook.md (the hook-opaque paragraph, now with the exception and its exact line), docs/cursor-hook.md (the same paragraph, shorter, pointing at the Claude Code one), docs/agent-sdk-hook.md (the pinned deny envelope in its prose) and docs/cli-reference.md (the hook-opaque row in the deny-code list). The fixture is tests/fixtures/agent-sdk/sdk-return-deny.json, whose pinned bytes were a bash -c refusal and are now an xargs one; tests/agent-sdk-hook.test.ts feeds the matching command. Two test fixtures in the same position moved for the same reason: the opaque list in tests/command-class.test.ts and the opaque cases in tests/cli-hook.test.ts.

IMPLEMENTATION. src/core/command-class.ts gains loginShellScript (exported, the exact shape), UNWRAPPABLE_SHELLS (the six shells from OPAQUE_BINS that run a script), INLINE_SCRIPT_FLAG (a c last, with any run of l and i before it) and one branch in classifyCommand that classifies the script and SPLICES its segments in. ClassifierContext gains unwrapShell, passed false on the recursion, which is what keeps the unwrap one level deep by construction. The OPAQUE_BINS comment now states the narrowing rather than being quietly contradicted by the code below it.

WHY c MUST BE LAST in the flag. It is the letter that takes the next word as its argument. In a combination where it is not last, which word the shell reads as the script depends on its own option parser, and guessing at that is exactly the second-parser hazard. bash -cl is in the opaque fixture list for that reason.

THE REFUSAL IS THE INNER ONE. A script the classifier cannot read refuses with the inner code and the inner segment text, so an operator sees which part of their own script was unreadable rather than being told that zsh runs a shell script.

THE BINDING DOES NOT MOVE (AC3). cli/hook.ts binds the outer command and, on the bridge path, the outer argv, exactly as APRV-362 built them. A bridge test asserts both payload fields hold the login-shell form while the log carries the class of the inner command.

CONFORMANCE. Six new login-shell vectors in command-class.v1.json and a MINOR bump to 1.3.0. The why-not-major argument is in the script comment: no existing expectation in that file moves, and the MAJOR precedent here (policy-resolution 2.0.0) was a suite whose own algorithm line had stated a rule a later task made wrong, which this suite never did.

SPEC section 11 INVARIANTS: none weakened. The unwrap only ever turns a REFUSAL into a class, and a class then goes through the whole policy path a refusal skipped; nothing self-reported is read (the script is in the words the harness sent); the payload binding is unchanged; refusals stay machine-readable and distinct, and the codes are the same ones.

VALIDATION. build, typecheck and lint exit 0. npm run conformance: 396 vectors passed, 0 failed, exit 0. Suites: command-class 441/441, cli-hook 140/140, cli-hook-cursor and cli-hook-grok 22/22, agent-sdk-hook and cli-hook-codex 27/27, codex-bridge 42/42, all exit 0. Full npm test: 4769 tests, 4746 pass, 22 fail, exit 1, and the failing set is byte-identical to the two earlier runs today (the pre-existing Node 26 SMTP and email adapter set). The pre-change baseline on this checkout was 4749 / 4725 / 23.

ONE PROCESS NOTE worth carrying: the first full run on this branch reported six spurious failures because dist/ is not cleaned between branches and still held the compiled question-preempted suite from the APRV-378 branch. Overwritten with export {} per the lane rules, never removed, and the run repeated clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A segment that is exactly a known shell, one inline-script flag and one script is now classified by the SCRIPT, through the same classifier, the same lexer and the same segment rules every other command goes through. It is a classifier-wide change: every adapter and the app-server bridge reach it through classifyCommand, which is AC4 by construction rather than by a copy. Everything outside that exact shape stays opaque, including a script file, an extra word, a redirection, an assignment prefix, a flag whose c is not last, and a shell nested inside the script, and the unwrap is one level deep because the recursion passes unwrapShell false. The binding does not move: the payload still carries the outer command and, on the bridge path, the outer argv as APRV-362 built them. Verified by six new conformance vectors (command-class 1.3.0, a MINOR bump whose why-not-major argument is in the script), new unit cases over every shell and flag combination, new hook cases on the Claude Code adapter, two bridge cases using the real login-shell probe shape, and updated opaque examples in four docs and the pinned agent-SDK deny fixture.
<!-- SECTION:FINAL_SUMMARY:END -->
