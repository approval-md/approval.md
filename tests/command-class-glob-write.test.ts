/**
 * GLOB-WRITE (22 Nov 2026): a glob in a WRITE target to a guarded path stays
 * guarded. Nothing looser than the shell.
 *
 * `echo x > ~/.hermes/auth.json` is `policy.core`; with a glob in any component
 * (`[!Z]uth.json`, `.[!Z]ermes`, `?uth.json`, `a*.json`, `.h*`) it was
 * `files.write.workspace`, while bash and zsh write through a glob in a
 * redirect target that matches one file and every shell writes through one in a
 * `cp`, `mv`, `tee`, `ln` or `install` operand. The sweep found 196 such rows
 * on main ffb5c32a. A write target the shell may still glob is now judged by
 * every guarded path its pattern could match, over-approximated, and a pattern
 * that cannot reach one (`out/*.log`) keeps its workspace class.
 *
 * Pure: classifyCommand only, no disk.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand, containedInAny, globWriteListingDirs } from "../src/core/command-class.js";

const HUMAN_ONLY = new Set(["policy.core", "log.mutate", "account.credential"]);

function classesOf(command: string, protectedPaths: readonly (string | { path: string; class: string })[] = []): string[] {
  const result = classifyCommand(command, protectedPaths);
  assert.ok(result.ok, `${command} was refused: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

function strictest(command: string): string {
  const classes = classesOf(command);
  for (const cls of ["log.mutate", "policy.core", "account.credential"]) if (classes.includes(cls)) return cls;
  return classes.join(",");
}

// The guarded targets of the sweep, each as the parts of its path.
const TARGETS: readonly (readonly [string, readonly string[]])[] = [
  ["~", [".hermes", "auth.json"]],
  ["~", [".hermes", ".env"]],
  ["~", [".hermes", ".env.local"]],
  ["~", [".hermes", ".op.env"]],
  ["~", [".hermes", "hermes-agent", ".env"]],
  ["~", [".hermes", "profiles", "p1", "auth.json"]],
  ["~", [".hermes", "config.yaml"]],
  ["", [".approval", "env"]],
  ["", [".approval", "vault.enc"]],
  ["", [".approval", "keys", "k1"]],
  ["", ["APPROVAL.md"]],
  ["", [".claude", "settings.json"]],
  ["", [".cursor", "hooks.json"]],
  ["", [".codex", "config.toml"]],
];

// Each glob family, applied to one component: the first character that is not a leading dot.
const FAMILIES: readonly (readonly [string, (c: string) => string])[] = [
  ["negated class [!Z]", () => "[!Z]"],
  ["negated class [^Z]", () => "[^Z]"],
  ["one character ?", () => "?"],
  ["star *", () => "*"],
  ["bracket member [c]", (c) => `[${c}]`],
  ["] first []c]", (c) => `[]${c}]`],
  ["range [a-z]", (c) => (/[0-9]/u.test(c) ? "[0-9]" : "[a-z]")],
  ["posix [[:alnum:]]", () => "[[:alnum:]]"],
  ["negated range [!A-Z]", () => "[!A-Z]"],
];

function spell(head: string, parts: readonly string[]): string {
  return head === "" ? parts.join("/") : `${head}/${parts.join("/")}`;
}

function globbedWords(): { word: string; family: string }[] {
  const out: { word: string; family: string }[] = [];
  for (const [head, parts] of TARGETS) {
    for (const [family, fn] of FAMILIES) {
      for (let pos = 0; pos < parts.length; pos += 1) {
        const part = parts[pos] as string;
        let k = 0;
        while (k < part.length - 1 && part[k] === ".") k += 1;
        const pattern = `${part.slice(0, k)}${fn(part[k] as string)}${part.slice(k + 1)}`;
        out.push({ word: spell(head, parts.map((p, i) => (i === pos ? pattern : p))), family });
      }
      // The tail by a star, and a star for a whole component.
      const last = parts[parts.length - 1] as string;
      out.push({ word: spell(head, [...parts.slice(0, -1), `${last.slice(0, 2)}*`]), family: "tail by *" });
    }
  }
  return out;
}

const WRITERS: readonly (readonly [string, (word: string) => string])[] = [
  [">", (w) => `echo x > ${w}`],
  [">>", (w) => `echo x >> ${w}`],
  [">|", (w) => `echo x >| ${w}`],
  ["&>", (w) => `echo x &> ${w}`],
  ["2>", (w) => `ls 2> ${w}`],
  ["bare >", (w) => `> ${w}`],
  ["cp", (w) => `cp README.md ${w}`],
  ["cp -f", (w) => `cp -f README.md ${w}`],
  ["mv", (w) => `mv README.md ${w}`],
  ["tee", (w) => `tee ${w} < README.md`],
  ["tee -a", (w) => `echo x | tee -a ${w}`],
  ["ln", (w) => `ln -f README.md ${w}`],
  ["ln -s", (w) => `ln -sf README.md ${w}`],
  ["touch", (w) => `touch ${w}`],
  ["truncate", (w) => `truncate -s 0 ${w}`],
  ["sed -i", (w) => `sed -i s/a/b/ ${w}`],
  ["rm", (w) => `rm ${w}`],
];

test("the plain write to each guarded target is human-only (the control)", () => {
  for (const [head, parts] of TARGETS) {
    const word = spell(head, parts);
    for (const [name, fn] of WRITERS) {
      const command = fn(word);
      assert.ok(classesOf(command).some((cls) => HUMAN_ONLY.has(cls)), `${name}: ${command} -> ${classesOf(command).join(",")}`);
    }
  }
});

test("a glob in any component of a guarded write target is human-only, for every writer", () => {
  const misses: string[] = [];
  for (const { word, family } of globbedWords()) {
    for (const [name, fn] of WRITERS) {
      const command = fn(word);
      const classes = classesOf(command);
      if (!classes.some((cls) => HUMAN_ONLY.has(cls))) misses.push(`${family} / ${name}: ${command} -> ${classes.join(",")}`);
    }
  }
  assert.deepEqual(misses, []);
});

test("the sweep's examples answer as the plain write does", () => {
  for (const command of [
    "echo x > ~/.hermes/[!Z]uth.json",
    "echo x > ~/.[!Z]ermes/auth.json",
    "echo x > ~/.hermes/?uth.json",
    "echo x > ~/.hermes/a*.json",
    "echo x > ~/.h*/auth.json",
    "echo x > .appr*/env",
    "echo x > .[!Z]pproval/env",
    "cp README.md ~/.hermes/?uth.json",
    "tee ~/.hermes/?uth.json < README.md",
    "echo x > APPROVAL.m?",
    "echo x > .claude/s*",
    "echo x > ~/.hermes/profiles/*/auth.json",
  ]) {
    assert.equal(strictest(command), "policy.core", command);
  }
  // The log is the strictest surface a pattern can reach.
  assert.equal(strictest("echo x >> .approval/l?g/events.jsonl"), "log.mutate");
  assert.equal(strictest("cp x .approval/*/events.jsonl"), "log.mutate");
  // Upper case: a case-folding volume or nocaseglob reaches the same file.
  assert.equal(strictest("echo x > .APPR*/env"), "policy.core");
  assert.equal(strictest("echo x > ~/.HERMES/A*.json"), "policy.core");
});

test("the zsh constructs a lexed word can carry are read as patterns too", () => {
  // `#` (extendedglob repeat), `^` (negation), `~` after the first character
  // (exclusion, which drops the rest of the word), and a whole `**` component.
  // They need extendedglob: read as patterns only on a line that may set it
  // (lead ruling L60846; review-b S2).
  assert.ok(lineClasses("setopt extendedglob; echo x > ~/.hermes/Z#auth.json").includes("policy.core"));
  assert.ok(lineClasses("setopt extendedglob; echo x > ~/.hermes/a^Z").includes("policy.core"));
  assert.ok(lineClasses("setopt extendedglob; echo x > APPROVAL.m*~x/y").includes("policy.core"));
  assert.deepEqual(classesOf("echo x > out/a^Z"), ["files.write.workspace"]);
  // A whole `**` descends into dot-directories with dot matching on, which
  // the user's profile may set unseen (lead ruling, CLAIMS L61492 and L61497).
  assert.equal(strictest("echo x > ~/**/auth.json"), "log.mutate");
  assert.equal(strictest("GLOBIGNORE=x; echo x > ~/**/auth.json"), "log.mutate");
  // Quoted, the word is a literal file name and never a pattern.
  assert.deepEqual(classesOf("echo x > '~/.hermes/?uth.json'"), ["files.write.workspace"]);
  assert.deepEqual(classesOf('echo x > "APPROVAL.m?"'), ["files.write.workspace"]);
});

test("a brace beside a glob is expanded first; a ${...} parameter is not a pattern", () => {
  assert.equal(strictest("echo x > ~/.hermes/{x,a*}.json"), "policy.core");
  // Parameter operators are not path segments or a glob: main's answers
  // (the `.git` reader's own, for a value it cannot see) are unchanged.
  assert.deepEqual(classesOf('echo x > "${f/.txt/.md}"'), ["vcs.history.rewrite"]);
  assert.deepEqual(classesOf("echo x > ${OUT#*.}/x.txt"), ["vcs.history.rewrite"]);
});

test("negative controls: a pattern that cannot reach a guarded path keeps its class", () => {
  for (const command of [
    "echo x > out/*.log",
    "echo x >> logs/run-?.txt",
    "echo x > out/[ab].log",
    "cp a out/*.log",
    "cp src/*.ts out/",
    "mv build/*.tmp out/",
    "tee out/*.txt < README.md",
    "touch out/[0-9].stamp",
    "sed -i s/a/b/ src/*.ts",
    "echo x > ~/.hermes/sessions/*.json",
    "echo x > ~/.hermes/notes-?.txt",
  ]) {
    const classes = classesOf(command);
    assert.ok(!classes.some((cls) => HUMAN_ONLY.has(cls)), `${command} -> ${classes.join(",")}`);
  }
  assert.deepEqual(classesOf("echo x > out/*.log"), ["files.write.workspace"]);
});

test("a glob in a SOURCE operand of cp, ln or install is a read, not a write", () => {
  // The destination is ordinary, so the pattern reading does not apply: these
  // keep main's class (a read through a glob is the read jail's question).
  assert.ok(!classesOf("cp ~/.hermes/a*.json backup/").includes("policy.core"));
  assert.ok(!classesOf("ln -s ~/.hermes/a*.json link").includes("policy.core"));
  // mv removes its source, so a moved organ is a write to it.
  assert.equal(strictest("mv ~/.hermes/a*.json backup/"), "policy.core");
});

test("a policy's own protected_paths are reached by a pattern too", () => {
  const paths = ["design/", { path: "docs/frozen/", class: "policy.edit.frozen" }];
  assert.ok(classesOf("echo x > des*/x.md", paths).includes("policy.edit"));
  assert.ok(classesOf("echo x > docs/fro?en/x.md", paths).includes("policy.edit.frozen"));
  assert.deepEqual(classesOf("echo x > dist/*.js", paths), ["files.write.workspace"]);
  // `*.md` can be APPROVAL.md.
  assert.equal(strictest("echo x > dist/*.md"), "policy.core");
});

test("cost: wide and long patterns are bounded and fail to the stricter class", () => {
  const started = process.cpuUsage();
  // Too many combinations: the strictest class there is.
  assert.equal(strictest("echo x > */*/*/*/*/x"), "log.mutate");
  // A long run of stars is one token.
  assert.deepEqual(classesOf(`echo x > out/${"*".repeat(50000)}.log`), ["files.write.workspace"]);
  // A long pattern is matched exactly within the step budget: 1,100 `?` name
  // only 1,100-character files.
  assert.deepEqual(classesOf(`echo x > ${"?".repeat(1100)}`), ["files.write.workspace"]);
  // Many unclosed brackets and many bracket ends.
  classesOf(`echo x > out/${"[".repeat(1000)}x`);
  classesOf(`echo x > out/[${"]".repeat(1000)}`);
  const spent = process.cpuUsage(started);
  assert.ok((spent.user + spent.system) / 1e6 < 10, `took ${String((spent.user + spent.system) / 1e6)} s`);
});

// ---------------------------------------------------------------------------
// Security review of the first push (22 Nov 2026): five findings, each pinned.
// ---------------------------------------------------------------------------

test("review 1: every operand of a command that is not a read is a write target (fail closed)", () => {
  for (const command of [
    "tar -xf a.tar -C .appr*",
    "git checkout -- APPROVAL.m?",
    "rsync a .appr*/env",
    "scp a .appr*/env",
    "gunzip .appr*/env.gz",
  ]) {
    assert.equal(strictest(command), "policy.core", command);
  }
  // The shell globs WHOLE words: a pattern inside an option word is handed to
  // the program as written, so it is not a path the shell resolves.
  assert.ok(!classesOf("npm test -- --grep=*").includes("policy.core"));
  // A read-class command's own outputs: sort -o, uniq's second operand.
  assert.equal(strictest("sort -o APPROVAL.m? x"), "policy.core");
  assert.equal(strictest("sort -o APPROVAL.md x"), "policy.core");
  assert.equal(strictest("uniq x .appr*/env"), "policy.core");
  // A copy's source is a read, but it lands under the destination by its
  // basename (lead ruling L61195 b): `./*.md` may be APPROVAL.md, which lands
  // as docs/APPROVAL.md. Decided by the source directory's listing.
  assert.ok(classesOf("cp ./*.md docs/").includes("policy.core"));
  assert.deepEqual(withListing("cp ./*.md docs/", { "/w": ["README.md", "docs"], "/w/docs": [] }), ["files.write.workspace"]);
  assert.ok(withListing("cp ./*.md docs/", { "/w": ["APPROVAL.md", "docs"], "/w/docs": [] }).includes("policy.core"));
});

test("review 2: a ${X:-WORD} default (and := :+ - = +) is a reading of its own, globbed", () => {
  for (const command of [
    "echo x > ${X:-~/.h*/auth.json}",
    "echo x > ${X:+.appr*/env}",
    "echo x > ${X:=APPROVAL.m?}",
    "echo x > ${X-.approval/env}",
    "echo x > ${X:-.approval/env}",
    "cp a ${X:-~/.hermes/?uth.json}",
  ]) {
    assert.equal(strictest(command), "policy.core", command);
  }
  assert.deepEqual(classesOf("echo x > ${OUT:-out}/x.log"), ["files.write.workspace"]);
});

test("review 2b: more ${…} operator spans than the cap, or a default nested too deep, is log.mutate", () => {
  const spans = (n: number): string => Array.from({ length: n }, (_, k) => `\${X${String(k)}:-a}`).join("");
  // At the cap (8) the readings are judged; one past it fails closed.
  assert.deepEqual(classesOf(`echo x > out/${spans(8)}.log`), ["files.write.workspace"]);
  assert.equal(strictest(`echo x > out/${spans(9)}.log`), "log.mutate");
  // The guarded default past the cap is not lost.
  assert.equal(strictest(`echo x > ${spans(8)}\${Y:-.approval/env}`), "log.mutate");
  // Nested defaults are followed 32 deep (the `.git` reader's depth); 33 fails closed.
  const nest = (n: number, inner: string): string => `echo x > ${"${a:-".repeat(n)}${inner}${"}".repeat(n)}/x.log`;
  assert.equal(strictest("echo x > ${A:-${B:-.appr*/env}}"), "policy.core");
  assert.equal(strictest(`echo x > ${"${a:-".repeat(32)}.appr*${"}".repeat(32)}/env`), "policy.core");
  assert.deepEqual(classesOf(nest(32, "out")), ["files.write.workspace"]);
  assert.equal(strictest(nest(33, "out")), "log.mutate");
});

test("review 3: a brace group brace expansion leaves (zsh braceccl) is a class of its characters", () => {
  assert.equal(strictest("echo x > .{a-z}pproval/env"), "policy.core");
  assert.equal(strictest("echo x > ~/.hermes/{a-z}uth.json"), "policy.core");
  // A range over `/` may make directories.
  assert.equal(strictest("echo x > {.-0}x"), "log.mutate");
  // A class of other characters reaches nothing.
  assert.deepEqual(classesOf("echo x > out/{0-9}.log"), ["files.write.workspace"]);
});

test("review 4: the matcher's work is bounded; exhausted, the word is log.mutate", () => {
  const started = process.cpuUsage();
  classesOf(`echo x > ${"[".repeat(5000)}${"]".repeat(5000)}`);
  classesOf(`echo x > ${Array.from({ length: 32 }, () => "[".repeat(200) + "]".repeat(200)).join("/")}`);
  classesOf(`echo x > ${Array.from({ length: 8 }, () => "${X:-" + "[".repeat(300) + "]".repeat(300) + "}").join("")}`);
  const spent = process.cpuUsage(started);
  assert.ok((spent.user + spent.system) / 1e6 < 10, `took ${String((spent.user + spent.system) / 1e6)} s`);
});

test("review 5: the parameter placeholder cannot be forged, and $ beside a glob is a pattern", () => {
  // A word holding the private-use mark fails closed.
  assert.equal(strictest("echo x > ab*"), "log.mutate");
  // `$1`, `$9` are variables (their value is unseen, as on main); no collision.
  assert.deepEqual(classesOf("echo x > ~/.hermes/$1uth.json.bak"), ["files.write.workspace"]);
  assert.deepEqual(classesOf('echo x > "$9"'), ["files.write.workspace"]);
  // A variable beside a glob construct may hold a `/`: it may name anything.
  assert.equal(strictest("echo x > ${X}*"), "log.mutate");
  assert.equal(strictest("echo x > ~/.hermes/$1*.json"), "log.mutate");
});

// ---------------------------------------------------------------------------
// Dot-names (lead ruling L60846): a form that needs an option is strict only
// when the SAME command line may set it; set by an earlier call, it is a known
// limit. `*`, `?` and `[...]` reach `.approval`, `.hermes` and the other
// dot-names only through an explicit leading `.`, or with dotglob/globdots.
// ---------------------------------------------------------------------------

/** Every class of the line, with no-rule setters (`shopt`, `setopt`) let through. */
function lineClasses(command: string): string[] {
  const result = classifyCommand(command, [], { noRuleSegments: true });
  return result.ok ? result.classes : [`refused:${result.code}`];
}

/** The class of the LAST segment, with no-rule setters (`shopt`, `setopt`) let through. */
function lastClass(command: string): string {
  const result = classifyCommand(command, [], { noRuleSegments: true });
  if (!result.ok) return `refused:${result.code}`;
  const last = result.segments[result.segments.length - 1];
  assert.ok(last !== undefined, command);
  return last.class;
}

const SAME_LINE_SETTERS: readonly string[] = [
  "shopt -s dotglob; ",
  "setopt globdots; ",
  "set -o globdots; ",
  "GLOBIGNORE=x; ",
  "setopt glob_dots; ",
  "unsetopt noglobdots; ",
  "set -4; ",
  "emulate ksh; ",
  "options[globdots]=on; ",
  "bash -c 'shopt -s dotglob'; ",
];

test("dot-names: an explicit leading dot reaches them with no option set", () => {
  for (const command of [
    "echo x > ~/.[!Z]ermes/auth.json",
    "echo x > ~/.h*/auth.json",
    "echo x > .appr*/env",
    "echo x > .[!Z]pproval/env",
    "cp a .c*/settings.json",
  ]) {
    assert.equal(strictest(command), "policy.core", command);
  }
});

test("dot-names: *, ? and [...] reach them, setter or not (lead ruling, CLAIMS L61492 and L61497)", () => {
  // dotglob (bash) and globdots (zsh) may be set in the user's own profile,
  // where no setter on the line shows: a write whose `*` or `?` would match a
  // guarded dot-name under them is that name's class.
  for (const command of [
    "echo x > dist/*/x.txt",
    "echo x > ~/*/auth.json",
    "echo x > */env",
    "echo x > ?approval/env",
    "echo x > [.]approval/env",
    "cp a ~/*/auth.json",
  ]) {
    assert.ok(classesOf(command).some((cls) => HUMAN_ONLY.has(cls)), `${command} -> ${classesOf(command).join(",")}`);
    for (const setter of SAME_LINE_SETTERS) {
      const cls = lastClass(`${setter}${command}`);
      assert.ok(HUMAN_ONLY.has(cls) || cls.startsWith("refused:"), `${setter}${command} -> ${cls}`);
    }
  }
  // An empty GLOBIGNORE assignment also turns dotglob on in bash.
  assert.equal(strictest("GLOBIGNORE=; echo x > dist/*/x.txt"), "policy.core");
});

test("dot-names: the ruling's workflow lines, with and without dot matching on the line", () => {
  // `*` can be APPROVAL.md (a guarded name at any depth, and matched with no
  // option: on APFS, case folded, `*.md` and `*` reach it as bash does), so a
  // write through `*` straight into a directory stays policy.core either way.
  for (const command of ["rm -rf dist/*", "chmod +x scripts/*", "git add src/*", "npx prettier --write src/*", "git add *"]) {
    assert.equal(strictest(command), "policy.core", command);
    assert.ok(lineClasses(`GLOBIGNORE=x; ${command}`).includes("policy.core"), command);
  }
  // A pattern for a DIRECTORY reaches only dot-directories, which dotglob or
  // globdots set in a profile lets it match (L61492): strict with no listing.
  assert.equal(strictest("echo x > dist/*/x.txt"), "policy.core");
  assert.equal(lastClass("shopt -s dotglob; echo x > dist/*/x.txt"), "policy.core");
  assert.equal(lastClass("setopt globdots; echo x > dist/*/x.txt"), "policy.core");
  // Patterns that reach no guarded name keep their class either way.
  for (const command of ["rm -rf dist/*.js", "chmod +x scripts/*.sh", "git add src/*.ts", "echo x > out/*.log"]) {
    assert.ok(!classesOf(command).some((cls) => HUMAN_ONLY.has(cls)), command);
    assert.ok(!HUMAN_ONLY.has(lastClass(`GLOBIGNORE=x; ${command}`)), command);
  }
});

test("dot-names: ANY option-setting construct on the line turns the relaxed reading off (fail closed)", () => {
  const target = "echo x > ~/*/auth.json";
  // Run-time spellings of an option name, and every setter whatever its argument.
  for (const setter of [
    "shopt -s $'\\x64otglob'; ",
    "shopt -s ${:-dotglob}; ",
    "shopt -s $(printf dotglob); ",
    "shopt -s `printf dotglob`; ",
    "shopt -s {dot,x}glob; ",
    "shopt -s x; ",
    "eval x; ",
    "source ./x; ",
    ". ./x; ",
    "set -4; ",
    "set +o x; ",
    "builtin set -o x; ",
    "se\\t -o x; ",
    "'set' -o x; ",
    "{se,}t -4; ",
    "$S -s x; ",
    "setopt x; ",
    "unsetopt x; ",
    "emulate sh; ",
    "options[x]=on; ",
    "GLOBIGNORE=x; ",
    "autoload -U x; ",
    "zsh -4 -c x; ",
    "env zsh -l -c x; ",
    "bash -i -c x; ",
    "sh -l -c x; ",
    "BASH_ENV=./x bash -c x; ",
    "ENV=./x sh -c x; ",
    "ZDOTDIR=./x zsh -c x; ",
  ]) {
    const cls = lastClass(`${setter}${target}`);
    assert.ok(HUMAN_ONLY.has(cls) || cls.startsWith("refused:"), `${setter}${target} -> ${cls}`);
  }
  // A line with none of them is read with dot-names matched too (L61492).
  for (const line of [target, `cd out && ${target}`, `ls; ${target}`, `true && ${target}`]) {
    assert.equal(lastClass(line), "policy.core", line);
  }
});

test("dot-names: the relaxed reading is an allowlist of plain lines (lead ruling, 22 Nov 2026)", () => {
  const target = "echo x > ~/*/auth.json";
  for (const setter of [
    "setopt GLOB_DOTS; ",
    "setopt glob_dots; ",
    "setopt Glob_Dots; ",
    "options=(globdots on); ",
    "options+=(globdots on); ",
    "typeset -A options; ",
    "declare -n o=x; ",
    "printf -v x y; ",
    "BASHOPTS=x; ",
    "SHELLOPTS=x; ",
    "BASH_ENV=x; ",
    "export X; ",
    "local x; ",
    "readonly x; ",
    "read x; ",
    "let x; ",
    "enable x; ",
    "command x; ",
    "exec x; ",
    "find . -exec x ; ",
    "xargs x < f; ",
    "sudo x; ",
    "nohup x; ",
    "timeout 1 x; ",
    "nice x; ",
    "env x; ",
    "ls -l; ",
    "x -i; ",
    "a=$'x'; ",
    "a=$\"x\"; ",
    "(x); ",
  ]) {
    const cls = lastClass(`${setter}${target}`);
    assert.ok(HUMAN_ONLY.has(cls) || cls.startsWith("refused:"), `${setter}${target} -> ${cls}`);
  }
  // A pattern for a directory reaches dot-directories on any line now
  // (L61492); one that reaches no guarded name keeps its class.
  assert.equal(strictest("echo x > assets/*/x.txt"), "policy.core");
  assert.deepEqual(classesOf("rm -rf assets/*.png"), ["files.delete.out_of_scope"]);
  // `rm -rf assets/*` is NOT main's class, and not because of dots: `*` can be
  // `APPROVAL.md`, which protectedPathClass guards at any depth (`rm
  // assets/APPROVAL.md` is policy.core on main).
  assert.equal(strictest("rm -rf assets/*"), "policy.core");
});

// ---------------------------------------------------------------------------
// Decided by what is THERE (lead ruling L61167): the hook lists the directory a
// pattern's first globbed component sits in and passes the names in.
// ---------------------------------------------------------------------------

function withListing(command: string, listings: Record<string, readonly string[] | "unreadable" | "missing">): string[] {
  const result = classifyCommand(command, [], {
    globDisk: { cwd: "/w", home: "/h", listings: new Map(Object.entries(listings)) },
  });
  assert.ok(result.ok, `${command}: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

test("listings: the four workflow lines by what the directory holds", () => {
  const lines: readonly (readonly [string, string, string])[] = [
    ["rm -rf dist/*", "/w/dist", "files.delete.out_of_scope"],
    ["chmod +x scripts/*", "/w/scripts", "files.write.workspace"],
    ["git add src/*", "/w/src", "vcs.commit.branch"],
    ["npx prettier --write src/*", "/w/src", "files.write.workspace"],
  ];
  for (const [command, dir, main] of lines) {
    assert.deepEqual(withListing(command, { [dir]: [] }), [main], `${command} empty`);
    assert.deepEqual(withListing(command, { [dir]: ["a.ts", "README.md", "x.png"] }), [main], `${command} unrelated`);
    // A dot-name: guarded, it counts on any line (L61492); unguarded, it does not.
    assert.ok(withListing(command, { [dir]: [".approval"] }).some((cls) => HUMAN_ONLY.has(cls)), `${command} .approval`);
    assert.deepEqual(withListing(command, { [dir]: [".cache", ".DS_Store", "a.ts"] }), [main], `${command} unguarded dot-names`);
    // The raised class, with a plain class that is not an ordinary write beside it (review-b S1).
    const raised = main.startsWith("files.") ? ["policy.core"] : ["policy.core", main];
    assert.deepEqual(withListing(command, { [dir]: ["APPROVAL.md"] }), raised, `${command} APPROVAL.md`);
    assert.deepEqual(withListing(command, { [dir]: ["apprOVAL.MD"] }), raised, `${command} apprOVAL.MD`);
    assert.deepEqual(withListing(command, { [dir]: "unreadable" }), raised, `${command} unreadable`);
    assert.deepEqual(withListing(command, {}), raised, `${command} not listed`);
  }
  // A dot-name counts on a line that may turn dot matching on.
  const classes = withListing("GLOBIGNORE=x; echo x > dist/*/env", { "/w/dist": [".approval"] });
  assert.equal(classes[classes.length - 1], "policy.core");
  // CLAUDE.md is policy.edit at any depth, as on main.
  assert.ok(withListing("rm -rf dist/*", { "/w/dist": ["CLAUDE.md"] }).includes("policy.edit"));
});

test("listings: home organs, absolute and relative prefixes, the first globbed level only", () => {
  assert.deepEqual(withListing("echo x > ~/.hermes/a*.json", { "/h/.hermes": ["auth.json"] }), ["policy.core"]);
  assert.deepEqual(withListing("echo x > ~/.hermes/a*.json", { "/h/.hermes": ["apps.json"] }), ["files.write.workspace"]);
  assert.deepEqual(withListing("echo x > /abs/out/*", { "/abs/out": ["a.log"] }), ["files.write.workspace"]);
  assert.deepEqual(withListing("echo x > /abs/out/*", { "/abs/out": ["APPROVAL.md"] }), ["policy.core"]);
  // A deeper globbed level keeps the over-approximated reading.
  assert.deepEqual(withListing("echo x > src/*/*", { "/w/src": ["lib"] }), ["policy.core"]);
  assert.deepEqual(withListing("echo x > src/*/*.ts", { "/w/src": ["lib"] }), ["files.write.workspace"]);
});

test("listings: which directories the hook lists, and none it cannot place", () => {
  assert.deepEqual(globWriteListingDirs("rm -rf dist/*", "/w", "/h"), ["/w/dist"]);
  assert.deepEqual(globWriteListingDirs("echo x > ~/.hermes/a*.json", "/w", "/h"), ["/h/.hermes"]);
  assert.deepEqual(globWriteListingDirs("echo x > *", "/w", "/h"), ["/w"]);
  assert.deepEqual(globWriteListingDirs("cp a /abs/*/x", "/w", "/h"), ["/abs"]);
  // A line that may change directory, a `..`, a variable or `~user` places nothing: strict.
  assert.deepEqual(globWriteListingDirs("cd x && rm -rf dist/*", "/w", "/h"), []);
  assert.deepEqual(globWriteListingDirs("rm -rf ../dist/*", "/w", "/h"), []);
  assert.deepEqual(globWriteListingDirs("rm -rf $D/*", "/w", "/h"), []);
  assert.deepEqual(globWriteListingDirs("rm -rf ~root/*", "/w", "/h"), []);
  // A read is not a write target: nothing is listed for it.
  assert.deepEqual(globWriteListingDirs("cat dist/*", "/w", "/h"), []);
  // Unplaceable stays strict even with a listing for the lexical directory.
  assert.deepEqual(withListing("cd x && rm -rf dist/*", { "/w/dist": [] }).slice(-1), ["policy.core"]);
});

test("listings, review of 6e3cbc9e: another command on the line, and a line-local HOME, keep the strict answer", () => {
  const empty = { "/w/dist": [] as string[], "/h/dist": [] as string[] };
  // Something earlier (or beside) may create, move, link or extract the guarded name.
  for (const command of [
    "touch dist/APPROVAL.md; rm -rf dist/*",
    "mv x dist/approval.md && chmod +x dist/*",
    "cp x dist/APPROVAL.md; rm -rf dist/*",
    "ln -s x dist/APPROVAL.md; rm -rf dist/*",
    "git checkout -- x; rm -rf dist/*",
    "tar -xf a.tar; rm -rf dist/*",
    "echo x > dist/APPROVAL.md; rm -rf dist/*",
    "mkdir -p dist; rm -rf dist/*",
    "make & rm -rf dist/*",
  ]) {
    assert.ok(withListing(command, empty).includes("policy.core"), command);
  }
  // A substitution that writes is refused outright; a read-only one still drops the listing.
  const substituted = classifyCommand("rm -rf dist/* $(touch dist/APPROVAL.md)", [], {
    globDisk: { cwd: "/w", home: "/h", listings: new Map(Object.entries(empty)) },
  });
  assert.equal(substituted.ok, false);
  assert.ok(withListing("rm -rf dist/* $(pwd)", empty).includes("policy.core"));
  // Read-only company keeps the listing.
  for (const command of ["ls; rm -rf dist/*", "pwd && rm -rf dist/*", "rm -rf dist/* | cat", "true; rm -rf dist/*"]) {
    assert.ok(!withListing(command, empty).includes("policy.core"), command);
  }
  // HOME named anywhere on the line: a `~` prefix is not placed.
  for (const command of [
    "HOME=/tmp/x; rm -rf ~/dist/*",
    "export HOME=/tmp/x; rm -rf ~/dist/*",
    "read HOME; rm -rf ~/dist/*",
    "unset HOME; rm -rf ~/dist/*",
    "for HOME in /tmp; do rm -rf ~/dist/*; done",
  ]) {
    const result = classifyCommand(command, [], { globDisk: { cwd: "/w", home: "/h", listings: new Map(Object.entries(empty)) } });
    assert.ok(!result.ok || result.classes.includes("policy.core"), command);
  }
  assert.deepEqual(withListing("rm -rf ~/dist/*", empty), ["files.delete.out_of_scope"]);
  assert.ok(withListing("rm -rf ~root/dist/*", empty).includes("policy.core"));
});

// ---------------------------------------------------------------------------
// Review-b A686 (CLAIMS L61199) and lead ruling L61195.
// ---------------------------------------------------------------------------

test("review-b S1: a raised class never takes the plain class away", () => {
  // `.approval/*` is policy.core as text; the pattern may also be the log.
  const approval = classesOf("echo x > .approval/*");
  assert.ok(approval.includes("log.mutate") && approval.includes("policy.core"), approval.join(","));
  const removed = classesOf("rm -f .approval/*");
  assert.ok(removed.includes("policy.core"), removed.join(","));
  // The `.git` reader's class rides beside a pattern's.
  const git = classesOf("echo x > $'\\x2e'g?t/config");
  assert.ok(git.includes("vcs.history.rewrite"), git.join(","));
  // An ordinary plain class is not carried beside a raised one.
  assert.deepEqual(classesOf("echo x > ~/.hermes/a*.json"), ["policy.core"]);
});

test("review-b M1: one matcher budget for the whole line; exhausted is strict, and cheap", () => {
  const word = `${"[a]".repeat(254)}x`;
  const line = `rm -f ${Array.from({ length: 400 }, () => word).join(" ")}`;
  const started = process.cpuUsage();
  const result = classifyCommand(line);
  const spent = process.cpuUsage(started);
  const seconds = (spent.user + spent.system) / 1e6;
  assert.ok(result.ok);
  assert.ok(result.classes.includes("log.mutate"), result.classes.join(","));
  assert.ok(seconds < 5, `took ${String(seconds)} CPU s`);
});

test("lead ruling L61195 (a): zsh's clobbering redirects write the next word", () => {
  for (const [command, cls] of [
    ["echo x >! APPROVAL.md", "policy.core"],
    ["echo x >!APPROVAL.md", "policy.core"],
    ["echo x >! .approval/env", "policy.core"],
    ["echo x >>! .approval/log/events.jsonl", "log.mutate"],
    ["echo x >| APPROVAL.md", "policy.core"],
    ["echo x >>| APPROVAL.md", "policy.core"],
    ["echo x >! ~/.hermes/a?th.json", "policy.core"],
    ["echo x &>! APPROVAL.md", "policy.core"],
  ] as const) {
    assert.ok(classesOf(command).includes(cls), `${command} -> ${classesOf(command).join(",")}`);
  }
  assert.ok(classesOf("echo x >! .git/config").includes("vcs.history.rewrite"));
  assert.deepEqual(classesOf("echo x >! out.log"), ["files.write.workspace"]);
});

test("lead ruling L61195 (b): a copy, move or link into a directory is judged by the file it lands", () => {
  for (const command of [
    "cp evil/settings.json .claude/",
    "cp evil/settings.json .claude",
    "mv evil/settings.json .claude/",
    "ln -sf evil/settings.json .claude/",
    "cp -t .claude evil/settings.json",
    "cp evil/settings.json .claud?/",
    "cp evil/hooks.json .cursor/",
    "cp evil/hooks.json .grok/",
    "cp evil/hooks.json .muse/",
    "cp -r evil/hooks .cursor/",
    "cp a evil/settings.json .claude/",
    "cp evil/* .claude/",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // install has no rule (refused on main and here).
  assert.equal(classifyCommand("install evil/hooks.json .cursor/").ok, false);
  for (const command of ["cp a.txt out/", "mv a.txt b.txt"]) {
    assert.ok(!classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // Into the guarded directory itself, any file (the split ruling, L61320).
  assert.ok(classesOf("cp evil/notes.txt .claude/").includes("policy.core"));
  // A glob source is expanded from its own directory's listing, not the destination's.
  const listed = (command: string, names: readonly string[]): string[] => withListing(command, { "/w/evil": names, "/w/out": [] });
  assert.ok(listed("cp evil/* out/", ["APPROVAL.md"]).includes("policy.core"));
  assert.ok(!listed("cp evil/* out/", ["notes.txt"]).includes("policy.core"));
  assert.ok(!withListing("cp -r src/* out/", { "/w/src": ["a.ts", "lib"], "/w/out": [] }).includes("policy.core"));
});

test("review-b S2: an option-dependent zsh form is literal text on a plain line", () => {
  assert.deepEqual(classesOf("rm -f *~"), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf("rm -f out/#x"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("echo x > out/^x"), ["files.write.workspace"]);
  // With options possibly set on the line, they are patterns again.
  assert.equal(lastClass("setopt extendedglob; echo x > APPROVAL.m*~x"), "policy.core");
});

test("review of b402adec (H1): zsh's >&! >&| >>&! >>&| and &>! write the next word", () => {
  for (const command of ["echo x >&! APPROVAL.md", "echo x >&| APPROVAL.md", "echo x >>&! .approval/env", "echo x >>&| .approval/env", "echo x &>! APPROVAL.md", "echo x &>| APPROVAL.md", "echo x &>>! .approval/env"]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  assert.ok(classesOf("echo x >&! .git/config").includes("vcs.history.rewrite"));
  assert.deepEqual(classesOf("echo x >&2"), ["read.shell"]);
});

test("review of b402adec (M2): a destination any name may land in is judged as the organ directory it is", () => {
  for (const [command, cls] of [
    ["cp -r src/ .claude/", "policy.core"],
    ["cp -r src/. .claude/", "policy.core"],
    ["cp -r src/.. .claude/", "policy.core"],
    ["cp -R src .claude", "policy.core"],
    ["cp -a src .cursor", "policy.core"],
    ["cp -T src .claude", "policy.core"],
    ["mv src .claude", "policy.core"],
    ["ln -s src .claude", "policy.core"],
    ["rsync -a src/ .claude/", "policy.core"],
    ["tar -x -C .claude -f a.tar", "policy.core"],
    ["tar -xf a.tar --directory=.cursor", "policy.core"],
    ["tar -xzf a.tgz -C.grok", "policy.core"],
    ["cp -r src/ .muse/", "policy.core"],
    ["cp -r src/ .c*/", "policy.core"],
    ["cp -r src/ .github/", "policy.edit"],
  ] as const) {
    assert.ok(classesOf(command).includes(cls), `${command} -> ${classesOf(command).join(",")}`);
  }
  // Lead ruling on the split (L61320): a copy INTO a guarded directory is
  // judged by the directory's name alone, whatever it copies.
  assert.ok(classesOf("cp a.txt .claude/").includes("policy.core"));
  assert.ok(classesOf("cp CONTRIBUTING.md .github/").includes("policy.edit"));
  assert.ok(classesOf("cp -r src/ .claude/sub/").includes("policy.core"));
  assert.ok(classesOf("mv notes.md ~/.cursor/rules/").includes("policy.core"));
  // An ordinary destination stays ordinary, whatever is listed.
  for (const command of ["cp -r src/ out/", "rsync -a src/ out/", "tar -xf a.tar -C out", "cp a.txt docs/"]) {
    for (const classes of [classesOf(command), withListing(command, { "/w/out": [".claude"] })]) {
      assert.ok(!classes.includes("policy.core") && !classes.includes("policy.edit"), `${command} -> ${classes.join(",")}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Review of 039b840a: three findings on copy and extraction destinations.
// ---------------------------------------------------------------------------

const ORDINARY = (classes: readonly string[]): boolean => !classes.some((cls) => ["policy.core", "policy.edit", "log.mutate"].includes(cls));

test("finding 1: a destination is normalised lexically before the organ test", () => {
  for (const command of [
    "cp -r src/ .claude/x/..",
    "cp -r src/ ./.claude/.",
    "cp -r src/ .claude//",
    "cp -r src/ a/../.claude",
    "mv src ./x/../.cursor/",
    "rsync -a src/ ./.grok/y/..",
    "tar -xf a.tar -C .muse/./",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  assert.ok(classesOf("cp -r src/ .github/w/..").includes("policy.edit"));
  // `..` that leaves the guarded directory is not it.
  assert.ok(ORDINARY(classesOf("cp -r src/ .claude/..")));
  assert.ok(ORDINARY(classesOf("cp -r src/ out/.claude/..")));
});

/**
 * Moved to a follow-up (lead ruling on the #686 split, CLAIMS L61320): a
 * contents copy or extraction into an ORDINARY directory or an ancestor of a
 * guarded one keeps main 21fc5fdc's class here, recorded from its build. The
 * follow-up changes these deliberately.
 */
const MOVED_TO_FOLLOW_UP: readonly (readonly [string, string])[] = [
  ["tar -xf x.tar", "files.write.workspace"],
  ["tar -xzf a.tgz -C .", "files.write.workspace"],
  ["tar -x -C build -f a.tar", "files.write.workspace"],
  ["cp -r src/. .", "files.write.workspace"],
  ["cp -R src/ .", "files.write.workspace"],
  ["rsync -a src/ .", "network.call"],
  ["cp -r /tmp/stuff/. .", "files.write.workspace"],
  ["tar -xzf dist/pkg.tgz", "files.write.workspace"],
  ["tar -xzf dist/pkg.tgz -C build/unpack", "files.write.workspace"],
  ["tar -xf /tmp/x.tar", "files.write.workspace"],
  ["tar -xPf a.tar -C out", "files.write.workspace"],
  ["tar -xf a.tar --strip-components=1 -C out", "files.write.workspace"],
  ["tar -xf a.tar --transform s/a/b/ -C out", "files.write.workspace"],
  ["cp -r src/ ..", "files.write.workspace"],
  ["cp -r src/ ~", "files.write.workspace"],
  ["tar --strip-components=1 -xf a.tar", "files.write.workspace"],
  ["tar -x -f a.tar", "files.write.workspace"],
  ["tar -xPf a.tar", "files.write.workspace"],
  ["tar -xf a.tar --transform s,^,.claude/,", "files.write.workspace"],
  ["rsync -a src/ ..", "network.call"],
  ["rsync -a src/ ~", "network.call"],
];

test("moved to a follow-up: contents copies and extractions into an ordinary place keep main's class", () => {
  const listings = { "/w": ["src", ".claude", "APPROVAL.md"], "/w/src": [".claude"], "/w/out": [], "/w/build": "missing" as const };
  for (const [command, main] of MOVED_TO_FOLLOW_UP) {
    assert.deepEqual(classesOf(command), [main], command);
    assert.deepEqual(withListing(command, listings), [main], `${command} (listed)`);
  }
  // A source landing AS a guarded directory is still one (kept).
  assert.ok(classesOf("cp -r evil/.claude .").includes("policy.core"));
  assert.ok(classesOf("mv evil/.github .").includes("policy.edit"));
  assert.ok(classesOf("rsync -a h:.claude .").includes("policy.core"));
  assert.ok(classesOf("cp -r .claude backup/").includes("policy.core"));
});

test("finding 2: option values are not operands; an unknown option makes every operand a destination", () => {
  for (const command of [
    "rsync -a src/ .claude/ --exclude x",
    "rsync -a --exclude x src/ .claude",
    "rsync -av -e ssh src/ .claude",
    "rsync -a src/ .claude --exclude-from list.txt",
    "rsync -a src/ .claude -f '- x'",
    "rsync -aT tmp src/ .claude",
    "cp -r src/ .claude -S bak",
    "cp -r src/ .claude --suffix bak",
    "cp -r src/ .claude --no-preserve mode",
    "cp -r src/ .claude --sparse never",
    "mv src .claude -S bak",
    "mv src .claude --suf bak",
    "ln -s src .claude -S bak",
    "scp -r -P 22 h:src/ .claude",
    "scp -r h:src/ .claude -o Port=22",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // An option the table does not know: every operand counts.
  for (const command of ["rsync -a --newthing x .claude src/", "cp --frobnicate src .claude x", "rsync -Q src .claude x"]) {
    assert.ok(classesOf(command).includes("policy.core"), command);
  }
  // Directories and files rsync's own options write.
  assert.ok(classesOf("rsync -a --backup-dir=.claude src/ out/").includes("policy.core"));
  assert.ok(classesOf("rsync -a --partial-dir .cursor src/ out/").includes("policy.core"));
  assert.ok(classesOf("rsync -a --log-file=APPROVAL.md src out").includes("policy.core"));
  // Known options and their values leave ordinary copies ordinary.
  for (const command of ["rsync -av --exclude node_modules --delete src out", "cp -p --preserve=mode a b", "mv -f --backup=numbered a b", "scp -P 22 h:x out"]) {
    assert.ok(ORDINARY(withListing(command, {})), `${command} -> ${withListing(command, {}).join(",")}`);
  }
});

test("finding 3: tar's extraction directory in every spelling; other archive tools stay refused", () => {
  for (const command of [
    "tar xCf .claude a.tar",
    "tar xfC a.tar .claude",
    "tar -xCf .claude a.tar",
    "tar -xf a.tar --cd .claude",
    "tar -xf a.tar --cd=.claude",
    "tar -xf a.tar --dir .claude",
    "tar -xf a.tar --direc=.claude",
    "tar --extract -f a.tar --directory .claude",
    "tar -xf a.tar -C.claude",
    "tar -x -f a.tar -C ./.claude/.",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // Kept by name: an extraction INTO a guarded directory, whatever its options.
  for (const command of ["tar -xPf a.tar -C .claude", "tar -xf a.tar --strip-components=1 -C .cursor/x", "tar -x -f a.tar -C .github"]) {
    assert.ok(!ORDINARY(classesOf(command)), command);
  }
  // Creating an archive from a directory reads it.
  assert.ok(ORDINARY(classesOf("tar -czf out.tgz -C .claude .")));
  // No rule on either build: refused, so fail closed already.
  for (const command of ["unzip a.zip -d .claude", "unzip a.zip", "ditto src .claude", "ditto -x -k a.zip .claude", "cpio -i -D .claude", "pax -r -f a.pax", "bsdtar -xf a.tar -C .claude", "gtar -xf a.tar", "7z x a.7z -o.claude"]) {
    const result = classifyCommand(command, []);
    assert.ok(!result.ok || result.classes.includes("policy.core"), command);
  }
});

test("review of 3230ecb6: a quoted glob character, and a special parameter's name, are not patterns", () => {
  for (const command of ['echo x > "exit-$?.txt"', "echo x > exit-$?.txt", 'echo x > "$#:t.txt"', 'echo x > "$f[1,4]/out"', "echo x > out-$$.txt", "echo x > log-$!.txt"]) {
    assert.ok(ORDINARY(classesOf(command)), `${command} -> ${classesOf(command).join(",")}`);
  }
  // Unquoted, bash globs the bracket beside an unknown value; `$1?` too.
  for (const command of ["echo x > $f[1,4]/out", "echo x > $1?", 'echo x > "$1"?', "echo x > $*[1,4]"]) {
    assert.ok(!ORDINARY(classesOf(command)), command);
  }
  // zsh's `^` and `#` are patterns only unquoted, where the line may set options.
  assert.ok(classesOf("GLOBIGNORE=x; echo x > ^y").includes("policy.core"));
  assert.ok(ORDINARY(classesOf('GLOBIGNORE=x; echo x > "^y"')));
  assert.ok(ORDINARY(classesOf("GLOBIGNORE=x; echo x > a\\^y")));
  assert.ok(ORDINARY(classesOf("echo x > ^y")));
});

// ---------------------------------------------------------------------------
// Review of e6b7bf97: four findings.
// ---------------------------------------------------------------------------

/** Main 21fc5fdc's class for each form, recorded from its build (`classifyCommand(form, [])`). */
const MAIN_21FC5FDC: readonly (readonly [string, string])[] = [
  ["ln -s ../evil APPROVAL.md", "policy.core"],
  ["ln -s .claude/settings.json", "policy.core"],
  ["ln -s ../evil/APPROVAL.md", "policy.core"],
  ["ln -sf x/APPROVAL.md", "policy.core"],
  ["cp x/APPROVAL.md", "policy.core"],
  ["mv APPROVAL.md", "policy.core"],
  ["ln -s ~/.hermes/auth.json", "policy.core"],
  ["ln -s ../evil/.claude", "files.write.workspace"],
  ["ln -s /evil/APPROVAL.m?", "files.write.workspace"],
  ["cp -r x", "files.write.workspace"],
];
const RANK = ["log.mutate", "policy.core", "policy.edit"];
const rankOf = (classes: readonly string[]): number => Math.min(...classes.map((cls) => (RANK.includes(cls) ? RANK.indexOf(cls) : RANK.length)));

test("e6b7bf97 (1): an implied destination (`ln -s TARGET`) and a single operand are never looser than main", () => {
  for (const [command, main] of MAIN_21FC5FDC) {
    const head = classesOf(command);
    assert.ok(rankOf(head) <= rankOf([main]), `${command}: head ${head.join(",")} vs main ${main}`);
  }
  // `ln -s TARGET` creates `./basename(TARGET)`, judged as a landing.
  assert.ok(classesOf("ln -s /evil/APPROVAL.m?").includes("policy.core"));
  assert.ok(classesOf("ln -s ../evil/.claude").includes("policy.core"));
  assert.ok(classesOf("ln -s ../evil/.git?ub").includes("policy.edit"));
  assert.ok(ORDINARY(classesOf("ln -s ../lib/util.js")));
});

test("lead ruling on the split (L61320): a copy INTO a guarded directory, or under one, by its name alone", () => {
  for (const command of [
    "cp evil/settings.json .claude/",
    "cp -r x/. .claude/",
    "tar -xf a.tar -C .claude",
    "rsync -a src/ .claude/hooks/",
    "cp -r src/ ./.claude/sub/../x",
    "scp h:x .grok/",
    "ln -sf ../evil .muse/link",
    "cp --parents a/b .cursor",
    "rsync -R a/b .claude",
    "cp -r src/ ~/.claude/",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // .git is #683's git-dir rule, with its own rule id; the bare-guarded
  // directories are the text rule's.
  for (const command of ["rsync -a src/ .git/hooks/", "tar -xf a.tar -C .git"]) {
    const result = classifyCommand(command, []);
    assert.ok(result.ok && result.segments.some((segment) => segment.class === "vcs.history.rewrite" && segment.rule === "git-dir-write"), command);
  }
  assert.ok(classesOf("cp -r src/ .approval/").includes("policy.core"));
  // No listing relaxes it.
  assert.ok(withListing("cp -r src/ .claude/", { "/w/.claude": [], "/w/src": ["a.js"] }).includes("policy.core"));
});

test("e6b7bf97 (3): only a real `$` names a special parameter; a quoted or escaped one leaves the glob", () => {
  for (const command of ["echo x > exit-$?.txt", 'echo x > "exit-$?.txt"', "echo x > out-$$.txt", 'echo x > "$#:t.txt"']) {
    assert.ok(!classesOf(command).includes("log.mutate"), command);
  }
  // `'$'*` and `\$*` are a literal `$` and a live `*`.
  for (const command of ["echo x > '$'*", "echo x > \\$*", 'echo x > "\\$"*', "echo x > $'$'*"]) {
    assert.ok(!ORDINARY(classesOf(command)), command);
  }
  // Where the line may set options, an escaped `$` before `#` leaves zsh's `#`.
  assert.ok(!ORDINARY(classesOf("GLOBIGNORE=x; echo x > \\$#APPROVAL.md")));
  // Finding 1 on 8dca8d93: a `$` that expands no name (`$"…"`, `$\x`, a final
  // `$`, `$'…'`) turns the masking off for the word; never looser than main.
  for (const command of ['echo x > $"APPROVAL.md"', "echo x > $\\APPROVAL.md", "echo x > a$", "echo x > $'x'*"]) {
    const result = classifyCommand(command, []);
    assert.ok(result.ok, command);
  }
  for (const command of ["echo x > $'A'*$?", 'echo x > $"A"*$#']) {
    assert.ok(!ORDINARY(classesOf(command)), command);
  }
  // Every `$` real: `$*` and `$?` are names, so no pattern.
  assert.ok(ORDINARY(classesOf("echo x > a$*$?")));
});

test("e6b7bf97 (4): a directory that was not there is empty only to a glob on a one-segment line", () => {
  assert.deepEqual(withListing("rm -rf d/*", { "/w/d": "missing" }), ["files.delete.out_of_scope"]);
  for (const command of ["true; rm -rf d/*", "ls; echo x > d/*", "echo a && rm -rf d/*"]) {
    assert.ok(withListing(command, { "/w/d": "missing" }).includes("policy.core"), command);
  }
  // Another writer on the line: no listing is used at all.
  assert.ok(withListing("mkdir -p d && cp x d/*", { "/w/d": "missing" }).includes("policy.core"));
});

test("review of 8e1e84ae (3): a path-preserving copy lands under the destination by the source's path", () => {
  for (const [command, cls] of [
    ["cp --parents .claude/settings.json .", "policy.core"],
    ["cp --parents x/.cursor/hooks.json out", "policy.core"],
    ["rsync -R src/./.cursor/hooks.json out", "policy.core"],
    ["rsync -a --relative src/.claude/settings.json out/", "policy.core"],
    ["rsync -R .approval/env backup/..", "account.credential"],
    ["rsync -a --files-from=list . .claude/", "policy.core"],
  ] as const) {
    assert.ok(classesOf(command).includes(cls), `${command} -> ${classesOf(command).join(",")}`);
  }
  // .git keeps #683's rule id.
  const git = classifyCommand("rsync -R x/./.git/hooks/pre-push .", []);
  assert.ok(git.ok && git.segments.some((segment) => segment.class === "vcs.history.rewrite" && segment.rule === "git-dir-write"));
  // Ordinary paths, and a file list into an ordinary place (the follow-up's), keep main's class.
  for (const [command, main] of [
    ["cp --parents a/b out/", "files.write.workspace"],
    ["rsync -R a/b out", "network.call"],
    ["rsync -a --files-from=list . out/", "network.call"],
  ] as const) {
    assert.deepEqual(classesOf(command), [main], command);
  }
});

test("review of 8e1e84ae (4): a destination is a path by construction, whitespace and all", () => {
  for (const command of ['cp x ".claude/my file"', 'mv x ".cursor/a b/"', 'rsync -a src/ ".claude/x y/"', 'tar -xf a.tar -C ".grok/a b"']) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  assert.ok(classesOf('cp x ".github/workflows/a b.yml"').includes("policy.edit"));
  // An ordinary destination with whitespace stays ordinary.
  assert.ok(ORDINARY(classesOf('cp x "notes/a b.txt"')));
});

test("review of 4f0169ec: rsync's relative mode by option order, fail closed; a globbed destination of a path-preserving copy", () => {
  // Relative mode possibly on (anywhere on the line): the path-preserving
  // landing is judged beside the basename one, and the stricter answers.
  for (const command of [
    "rsync -R --no-relative .claude/x backup/",
    "rsync --no-relative -R .claude/settings.json out/",
    "rsync --no-R -R .claude/x backup/",
    "rsync -R x/./.claude/s .cl*/",
    "cp --parents a/b .cla?de/",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // With no relative mode, a `/./` is only a path: the basename landing.
  assert.deepEqual(classesOf("rsync -a x/./y/notes.txt out/"), ["network.call"]);
  // The basename landing is always judged.
  assert.ok(classesOf("rsync -R a/.claude out/").includes("policy.core"));
});

/** CPU seconds (user and system) spent in `run`: this machine is shared, so not wall-clock time. */
function cpuSeconds(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

test("review A686-FOLD2 (M1, M2): a copy's destinations and sources are judged once per word, not per component or per call", () => {
  // M1: organDestination asked `inexact(dest)` and `glob.live(dest)` for every
  // component, each a scan of the segment's words, so one destination of many
  // globbed components was quadratic (21.8 CPU s at 160 KB through the hook on
  // 439e22ca; main 0.10). M2: the copy readers asked them of every source and
  // destination (rsync -aR 24.8 s at 80 KB; main 4.3). Each text is now
  // answered once per segment, with the same answer.
  //
  // Each line is timed against a control of the same length with no glob in
  // it, so the matcher and the copy readers skip it and main's own passes over
  // the words still run; the factor is generous for a CI runner. On 439e22ca
  // every line below fails it (3 to 40 CPU s against controls under 0.3 here);
  // at this head each takes under 1 CPU s here at 160 KB.
  const BYTES = 160 * 1024;
  const fill = (head: string, unit: string, tail: string): string =>
    head + unit.repeat(Math.floor((BYTES - head.length - tail.length) / unit.length)) + tail;
  const distinct = (head: string, unit: (i: number) => string, tail: string): string => {
    let line = head;
    for (let i = 0; line.length < BYTES - tail.length - 16; i += 1) line += unit(i);
    return line + tail;
  };
  const shapes: readonly (readonly [string, string, string])[] = [
    ["M1: one destination of many globbed components", fill("cp -r evil/. ", "a*/", ".cl*/"), fill("cp -r evil/. ", "ab/", ".clx/")],
    ["M2: many relative-mode sources into a globbed destination", fill("rsync -aR", " a/./b*c", " .cl*/"), fill("rsync -aR", " a/./bxc", " .clx/")],
    ["M2: many path-preserving sources", fill("cp --parents", " a/b/c?d", " .cla?de/"), fill("cp --parents", " a/b/cxd", " .claxde/")],
    // Every source a different word: a remembered answer cannot help, the set lookup must.
    [
      "M2: many different relative-mode sources",
      distinct("rsync -aR", (i) => ` a/./b*c${String(i)}`, " .cl*/"),
      distinct("rsync -aR", (i) => ` a/./bxc${String(i)}`, " .clx/"),
    ],
    // Half the sources quoted, so not one of the words that may glob: each is
    // looked for inside them (439e22ca: 114 CPU s at 320 KB through the hook).
    [
      "M2: many different sources, half of them quoted",
      distinct("rsync -aR", (i) => (i % 2 ? ` 'q*${String(i)}'` : ` a/./b*${String(i)}`), " .cl*/"),
      distinct("rsync -aR", (i) => (i % 2 ? ` 'qx${String(i)}'` : ` a/./bx${String(i)}`), " .clx/"),
    ],
  ];
  const FACTOR = 8;
  for (const [label, line, control] of shapes) {
    let classes: string[] = [];
    const base = cpuSeconds(() => {
      assert.ok(classesOf(control).every((cls) => !HUMAN_ONLY.has(cls)), `${label}: the control is ordinary`);
    });
    const seconds = cpuSeconds(() => {
      classes = classesOf(line);
    });
    // The class is unchanged: the step budget, then the guarded destination, answers.
    assert.ok(classes.some((cls) => HUMAN_ONLY.has(cls)), `${label} -> ${classes.join(",")}`);
    assert.ok(seconds < FACTOR * base + 1, `${label}: ${seconds.toFixed(2)} CPU s, the control ${base.toFixed(2)}, factor ${String(FACTOR)}`);
  }
  // The answer is still the substring scan's: a text only contained in a word
  // (an option's attached value) counts with it.
  assert.ok(classesOf("rsync -a evil/ --partial-dir=.cl* out/").includes("policy.core"));
  assert.ok(classesOf("cp -r evil/. a*/'.cl*'/").includes("policy.core"));
  assert.deepEqual(classesOf("cp -r evil/. 'a*/.cl*/'"), ["files.write.workspace"]);
});

test("review A686-FOLD2 (M2): containedInAny answers as the scan of the words does, for every text", () => {
  const scan = (words: readonly string[], text: string): boolean => words.some((word) => word.includes(text));
  // Edges: no words, the empty text, a text across two words' join, a NUL in a word or a text.
  const cases: readonly (readonly [readonly string[], string])[] = [
    [[], ""],
    [[], "a"],
    [[""], ""],
    [[""], "a"],
    [["a"], ""],
    [["xa", "bx"], "ab"],
    [["xa", "bx"], "a\0b"],
    [["a\0b"], "a\0b"],
    [["a\0b"], "\0"],
    [["a\0b", "c"], "b"],
    [["a\0b", "c"], "\0c"],
    [["--partial-dir=.cl*", "out/"], ".cl*"],
    [["a/./b*c", "a/./b*c"], "a/./b*c"],
  ];
  for (const [words, text] of cases) {
    const ask = containedInAny(words);
    assert.equal(ask(text), scan(words, text), `${JSON.stringify(words)} ${JSON.stringify(text)}`);
    assert.equal(ask(text), scan(words, text), `${JSON.stringify(words)} ${JSON.stringify(text)}, asked again`);
  }
  // Random words and texts over a small alphabet with a NUL in it (seeded).
  let seed = 4392;
  const next = (n: number): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed % n;
  };
  const ALPHABET = ["a", "b", "*", "/", "\0"];
  const word = (): string => Array.from({ length: next(6) }, () => ALPHABET[next(ALPHABET.length)]).join("");
  for (let round = 0; round < 2000; round += 1) {
    const words = Array.from({ length: next(6) }, word);
    const ask = containedInAny(words);
    for (let i = 0; i < 12; i += 1) {
      const text = next(3) === 0 && words.length > 0 ? words[next(words.length)]! : word();
      assert.equal(ask(text), scan(words, text), `${JSON.stringify(words)} ${JSON.stringify(text)}`);
    }
  }
});

test("lead ruling (CLAIMS L61492, L61497): a write's * or ? that would match a guarded dot-name under dotglob or globdots is that name's class, setter or not", () => {
  // The sweep's dotglob rows (known-dotglob-9d9ec0b6, 88 allowed on 439e22ca), one per family.
  for (const command of [
    "echo x > ~/*/auth.json",
    "echo x > ~/*/hermes-agent/.env",
    "echo x > */env",
    "echo x > */keys/k1",
    "cp README.md ~/*/profiles/p1/auth.json",
    "echo x > ~/?hermes/auth.json",
    "echo x > ~/.hermes/?env",
    "echo x > ?approval/vault.enc",
    "cp README.md ~/?hermes/hermes-agent/.env",
    "echo x > ~/[.]hermes/auth.json",
    "echo x > ~/.hermes/[.]op.env",
    "echo x > [.]approval/env",
    "echo x > ~/**/auth.json",
    "echo x > **/vault.enc",
    "cp README.md ~/**/profiles/p1/.env",
  ]) {
    assert.ok(classesOf(command).some((cls) => HUMAN_ONLY.has(cls)), `${command} -> ${classesOf(command).join(",")}`);
  }
  // With a listing, by what is there: a guarded dot-name counts, an unguarded one does not.
  assert.deepEqual(withListing("echo x > ~/*/auth.json", { "/h": [".hermes", "notes"] }), ["policy.core"]);
  assert.deepEqual(withListing("echo x > ~/*/auth.json", { "/h": [".cache", "notes"] }), ["files.write.workspace"]);
  assert.deepEqual(withListing("echo x > */env", { "/w": [".approval"] }).filter((cls) => HUMAN_ONLY.has(cls)).length > 0, true);
  assert.deepEqual(withListing("echo x > */env", { "/w": ["src", ".github"] }), ["files.write.workspace"]);
  // `.git`: `rm -f *` and `chmod 644 *` in a directory holding it take the
  // git-dir class (the cost the lead accepted); in one that does not, main's.
  for (const [command, main] of [
    ["rm -f *", "files.delete.out_of_scope"],
    ["chmod 644 *", "files.write.workspace"],
    ["rm -rf ./*", "files.delete.out_of_scope"],
  ] as const) {
    assert.ok(withListing(command, { "/w": [".git", "a.js"] }).includes("vcs.history.rewrite"), `${command} with .git`);
    assert.deepEqual(withListing(command, { "/w": ["a.js", ".cache"] }), [main], `${command} without .git`);
  }
  assert.deepEqual(withListing("rm -rf dist/*", { "/w/dist": ["a.js", ".cache"] }), ["files.delete.out_of_scope"]);
  assert.ok(withListing("chmod 644 dist/*", { "/w/dist": [".GIT"] }).includes("vcs.history.rewrite"));
  // A segment that cannot match `.git` (`*.ts`), or a pattern in no leading
  // place, is not read for it.
  assert.deepEqual(withListing("chmod 644 *.ts", { "/w": [".git", "a.ts"] }), ["files.write.workspace"]);
  // A copy into a destination a pattern may spell as an organ directory: `*` can be `.claude`.
  assert.ok(classesOf("rsync -a pkg/ */").includes("policy.core"));
  assert.deepEqual(classesOf("rsync -a pkg/ o*/"), ["network.call"]);
  // `.grok` and `.muse` are organ directories only (no guarded file under them is named).
  assert.deepEqual(classesOf("rsync -a pkg/ ?grok/"), ["policy.core", "network.call"]);
  assert.deepEqual(classesOf("tar -xf a.tar -C *use"), ["policy.core"]);
  // A pattern reading never takes a class away (review-b S1): the plain
  // class rides beside the one a destination pattern raised; the plain pass
  // reads destinations as before the ruling, so `.cl*/` carries nothing new.
  assert.deepEqual(classesOf("mv a .git/*"), ["policy.core", "vcs.history.rewrite"]);
  assert.deepEqual(classesOf("rsync -a evil/ .cl*/"), ["policy.core"]);
});
