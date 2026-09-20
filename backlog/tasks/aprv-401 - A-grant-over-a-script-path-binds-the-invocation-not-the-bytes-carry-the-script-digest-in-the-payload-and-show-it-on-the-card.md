---
id: APRV-401
title: >-
  A grant over a script path binds the invocation, not the bytes: carry the
  script digest in the payload and show it on the card
status: To Do
assignee: []
created_date: '2026-09-20 09:03'
labels:
  - payload
  - gate
  - security
dependencies: []
priority: high
ordinal: 310000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while spending a deps.add grant during APRV-398 (grant at seq 60837). approval run rehashes the payload from the argv array and the cwd it is about to spawn, so a grant over 'bash /path/to/install.sh' authorizes whatever that path contains AT EXECUTION TIME. The approver's card shows the path, not the content, and the requester controls the file between the request and the grant. Nothing was exploited here (the script was written before the grant and its sha256 is recorded in APRV-398's notes), but the shape is the hazard: the payload hash is supposed to be the binding, and for a script invocation it binds a name. Proposal to settle: when the argv names a readable file the runtime is about to execute, include that file's digest in the hashed payload, and render it on the approval card beside the command, so a changed script is a payload-mismatch refusal rather than a silent substitution. Decide what counts as 'names a script' (argv[0] being an interpreter, or any argv element that resolves to an existing regular file) and whether the digest is advisory or part of the hash, since making it part of the hash means a script edited between request and grant is refused rather than run.
<!-- SECTION:DESCRIPTION:END -->
