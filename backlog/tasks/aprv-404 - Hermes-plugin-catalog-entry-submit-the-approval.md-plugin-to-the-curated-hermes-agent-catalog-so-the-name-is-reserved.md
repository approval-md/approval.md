---
id: APRV-404
title: >-
  Hermes plugin catalog entry: submit the approval.md plugin to the curated
  hermes-agent catalog so the name is reserved
status: To Do
assignee: []
created_date: '2026-09-20 18:13'
labels:
  - hermes
  - agent-village
  - release
dependencies:
  - APRV-400
references:
  - 'https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins'
  - 'https://github.com/NousResearch/hermes-agent'
documentation:
  - docs/hermes-hook.md
priority: medium
ordinal: 312000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hermes has no global plugin or skill namespace: plugins install by owner/repo from git or from local directories, later sources silently win on a name collision, and plugin skills are addressed as plugin:skill with no registration. The one reservable thing is the curated, SHA-pinned plugin catalog kept in the NousResearch/hermes-agent repository, which has admission CI and a submission workflow and reserves unique names. A catalog entry is the closest thing to securing the approval name for Hermes users, and it is a PR to their repo rather than a product review. It needs the Python plugin form of the adapter (APRV-400) to exist first. Submitting the PR is a network publish action outside this repo (vcs.push to a foreign repo), so Carter runs it or grants it through the gate; the task prepares the entry and records the outcome. Decided 2026-09-20 after checking hermes-agent.nousresearch.com/docs/user-guide/features/plugins. Agent Village v2 code freeze is 2026-09-27; landing before it is preferred, not required.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Catalog entry name is approval (fallback approval-md if taken), pinned to a tagged release SHA of this repo, with the plugin metadata the catalog admission CI requires
- [ ] #2 Entry passes the catalog admission CI locally or in the upstream PR checks
- [ ] #3 hermes plugins install approval on a clean HERMES_HOME installs the plugin and the pre_tool_call hook registers with fail_closed set, verified by the existing probe script
- [ ] #4 docs/hermes-hook.md gains a short install section naming the catalog command and the git owner/repo fallback
- [ ] #5 Implementation notes record the upstream PR URL, who submitted it, and the review outcome
<!-- AC:END -->
