# Agent guide (FIXTURE)

FIXTURE PROVENANCE: hand-written for APRV-240. This is not a copy of any real
file. It exists so one source exercises the four values headings alongside a
permissions section, and so the awkward cases have somewhere to live: a
duplicate bullet, a wrapped bullet, a bullet over the schema's 200-character
cap, a values heading inside a fenced example block, and bullets under a
heading the importer does not recognise.

## Permissions

### Allowed without prompting

- Read files, list directories, search the repo

### Require approval first

- Adding or upgrading dependencies

## What I value

- Work I can check without rerunning it myself
- A diff that says what it changed and
  why it changed it
- Work I can check without rerunning it myself

## What good looks like

- The failing case lands first, then the fix

```markdown
## What I value

- This bullet is inside a fenced block. It is an example of the convention and
  it is never a value; nothing here may reach the draft.
```

#### How I like to work

- Short messages, with the whole command spelled out

## What I want from you

- Say when you think a task is wrong, before you do it
- Tell me the exit code and the number of tests that ran, in that order, before you tell me anything else about a run, because a summary block that says everything passed has been wrong before and an exit code has not

## House style

- This bullet is under a heading the importer does not recognise, and it must
  not reach the values draft
