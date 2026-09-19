---
id: APRV-380
title: >-
  Bridge decides a login-shell exec instead of refusing it: the inner script is
  classified, the outer argv stays bound
status: To Do
assignee: []
created_date: '2026-09-19 15:06'
updated_date: '2026-09-19 15:07'
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
- [ ] #1 The design choice (narrow unwrap, or leave it opaque) is stated with its reasoning before any code
- [ ] #2 A login-shell exec whose argv is exactly a known shell, one inline-script flag and one script word is decided rather than refused hook-opaque, and anything outside that shape stays opaque
- [ ] #3 The registered payload still binds the outer argv and command as APRV-362 built them; the inner-script classification is additional evidence and never the binding
- [ ] #4 The bridge and the native Codex adapter reach the same answer for the same shape, through one code path rather than two
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHY IT MATTERS NOW. The bridge (APRV-361) exists to gate native Codex shell work, and the most common real Codex exec shape is exactly the login-shell one. So the bridge today declines nearly everything a real session does. It is fail-closed, so nothing is unsafe; it is close to useless against the traffic it was built for. The bridge test suite passes only because its fixtures use bare commands.

WHAT AN UNWRAP MUST PRESERVE (orchestrator, explicit). The argv binding APRV-362 landed does not move. The INNER SCRIPT is what gets classified; the OUTER ARGV is what is bound and recorded. A grant must still bind the words the kernel receives, so the payload keeps its command and argv fields as APRV-362 built them, and any inner-script classification is additional evidence rather than a replacement binding.

THE DESIGN QUESTION TO ANSWER FIRST. Unwrapping means running the shell classifier over a string that arrived as one argv word, which is the second-parser hazard the OPAQUE_BINS comment names. Two shapes worth costing:
(a) NARROW UNWRAP. Only an exact three-word argv naming a known shell, exactly one inline-script flag, and one script word: anything else stays opaque. The script is classified by the existing classifyForHook and the union of its classes is the answer. Narrow enough that the second parser only ever sees text a shell was about to run anyway.
(b) LEAVE IT OPAQUE and make the bridge useful another way, for instance by having Codex hand over the inner command as a field rather than a rendering, which is a question for the upstream issues APRV-348 tracks.

Whoever takes this should state which, and why, before writing code.
<!-- SECTION:NOTES:END -->
