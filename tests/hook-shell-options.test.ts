/**
 * Which command lines set a shell option, so that every glob in them is read
 * as any name (lead's ruling L60846 on #682; security review of d0288514:
 * an attached value and a long option were missed).
 *
 * Today the classifier refuses each of these lines on its own account (`set`
 * with an unknown option has no rule, and a shell started on a script is
 * opaque), so the hook's verdict does not change; this holds the detection
 * itself, for the day one of them is classified.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { setsShellOption } from "../src/cli/hook.js";

test("an option word after set or a shell's name, its value attached or not, or a long option, sets an option", () => {
  for (const command of [
    "set -o extendedglob; cat x",
    "set -oextendedglob; cat x",
    "set +oNO_GLOB; cat x",
    "set -eo pipefail",
    "zsh -o extendedglob x.zsh",
    "zsh -oextendedglob x.zsh",
    "zsh --extendedglob x.zsh",
    "zsh --emulate ksh x.zsh",
    "bash -O extglob x.sh",
    "bash -Oextglob x.sh",
    "/bin/bash +O nocaseglob x.sh",
    "true && sh -o noglob x.sh",
    "shopt -s nocaseglob",
    "setopt extendedglob",
    "emulate ksh",
    // Quoted or escaped, as the shell reads them after quote removal (codex on 83f30bdc).
    'set "-o" extendedglob; cat x',
    "s'et' -o extendedglob; cat x",
    "set -'o' extendedglob; cat x",
    "set \\-o extendedglob; cat x",
    "'shopt' -s nocaseglob",
  ]) {
    assert.equal(setsShellOption(command), true, command);
  }
});

test("other options, and option words not after set or a shell, set none", () => {
  for (const command of ["set -e; cat x", "bash -c 'ls'", "echo -o", "ls -o x", "git log --oneline", "x=set; echo -o", "cat setopted", "bash; ls -o"]) {
    assert.equal(setsShellOption(command), false, command);
  }
});
