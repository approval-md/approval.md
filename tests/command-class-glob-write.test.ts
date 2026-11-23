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

import { classifyCommand, classifyCommandWithMainRules, containedInAny, gitRemovedPaths, globWriteListingDirs, realpathKey } from "../src/core/command-class.js";

const HUMAN_ONLY = new Set(["policy.core", "log.mutate", "account.credential"]);

function classesOf(command: string, protectedPaths: readonly (string | { path: string; class: string })[] = []): string[] {
  const result = classifyCommand(command, protectedPaths);
  assert.ok(result.ok, `${command} was refused: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

/**
 * `expected`, then every class main gives the line that it lacks: GLOB-WRITE
 * adds its class and main's rides beside (lead ruling L61926). Main's answer
 * is the classifier with every GLOB-WRITE rule off, which equals main
 * 324d87dc's on the 47,001-line corpus.
 */
function andMain(expected: readonly string[], command: string, listings?: Record<string, readonly string[] | "unreadable" | "missing">): string[] {
  const main = classifyCommandWithMainRules(command, [], listings === undefined ? {} : { globDisk: { cwd: "/w", home: "/h", listings: new Map(Object.entries(listings)) } });
  assert.ok(main.ok, `${command}: main refuses it`);
  return [...expected, ...main.classes.filter((cls) => !expected.includes(cls))];
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
  assert.deepEqual(classesOf("echo x > out/a^Z"), andMain(["files.write.workspace"], "echo x > out/a^Z"));
  // A whole `**` descends into dot-directories with dot matching on, which
  // the user's profile may set unseen (lead ruling, CLAIMS L61492 and L61497).
  assert.equal(strictest("echo x > ~/**/auth.json"), "log.mutate");
  assert.equal(strictest("GLOBIGNORE=x; echo x > ~/**/auth.json"), "log.mutate");
  // Quoted, the word is a literal file name and never a pattern.
  assert.deepEqual(classesOf("echo x > '~/.hermes/?uth.json'"), andMain(["files.write.workspace"], "echo x > '~/.hermes/?uth.json'"));
  assert.deepEqual(classesOf('echo x > "APPROVAL.m?"'), andMain(["files.write.workspace"], 'echo x > "APPROVAL.m?"'));
});

test("a brace beside a glob is expanded first; a ${...} parameter is not a pattern", () => {
  assert.equal(strictest("echo x > ~/.hermes/{x,a*}.json"), "policy.core");
  // Parameter operators are not path segments or a glob: main's answers
  // (the `.git` reader's own, for a value it cannot see) are unchanged.
  assert.deepEqual(classesOf('echo x > "${f/.txt/.md}"'), andMain(["vcs.history.rewrite"], 'echo x > "${f/.txt/.md}"'));
  assert.deepEqual(classesOf("echo x > ${OUT#*.}/x.txt"), andMain(["vcs.history.rewrite"], "echo x > ${OUT#*.}/x.txt"));
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
  assert.deepEqual(classesOf("echo x > out/*.log"), andMain(["files.write.workspace"], "echo x > out/*.log"));
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
    // `-C .appr*` may be `.approval` itself, and its log goes with it (lead ruling L62013, S1).
    assert.equal(strictest(command), command.startsWith("tar") ? "log.mutate" : "policy.core", command);
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
  assert.deepEqual(withListing("cp ./*.md docs/", { "/w": ["README.md", "docs"], "/w/docs": [] }), andMain(["files.write.workspace"], "cp ./*.md docs/", { "/w": ["README.md", "docs"], "/w/docs": [] }));
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
  assert.deepEqual(classesOf("echo x > ${OUT:-out}/x.log"), andMain(["files.write.workspace"], "echo x > ${OUT:-out}/x.log"));
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
  assert.deepEqual(classesOf("echo x > out/{0-9}.log"), andMain(["files.write.workspace"], "echo x > out/{0-9}.log"));
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
  assert.deepEqual(classesOf("echo x > ~/.hermes/$1uth.json.bak"), andMain(["files.write.workspace"], "echo x > ~/.hermes/$1uth.json.bak"));
  assert.deepEqual(classesOf('echo x > "$9"'), andMain(["files.write.workspace"], 'echo x > "$9"'));
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

/**
 * The strictest class of the LAST command on the line (main's class rides
 * beside a raised one as another segment of the same text, lead ruling
 * L61926), with no-rule setters (`shopt`, `setopt`) let through.
 */
function lastClass(command: string): string {
  const result = classifyCommand(command, [], { noRuleSegments: true });
  if (!result.ok) return `refused:${result.code}`;
  const last = result.segments[result.segments.length - 1];
  assert.ok(last !== undefined, command);
  const same = result.segments.filter((segment) => segment.text === last.text).map((segment) => segment.class);
  return same.find((cls) => HUMAN_ONLY.has(cls)) ?? (same[0] as string);
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
  // Lead ruling L62013 (S1): `*` may be `.approval` itself, and a command on
  // that folder takes its log's class too: `log.mutate`.
  for (const command of ["rm -rf dist/*", "chmod +x scripts/*", "git add src/*", "npx prettier --write src/*", "git add *"]) {
    assert.equal(strictest(command), "log.mutate", command);
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
  assert.deepEqual(classesOf("rm -rf assets/*.png"), andMain(["files.delete.out_of_scope"], "rm -rf assets/*.png"));
  // `rm -rf assets/*` is NOT main's class, and not because of dots: `*` can be
  // `APPROVAL.md`, which protectedPathClass guards at any depth (`rm
  // assets/APPROVAL.md` is policy.core on main).
  // With `*` reaching `.approval` itself, its log goes with it (L62013, S1).
  assert.equal(strictest("rm -rf assets/*"), "log.mutate");
});

// ---------------------------------------------------------------------------
// Decided by what is THERE (lead ruling L61167): the hook lists the directory a
// pattern's first globbed component sits in and passes the names in.
// ---------------------------------------------------------------------------

/** The hook's canonical paths for `paths`, each its own (no symlink, letter case as written). */
function realpaths(...paths: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(paths.map((path) => [realpathKey(path), [path]]));
}

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
    // The raised class, with main's class beside it (lead ruling L61926: an
    // ordinary write too; it superseded review-b S1's exemption).
    const raised = ["policy.core", main];
    assert.deepEqual(withListing(command, { [dir]: ["APPROVAL.md"] }), raised, `${command} APPROVAL.md`);
    // Another spelling: guarded in the folded reading; main's class beside, as for any raise.
    assert.deepEqual(withListing(command, { [dir]: ["apprOVAL.MD"] }), raised, `${command} apprOVAL.MD`);
    // Unlisted, `*` may be `.approval` itself: a command on it takes the
    // class of its log too (lead ruling L62013, S1).
    const unlisted = [...raised, "log.mutate"];
    assert.deepEqual(withListing(command, { [dir]: "unreadable" }), unlisted, `${command} unreadable`);
    assert.deepEqual(withListing(command, {}), unlisted, `${command} not listed`);
  }
  // A dot-name counts on a line that may turn dot matching on.
  const classes = withListing("GLOBIGNORE=x; echo x > dist/*/env", { "/w/dist": [".approval"] });
  assert.ok(classes.includes("policy.core"), classes.join(","));
  // CLAUDE.md is policy.edit at any depth, as on main.
  assert.ok(withListing("rm -rf dist/*", { "/w/dist": ["CLAUDE.md"] }).includes("policy.edit"));
});

test("listings: home organs, absolute and relative prefixes, the first globbed level only", () => {
  assert.deepEqual(withListing("echo x > ~/.hermes/a*.json", { "/h/.hermes": ["auth.json"] }), andMain(["policy.core"], "echo x > ~/.hermes/a*.json", { "/h/.hermes": ["auth.json"] }));
  assert.deepEqual(withListing("echo x > ~/.hermes/a*.json", { "/h/.hermes": ["apps.json"] }), andMain(["files.write.workspace"], "echo x > ~/.hermes/a*.json", { "/h/.hermes": ["apps.json"] }));
  assert.deepEqual(withListing("echo x > /abs/out/*", { "/abs/out": ["a.log"] }), andMain(["files.write.workspace"], "echo x > /abs/out/*", { "/abs/out": ["a.log"] }));
  assert.deepEqual(withListing("echo x > /abs/out/*", { "/abs/out": ["APPROVAL.md"] }), andMain(["policy.core"], "echo x > /abs/out/*", { "/abs/out": ["APPROVAL.md"] }));
  // A deeper globbed level keeps the over-approximated reading.
  // (`src/lib/*` may be `src/lib/.approval` itself: its log's class too, L62013 S1.)
  assert.deepEqual(withListing("echo x > src/*/*", { "/w/src": ["lib"] }), ["policy.core", "files.write.workspace", "log.mutate"]);
  assert.deepEqual(withListing("echo x > src/*/*.ts", { "/w/src": ["lib"] }), andMain(["files.write.workspace"], "echo x > src/*/*.ts", { "/w/src": ["lib"] }));
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
  assert.ok(withListing("cd x && rm -rf dist/*", { "/w/dist": [] }).includes("policy.core"));
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
  assert.deepEqual(classesOf("echo x > ~/.hermes/a*.json"), andMain(["policy.core"], "echo x > ~/.hermes/a*.json"));
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
    ["echo x >! ~/.hermes/a?th.json", "policy.core"],
  ] as const) {
    assert.ok(classesOf(command).includes(cls), `${command} -> ${classesOf(command).join(",")}`);
  }
  // A form main refuses stays refused (lead ruling L61926: a reading may make
  // a line stricter, never lift a refusal; this reverses L61167 for them).
  for (const command of ["echo x >>| APPROVAL.md", "echo x &>! APPROVAL.md"]) {
    assert.equal(classifyCommand(command).ok, false, command);
    assert.equal(classifyCommandWithMainRules(command).ok, false, command);
  }
  assert.ok(classesOf("echo x >! .git/config").includes("vcs.history.rewrite"));
  assert.deepEqual(classesOf("echo x >! out.log"), andMain(["files.write.workspace"], "echo x >! out.log"));
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

test("lead ruling L61926: the main pass is main 324d87dc's answer, and it rides beside each raise", () => {
  // Spelled out, not computed: a rule left on in the main pass would change
  // both sides of an andMain pin together.
  const pairs: readonly (readonly [string, readonly string[], readonly string[]])[] = [
    // bareOrganDirectory
    ["rm -rf .claude", ["files.write.workspace"], ["policy.core", "files.write.workspace"]],
    ["mv .github gone", ["files.write.workspace"], ["policy.edit", "files.write.workspace"]],
    ["chmod -R 000 .cursor", ["files.write.workspace"], ["policy.core", "files.write.workspace"]],
    // a read command's own output (`sort -o`): main judged it by nothing
    ["sort -o APPROVAL.md x", ["read.shell"], ["policy.core", "read.shell"]],
  ];
  for (const [command, main, head] of pairs) {
    const mainPass = classifyCommandWithMainRules(command);
    assert.ok(mainPass.ok, command);
    assert.deepEqual(mainPass.classes, main, command);
    assert.deepEqual(classesOf(command), head, command);
  }
  // Where a copy lands (copyLandings), by the listing.
  const listed = { "/w": ["APPROVAL.md", "a.md"], "/w/docs": [] };
  assert.deepEqual(withListing("cp ./*.md docs/", listed), ["policy.core", "files.write.workspace"]);
  assert.deepEqual(withListing("cp -t docs/ AP*.md", listed), ["policy.core", "files.write.workspace"]);
  assert.deepEqual(withListing("cp ./*.md docs/", { "/w": ["a.md"], "/w/docs": [] }), ["files.write.workspace"]);
  // A zsh clobber form main does not read is refused in the main pass.
  assert.equal(classifyCommandWithMainRules("echo x >>| ~/.hermes/auth.json").ok, false);
});

test("review-b S2: an option-dependent zsh form is literal text on a plain line", () => {
  assert.deepEqual(classesOf("rm -f *~"), andMain(["files.delete.out_of_scope"], "rm -f *~"));
  assert.deepEqual(classesOf("rm -f out/#x"), andMain(["files.write.workspace"], "rm -f out/#x"));
  assert.deepEqual(classesOf("echo x > out/^x"), andMain(["files.write.workspace"], "echo x > out/^x"));
  // With options possibly set on the line, they are patterns again.
  assert.equal(lastClass("setopt extendedglob; echo x > APPROVAL.m*~x"), "policy.core");
});

test("review of b402adec (H1): zsh's >&! >&| >>&! >>&| and &>! write the next word", () => {
  for (const command of ["echo x >&! APPROVAL.md", "echo x &>| APPROVAL.md", "echo x &>>! .approval/env"]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // Main refuses these; they stay refused (lead ruling L61926).
  for (const command of ["echo x >&| APPROVAL.md", "echo x >>&! .approval/env", "echo x >>&| .approval/env", "echo x &>! APPROVAL.md"]) {
    assert.equal(classifyCommand(command).ok, false, command);
    assert.equal(classifyCommandWithMainRules(command).ok, false, command);
  }
  assert.ok(classesOf("echo x >&! .git/config").includes("vcs.history.rewrite"));
  assert.deepEqual(classesOf("echo x >&2"), andMain(["read.shell"], "echo x >&2"));
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
  // Creating an archive from an organ directory names the directory itself:
  // only mkdir and touch are released (lead ruling L62013; an option from the
  // environment can make tar remove what it reads, security review of
  // 8fe15089). `.approval` is guarded bare on main, any verb.
  assert.ok(classesOf("tar -czf out.tgz -C .claude .").includes("policy.core"));
  assert.ok(classesOf("tar -czf out.tgz -C .approval .").includes("policy.core"));
  assert.ok(ORDINARY(classesOf("tar -czf out.tgz -C src .")));
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
  assert.deepEqual(withListing("rm -rf d/*", { "/w/d": "missing" }), andMain(["files.delete.out_of_scope"], "rm -rf d/*", { "/w/d": "missing" }));
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
  assert.deepEqual(classesOf("rsync -a x/./y/notes.txt out/"), andMain(["network.call"], "rsync -a x/./y/notes.txt out/"));
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
  assert.deepEqual(classesOf("cp -r evil/. 'a*/.cl*/'"), andMain(["files.write.workspace"], "cp -r evil/. 'a*/.cl*/'"));
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
  assert.deepEqual(withListing("echo x > ~/*/auth.json", { "/h": [".hermes", "notes"] }), andMain(["policy.core"], "echo x > ~/*/auth.json", { "/h": [".hermes", "notes"] }));
  assert.deepEqual(withListing("echo x > ~/*/auth.json", { "/h": [".cache", "notes"] }), andMain(["files.write.workspace"], "echo x > ~/*/auth.json", { "/h": [".cache", "notes"] }));
  assert.deepEqual(withListing("echo x > */env", { "/w": [".approval"] }).filter((cls) => HUMAN_ONLY.has(cls)).length > 0, true);
  assert.deepEqual(withListing("echo x > */env", { "/w": ["src", ".github"] }), andMain(["files.write.workspace"], "echo x > */env", { "/w": ["src", ".github"] }));
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
  assert.deepEqual(withListing("rm -rf dist/*", { "/w/dist": ["a.js", ".cache"] }), andMain(["files.delete.out_of_scope"], "rm -rf dist/*", { "/w/dist": ["a.js", ".cache"] }));
  assert.ok(withListing("chmod 644 dist/*", { "/w/dist": [".GIT"] }).includes("vcs.history.rewrite"));
  // A segment that cannot match `.git` (`*.ts`), or a pattern in no leading
  // place, is not read for it.
  assert.deepEqual(withListing("chmod 644 *.ts", { "/w": [".git", "a.ts"] }), andMain(["files.write.workspace"], "chmod 644 *.ts", { "/w": [".git", "a.ts"] }));
  // A copy into a destination a pattern may spell as an organ directory: `*` can be `.claude`.
  assert.ok(classesOf("rsync -a pkg/ */").includes("policy.core"));
  assert.deepEqual(classesOf("rsync -a pkg/ o*/"), andMain(["network.call"], "rsync -a pkg/ o*/"));
  // `.grok` and `.muse` are organ directories only (no guarded file under them is named).
  assert.deepEqual(classesOf("rsync -a pkg/ ?grok/"), andMain(["policy.core", "network.call"], "rsync -a pkg/ ?grok/"));
  assert.deepEqual(classesOf("tar -xf a.tar -C *use"), andMain(["policy.core"], "tar -xf a.tar -C *use"));
  // A pattern reading never takes a class away (review-b S1): the plain
  // class rides beside the one a destination pattern raised; the plain pass
  // reads destinations as before the ruling, so `.cl*/` carries nothing new.
  // `.git/*` may be `.git/.approval`, a folder a move replaces: its log's class too (L62013, S1).
  assert.deepEqual(classesOf("mv a .git/*"), ["policy.core", "vcs.history.rewrite", "log.mutate"]);
  assert.deepEqual(classesOf("rsync -a evil/ .cl*/"), andMain(["policy.core"], "rsync -a evil/ .cl*/"));
});

/**
 * The parents rule's class answers first, and at most the segment's own class
 * (the one it takes without the rule) rides beside: the rule never takes a
 * class away (lead ruling L61587; review-b A686-FOLD5 M1's bar).
 */
function leads(classes: readonly string[], cls: string): void {
  assert.equal(classes[0], cls, classes.join(","));
  assert.ok(classes.length <= 2, classes.join(","));
}

test("lead ruling L61587 (review-b A686-FOLD3 M1): a delete, move or chmod of an organ directory ITSELF takes its strictest class, as bare .approval, .codex and .hermes do", () => {
  const ORGANS: readonly (readonly [string, string])[] = [
    [".claude", "policy.core"],
    [".cursor", "policy.core"],
    [".grok", "policy.core"],
    [".muse", "policy.core"],
    [".github", "policy.edit"],
  ];
  for (const [dir, cls] of ORGANS) {
    for (const command of [
      `rm -rf ${dir}`,
      `rm -r ${dir}`,
      `rm -R ${dir}/`,
      `rm -rf ./${dir}`,
      `rm -rf ${dir}/.`,
      `rm -d ${dir}`,
      `rmdir ${dir}`,
      `mv ${dir} gone`,
      `mv ${dir}/ /tmp/`,
      `chmod -R 000 ${dir}`,
      `chmod 000 ${dir}`,
      `find ${dir} -delete`,
      `git rm -r ${dir}`,
      `rm -rf ${dir.slice(0, 3)}*`,
      `rm -rf ${dir.slice(0, 2)}?${dir.slice(3)}`,
    ]) {
      assert.ok(classesOf(command).includes(cls), `${command} -> ${classesOf(command).join(",")}`);
    }
    // `..` after a name: `x` may be a symlink, so the text cannot place it
    // (parents rule, security review 7): policy.core, at least as strict.
    assert.ok(classesOf(`rm -rf ${dir}/x/..`).includes("policy.core"), `${dir}/x/..`);
  }
  // A dot-name `*` reaches by the hook's listing (L61492): where the directory holds one.
  assert.ok(withListing("rm -rf *", { "/w": [".claude", "a.js"] }).includes("policy.core"));
  assert.ok(withListing("chmod -R 777 sub/*", { "/w/sub": [".cursor"] }).includes("policy.core"));
  assert.deepEqual(withListing("rm -rf *", { "/w": [".cache", "dist", "a.js"] }), andMain(["files.delete.out_of_scope"], "rm -rf *", { "/w": [".cache", "dist", "a.js"] }));
  // Not strict: an ordinary directory, a directory INSIDE an organ that guards no file, a near name.
  for (const [command, main] of [
    ["rm -rf dist", "files.write.workspace"],
    ["rm -rf node_modules", "files.write.workspace"],
    ["rm -rf build/", "files.write.workspace"],
    ["rm -rf .cache", "files.write.workspace"],
    ["rm -rf .claude/commands", "files.write.workspace"],
    ["mkdir -p .claude/commands", "files.write.workspace"],
    ["rm -rf .claude.bak", "files.write.workspace"],
    ["rm -rf my.claude", "files.write.workspace"],
  ] as const) {
    assert.deepEqual(classesOf(command), [main], command);
  }
  // A parent of an organ directory is the parent rule's (below): with no listing, strict.
  leads(classesOf("rm -rf ."), "policy.core");
});

test("lead ruling L61587, parents: a recursive delete, move or chmod of a directory that holds an organ directory takes its class", () => {
  // Without the caller's listing the working directory, the home, their
  // ancestors and `/` may hold one: strict (main: files.delete.out_of_scope or
  // an ordinary write).
  for (const command of [
    "rm -rf .",
    "rm -rf ./",
    "rm -r ./",
    'rm -rf "$PWD"',
    "rm -rf ${PWD}/",
    "rm -rf $(pwd)",
    "rm -rf sub/..",
    "rm -rf .claude/..",
    "rm -rf ..",
    "rm -rf ../..",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf /",
    "chmod -R u+w .",
    "chmod -R 000 ~",
    "chmod -R --reference=x .",
    'mv "$PWD" ../x',
    // Security review: a chmod of a parent without -R locks its organ
    // directories too; a sibling through `..` is listed before it is passed;
    // a substitution may print the working directory.
    "chmod 000 .",
    "rm -rf ../other-project",
    "rm -rf $(echo x)",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // With a listing, by what the directory holds: the strictest guarded name.
  leads(withListing("rm -rf .", { "/w": [".claude", "src"] }), "policy.core");
  leads(withListing("rm -rf .", { "/w": [".github", "src"] }), "policy.edit");
  leads(withListing("rm -rf .", { "/w": ["APPROVAL.md", "src"] }), "policy.core");
  leads(withListing("chmod -R u+w .", { "/w": [".git", "src"] }), "vcs.history.rewrite");
  leads(withListing("rm -rf ~", { "/h": [".claude"] }), "policy.core");
  // An ancestor: the directories from it down to the working directory.
  leads(withListing("rm -rf ..", { "/": ["w", "x"], "/w": [".cursor"] }), "policy.core");
  leads(withListing("rm -rf ..", { "/": ["w", ".grok"], "/w": ["src"] }), "policy.core");
  // None held: the segment's own class, unchanged from main.
  assert.deepEqual(withListing("rm -rf .", { "/w": ["src", "dist", ".cache"] }), ["files.delete.out_of_scope"]);
  assert.deepEqual(withListing("chmod -R u+w .", { "/w": ["src", ".cache"] }), ["files.write.workspace"]);
  // (`/` holds the home too, so its listing is read as well.)
  assert.deepEqual(withListing("rm -rf ..", { "/": ["w", "h"], "/w": ["src"], "/h": ["notes.txt"] }), ["files.delete.out_of_scope"]);
  assert.deepEqual(withListing("rm -rf ~/", { "/h": ["notes.txt"] }), ["files.delete.out_of_scope"]);
  // Not listed (over the cap, unreadable, not asked for): strict.
  leads(withListing("rm -rf .", { "/w": "unreadable" }), "policy.core");
  leads(withListing("rm -rf ..", { "/w": ["src"] }), "policy.core");
  // Not a parent, or not one the text can tell: the segment's own class.
  for (const [command, main] of [
    ["rm -rf ./dist", "files.write.workspace"],
    ["rm -rf dist", "files.write.workspace"],
    ['rm -rf "$TMPDIR"/x', "files.delete.out_of_scope"],
    ["rm -rf /tmp/x", "files.delete.out_of_scope"],
    ["rm .", "files.write.workspace"],
    ["rmdir .", "files.write.workspace"],
    ["touch .", "files.write.workspace"],
    // rename(2) refuses `.` and `..` as a source: nothing moves.
    ["mv . x", "files.write.workspace"],
  ] as const) {
    assert.deepEqual(classesOf(command), [main], command);
  }
  assert.deepEqual(withListing("rm -rf ../other-project", { "/other-project": ["x.js"], ...realpaths("/other-project", "/w", "/h") }), ["files.delete.out_of_scope"]);
});

test("security review of the parents rule (L61587), 1: a chmod mode that starts with '-', and chmod without -R", () => {
  // A mode that starts with `-` is the mode, not an option; a chmod of a
  //    parent without -R counts too (`chmod 000 .` locks every organ below).
  for (const command of ["chmod -R -w .", "chmod -R -rwx ..", "chmod -R -w ~", "chmod -w .", "chmod 000 .", "chmod -R -- -w .", "chmod -fR a-w ."]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  assert.deepEqual(withListing("chmod -R -w .", { "/w": ["src", ".cache"] }), ["files.write.workspace"]);
  leads(withListing("chmod 000 .", { "/w": [".claude"] }), "policy.core");
});

test("security review of the parents rule (L61587), 2: `..` after a name", () => {
  // `..` after a name: a path that comes back to (or above) the working
  //    directory or the home, or a sibling reached through `..`, is read by
  //    the listing; with none, fail closed.
  for (const command of ["rm -rf sub/../..", "rm -rf ~/x/../..", "rm -rf ./a/../../", "rm -rf ../w", "rm -rf ../other-project"]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  leads(withListing("rm -rf ../w", { "/": ["w", "h"], "/w": [".claude"], "/h": [] }), "policy.core");
  leads(withListing("rm -rf ../other-project", { "/other-project": [".claude"], ...realpaths("/other-project", "/w", "/h") }), "policy.core");
  assert.deepEqual(withListing("rm -rf ../other-project", { "/other-project": ["x.js"], ...realpaths("/other-project", "/w", "/h") }), ["files.delete.out_of_scope"]);
  // A sibling that is not there holds nothing on a one-segment line; where an
  // earlier segment may make it, or it cannot be read: strict.
  assert.deepEqual(withListing("rm -rf ../other-project", { "/other-project": "missing", ...realpaths("/other-project", "/w", "/h") }), ["files.delete.out_of_scope"]);
  assert.ok(withListing("true && rm -rf ../other-project", { "/other-project": "missing", ...realpaths("/other-project", "/w", "/h") }).includes("policy.core"));
  leads(withListing("rm -rf ../other-project", { "/other-project": "unreadable", ...realpaths("/other-project", "/w", "/h") }), "policy.core");
  // No canonical path for it (every caller but the hook): it cannot be shown to be elsewhere.
  leads(withListing("rm -rf ../other-project", { "/other-project": ["x.js"] }), "policy.core");
  assert.deepEqual(withListing("rm -rf ~/../other", { "/other": ["notes"], ...realpaths("/other", "/w", "/h") }), ["files.delete.out_of_scope"]);
});

test("security review of the parents rule (L61587), 3: a listed name in another letter case", () => {
  // A listed name in another letter case is the same directory on a
  // case-insensitive volume (the folded reading); as spelled it is another
  // name, so the segment's own class rides beside (review-b A686-FOLD5 M1).
  assert.deepEqual(withListing("rm -rf .", { "/w": [".Claude", "src"] }), ["policy.core", "files.delete.out_of_scope"]);
  assert.deepEqual(withListing("rm -rf .", { "/w": ["Approval.MD", "src"] }), ["policy.core", "files.delete.out_of_scope"]);
  assert.ok(withListing("rm -rf .", { "/w": [".GIT", "src"] }).includes("vcs.history.rewrite"));
  // By the shared fold (#688): the long s and the Kelvin sign open the ASCII names on APFS.
  assert.ok(withListing("rm -rf .", { "/w": [".mu\u017Fe", "src"] }).includes("policy.core"));
  assert.ok(withListing("rm -rf .", { "/w": [".gro\u212A", "src"] }).includes("policy.core"));
});

test("security review of the parents rule (L61587), 4: an operand the text cannot read", () => {
  // An operand the text cannot read may be the working directory: fail closed.
  for (const command of ["rm -rf $X", 'rm -rf "$X"', "rm -rf ${X}/", "rm -rf $OLDPWD", "rm -rf $(pwd -P)", "rm -rf ${PWD}", 'rm -rf "$PWD/"', "chmod -R 000 $X", 'mv "$X" ../y']) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // `builtin pwd` and `command pwd` are refused by main (no rule for the
  // wrapper); a refusal is stricter than any class and stays one.
  for (const command of ["rm -rf $(builtin pwd)", "rm -rf $(command pwd)", "rm -rf $(command pwd -P)"]) {
    const result = classifyCommand(command);
    assert.ok(!result.ok || classesOf(command).includes("policy.core"), command);
  }
  leads(withListing("rm -rf $(pwd -P)", {}), "policy.core");
  // A variable with a named tail is not the directory itself: main's class.
  assert.deepEqual(classesOf('rm -rf "$TMPDIR"/x'), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf("rm -rf $BUILD/dist"), ["files.delete.out_of_scope"]);
  // Main refuses a substitution it cannot classify; that stays a refusal.
  assert.equal(classifyCommand("rm -rf $(cmd)").ok, false);
});

test("security review of the parents rule (L61587), 5: a tail after an unreadable word that comes back to it", () => {
  // The tail is normalised before it is judged: a name that a later `..`
  // removes is no name, and a `..` that removes the unreadable word itself
  // (or a word that may hold `..`, like `$X` in `./$X`) leaves the target
  // unknown: fail closed.
  for (const command of [
    "rm -rf $X/sub/..",
    "chmod -R 000 $(echo x)/a/../..",
    "rm -rf $(echo x)/a/..",
    "rm -rf $HOME/x/..",
    'rm -rf "$X"/..',
    "rm -rf $X/*",
    "chmod -R 000 ./$X",
    "chmod -R 000 sub/$X",
    'rm -rf "$X/$Y"',
    "chmod -R 000 $X/$Y",
    "rm -rf ~someone",
    "chmod -R 000 ~someone/",
  ]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // A named tail is not the unreadable directory itself: main's class.
  assert.deepEqual(classesOf("rm -rf $X/dist"), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf("rm -rf $(echo x)/build/out"), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf('rm -rf "$TMPDIR"/x'), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf("rm -rf $TARGET/x"), ["files.delete.out_of_scope"]);
  // A glob that names what a directory holds stays #686's listing rule.
  assert.deepEqual(withListing("rm -rf dist/*", { "/w/dist": ["a.js"] }), ["files.delete.out_of_scope"]);
  // Main refuses a substitution it cannot classify; that stays a refusal.
  assert.equal(classifyCommand("rm -rf $(cmd)/build/out").ok, false);
  assert.equal(classifyCommand("rm -rf $(cmd)/a/../..").ok, false);
});

// An absolute operand, judged against the caller's disk: listings and, keyed
// `realpath:<path>`, the canonical path the hook resolved for each one.
function withDisk(
  command: string,
  cwd: string,
  listings: Record<string, readonly string[] | "unreadable" | "missing">,
  extra: { singleSegment?: boolean } = {},
): string[] {
  const result = classifyCommand(command, [], { globDisk: { cwd, home: "/h", listings: new Map(Object.entries(listings)), ...extra } });
  assert.ok(result.ok, `${command}: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

test("security review of the parents rule (L61587), 6: an absolute operand that reaches the working directory by another spelling", () => {
  const real = (paths: readonly string[], to: (path: string) => string = (path) => path): Record<string, string[]> =>
    Object.fromEntries(paths.map((path) => [realpathKey(path), [to(path)]]));
  // Another letter case (a case-insensitive volume): strict.
  leads(withDisk("rm -rf /W", "/w/proj", { "/W": ["proj"] }), "policy.core");
  leads(withDisk("chmod -R 000 /W/Proj", "/w/proj", { "/W/Proj": [".claude"] }), "policy.core");
  // Even where the volume's realpath keeps the letter case as written.
  // (As spelled, on such a volume `/W` is another directory, judged by its own listing: main's class beside.)
  assert.deepEqual(withDisk("rm -rf /W", "/w/proj", { "/W": ["proj"], ...real(["/W", "/w/proj", "/h"]) }), ["policy.core", "files.delete.out_of_scope"]);
  // A symlink to an ancestor (/tmp is /private/tmp on macOS): strict.
  const alias = { "/tmp/x": ["proj"], ...real(["/tmp/x"], () => "/private/tmp/x"), ...real(["/private/tmp/x/proj", "/h"]) };
  leads(withDisk("rm -rf /tmp/x/", "/private/tmp/x/proj", alias), "policy.core");
  leads(
    withDisk("chmod -R 000 /tmp/x/proj", "/private/tmp/x/proj", { "/tmp/x/proj": ["src"], ...real(["/tmp/x/proj"], () => "/private/tmp/x/proj"), ...real(["/private/tmp/x/proj", "/h"]) }),
    "policy.core",
  );
  // No canonical path for it: it cannot be shown to be elsewhere: strict.
  leads(withDisk("rm -rf /tmp/build-xyz", "/w", { "/tmp/build-xyz": ["a.o"] }), "policy.core");
  // Provably elsewhere: judged by its own listing.
  const elsewhere = real(["/tmp/build-xyz", "/w", "/h"], (path) => (path.startsWith("/tmp") ? `/private${path}` : path));
  assert.deepEqual(withDisk("rm -rf /tmp/build-xyz", "/w", { "/tmp/build-xyz": ["a.o"], ...elsewhere }), ["files.delete.out_of_scope"]);
  leads(withDisk("rm -rf /tmp/build-xyz", "/w", { "/tmp/build-xyz": [".claude"], ...elsewhere }), "policy.core");
  assert.deepEqual(withDisk("rm -rf /tmp/build-xyz", "/w", { "/tmp/build-xyz": "missing", ...elsewhere }, { singleSegment: true }), [
    "files.delete.out_of_scope",
  ]);
  // Without a disk (every caller but the hook) an absolute path is not judged here, as before.
  assert.deepEqual(classesOf("rm -rf /tmp/x"), ["files.delete.out_of_scope"]);
});

test("security review of the parents rule (L61587), 7: `..` after a name the kernel may resolve through a symlink", () => {
  // `link/..` is the directory above link's TARGET, not the working
  // directory: the kernel follows the symlink before it applies `..`. The
  // hook resolves the operand as written; without that, fail closed.
  const written = (path: string, physical: string): Record<string, string[]> => ({ [realpathKey(path)]: [physical] });
  const sides = { ...written("/w", "/w"), ...written("/h", "/h") };
  // Without the hook's resolution of the operand as written: strict.
  for (const command of ["chmod -R 000 link/..", "rm -rf link/../x", "chmod -R 000 a/b/../..", "rm -rf /tmp/a/../b"]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  leads(withDisk("chmod -R 000 link/..", "/w", { "/w": ["src", "link"], ...sides }), "policy.core");
  // Resolved: link/.. is /elsewhere, which holds an organ directory: its class.
  leads(
    withDisk("chmod -R 000 link/..", "/w", { "/w": ["src", "link"], "/w/link/..": [".claude", "deep"], ...written("/w/link/..", "/elsewhere"), ...sides }),
    "policy.core",
  );
  // Resolved to a place that holds none: main's class.
  assert.deepEqual(
    withDisk("chmod -R 000 link/..", "/w", { "/w": ["src", "link"], "/w/link/..": ["deep", "notes"], ...written("/w/link/..", "/elsewhere"), ...sides }),
    ["files.write.workspace"],
  );
  // Resolved to the working directory itself (`sub` a real directory): the chain, as before.
  assert.deepEqual(withDisk("chmod -R 000 sub/..", "/w", { "/w": ["src", "sub"], ...written("/w/sub/..", "/w"), ...written("/w", "/w"), ...sides }), [
    "files.write.workspace",
  ]);
  leads(withDisk("chmod -R 000 sub/..", "/w", { "/w": [".claude", "sub"], ...written("/w/sub/..", "/w"), ...sides }), "policy.core");
  // Resolved through a symlink to an ancestor of the working directory by another road: strict.
  leads(withDisk("chmod -R 000 link/..", "/p/w", { "/p/w": ["src"], ...written("/p/w/link/..", "/p"), ...written("/p/w", "/p/w"), ...written("/h", "/h") }), "policy.core");
});

test("one fold (#688's shared helper, lead ruling 04:11Z): listing names, organ directories and pattern characters fold as APFS does", () => {
  // A listed name in another spelling APFS opens as the guarded one.
  for (const name of ["Approval.MD", "APPROVAL.md", ".Claude", ".CURSOR", "approval.md".toUpperCase()]) {
    assert.ok(withListing("rm -rf *", { "/w": [name, "a.js"] }).includes("policy.core"), name);
  }
  assert.ok(withListing("rm -rf .*", { "/w": [".claude".replace("c", "C")] }).includes("policy.core"));
  // Organ directories by the shared fold: case, long s, Kelvin sign.
  for (const command of ["rm -rf .Claude", "chmod -R 000 .CLAUDE", "mv .Cursor gone", "rm -rf .muſe", "rm -rf .grоK".replace("о", "o")]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // A pattern character whose fold is not one character (the ligature fl is
  // `fl`): read as any run, strict, never a miss.
  assert.ok(classesOf("echo x > .github/workﬂow*/ci.yml").includes("policy.edit"));
});

test("review-b A686-FOLD5 M1: the as-spelled reading compares exactly, so a case variant keeps the class main gives that spelling", () => {
  // Folded: the guarded name (#686's class). As spelled: another name (main's class). Both ride.
  for (const [command, both] of [
    ["cp a.js .gItHuB/WoRkFlOwS/Ci.yMl", ["policy.edit", "files.write.workspace"]],
    ["mv .gItHuB gone", ["policy.edit", "files.write.workspace"]],
    ["mv x .CLAUDE", ["policy.core", "files.write.workspace"]],
    ["tar -xf e.tar -C .Claude", ["policy.core", "files.write.workspace"]],
    ["ln -sfn x .Claude", ["policy.core", "files.write.workspace"]],
    ["rsync -a x/ .Claude/", ["policy.core", "network.call"]],
    ["mv x .muſe", ["policy.core", "files.write.workspace"]],
  ] as const) {
    const classes = classesOf(command);
    for (const cls of both) assert.ok(classes.includes(cls), `${command} -> ${classes.join(",")}`);
  }
  // The listing and the glob matcher: exact as spelled, as bash matches without nocaseglob.
  for (const [command, listing, both] of [
    ["rm -rf .CL*", { "/w": [".claude"] }, ["policy.core", "files.delete.out_of_scope"]],
    ["rm -rf .mus*", { "/w": [".muſe"] }, ["policy.core", "files.delete.out_of_scope"]],
    ["rm -rf *", { "/w": [".GIT", "a"] }, ["vcs.history.rewrite", "files.delete.out_of_scope"]],
  ] as const) {
    const classes = withListing(command, listing);
    for (const cls of both) assert.ok(classes.includes(cls), `${command} ${JSON.stringify(listing)} -> ${classes.join(",")}`);
  }
});

test("lead ruling L61587, parents: the rule adds its class and never takes the segment's own class away", () => {
  // The main pass (lead ruling L61926) runs without the parents rule: main
  // 324d87dc's answer, spelled out.
  for (const [command, main] of [
    ["rm -rf .", "files.delete.out_of_scope"],
    ["chmod -R 000 .", "files.write.workspace"],
  ] as const) {
    const mainPass = classifyCommandWithMainRules(command);
    assert.ok(mainPass.ok, command);
    assert.deepEqual(mainPass.classes, [main], command);
  }
  // Main's class rides beside the parent's (ordinary writes too), so a policy
  // that holds files.write.workspace stricter than policy.edit keeps main's answer.
  assert.deepEqual(withListing("chmod -R 000 .", { "/w": [".github", "src"] }), ["policy.edit", "files.write.workspace"]);
  assert.deepEqual(withListing("rm -rf .", { "/w": [".claude", "src"] }), ["policy.core", "files.delete.out_of_scope"]);
  assert.deepEqual(withListing("chmod -R u+w .", { "/w": [".git", "src"] }), ["vcs.history.rewrite", "files.write.workspace"]);
  // Where main's class is the parent's own, one class: `mv "$PWD" ../x` is policy.core on main too.
  assert.deepEqual(classesOf('mv "$PWD" ../x'), ["policy.core"]);
});

test("lead ruling L62013 (S1): an organ folder itself takes the class of every guarded path inside it, routed ones included", () => {
  const routed = [{ path: ".github/workflows/", class: "policy.edit.ci" }] as const;
  const classes = (command: string): string[] => {
    const result = classifyCommand(command, [...routed]);
    assert.ok(result.ok, command);
    return result.classes;
  };
  for (const command of ["rm -rf .github", "rm -rf ./.github/", "rmdir .github", "mv .github gone", "chmod -R 000 .github", "find .github -delete", "git rm -r .github"]) {
    const got = classes(command);
    assert.ok(got.includes("policy.edit") && got.includes("policy.edit.ci"), `${command} -> ${got.join(",")}`);
  }
  // A route on a path inside another organ folder is reached the same way.
  const cursorRouted = classifyCommand("rm -rf .cursor", [{ path: ".cursor/rules/", class: "policy.edit.rules" }]);
  assert.ok(cursorRouted.ok && cursorRouted.classes.includes("policy.core") && cursorRouted.classes.includes("policy.edit.rules"));
  // Built-in contents: the approval home's log, the Hermes home's scheduled scripts.
  assert.deepEqual(classesOf("rm -rf .approval"), ["policy.core", "log.mutate"]);
  assert.ok(classesOf("rm -rf ~/.hermes").includes("cron.manage"));
  // A path under the folder, not the folder itself: its own class only.
  assert.deepEqual(classes("rm -rf .github/workflows/ci.yml"), ["policy.edit.ci"]);
  // Creating the folder is not a command on its contents (S2): main's class.
  assert.deepEqual(classes("mkdir .github"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("mkdir .approval"), ["policy.core"]);
});

test("lead ruling L62013 (S2), fail closed: every command naming the bare organ folder keeps its class but a short release list", () => {
  // Held (the folder's class, or refused as on main): anything that may
  // remove, replace, move or change access to the entry, and any tool or
  // option this classifier does not know. Security review of e9956c84: a list
  // of destructive verbs failed open.
  const held = (command: string): boolean => {
    const result = classifyCommand(command);
    return !result.ok || result.classes.includes("policy.core");
  };
  for (const command of [
    "rm -rf .claude",
    "rm -d .claude",
    "rmdir .claude",
    "mv .claude x",
    "mv x .claude",
    "chmod -R 000 .claude",
    "chmod 000 .claude",
    "ln -sf x .claude",
    "ln -s x .claude",
    "find .claude -delete",
    "git rm -r .claude",
    "git mv .claude x",
    // Finding 3: plain rm and unlink of the bare name (a symlink, or a glob).
    "rm .claude",
    "rm -f .claude",
    "rm -f .cl*",
    "unlink .claude",
    // Finding 2: any unique prefix getopt_long accepts.
    "rm --r .claude",
    "rm --re .claude",
    "rm --di .claude",
    // Finding 1: tools that delete or move their SOURCE, and unknown ones.
    "tar --remove-files -cf x.tar .claude",
    "tar --remove-f -cf x.tar .claude",
    "tar -czf out.tgz --remove-files -C .claude .",
    "rsync -a --remove-source-files .claude/ x/",
    "zip -m x.zip .claude",
    "zip -rm x.zip .claude",
    "gmv .claude x",
    "trash .claude",
    "shred -u .claude",
    "srm .claude",
    "git clean -fdx .claude",
    "find .claude -exec rm -rf {} +",
    "chown -R x .claude",
    "chgrp x .claude",
    "install -d .claude",
    // Other writes naming the bare folder.
    "tee .claude",
    "echo x > .claude",
    "truncate -s 0 .claude",
    // Not on the release list: a mode at creation, an abbreviated or unknown option.
    "mkdir -m 000 .claude",
    "mkdir --mode=000 .claude",
    "mkdir --par .claude",
    "mkdir -Z .claude",
    "touch --no-c .claude",
    "tar -cf x.tar --unknown -C .claude .",
    // Security review of 8fe15089: reads are not released (only mkdir and
    // touch are), an option from the environment, the plain form only.
    "tar -czf out.tgz -C .claude .",
    "tar czf out.tgz -C .claude .",
    "TAR_OPTIONS=--remove-files tar -czf x.tgz .claude",
    "export TAR_OPTIONS=--remove-files; tar -czf x.tgz .claude",
    "tar -cf .claude x",
    "PATH=/tmp mkdir .claude",
    "TZ=UTC touch .claude",
    "./mkdir .claude",
    "/tmp/mkdir .claude",
    "/bin/mkdir .claude",
    "command mkdir .claude",
    "nice touch .claude",
    'mkdir(){ rm -rf "$@"; }; mkdir .claude',
    "alias mkdir='rm -rf'; mkdir .claude",
    "hash -p /bin/rm mkdir; mkdir .claude",
    "export PATH=/tmp; mkdir .claude",
    "mkdir $X .claude",
    "mkdir -p $(echo -m 000) .claude",
    "touch .cl*",
    "mkdir -p {.claude,x}",
    "touch ~/.claude/../.claude",
    "touch .claude -r",
  ]) {
    assert.ok(held(command), `${command} -> ${JSON.stringify(classifyCommand(command))}`);
  }
  // Released to main's class: creating the folder, touching it (the plain form).
  for (const [command, main] of [
    ["mkdir .claude", "files.write.workspace"],
    ["mkdir -p .claude", "files.write.workspace"],
    ["mkdir -pv .cursor/", "files.write.workspace"],
    ["mkdir --parents --verbose .github", "files.write.workspace"],
    ["touch .claude", "files.write.workspace"],
    ["touch -c .claude", "files.write.workspace"],
    ["touch -t 202601010000 .claude", "files.write.workspace"],
    ["touch --no-create .claude", "files.write.workspace"],
    ["touch -r ref .claude", "files.write.workspace"],
    ["touch -d 2026-01-01 -a .claude", "files.write.workspace"],
    ["\\mkdir .claude", "files.write.workspace"],
  ] as const) {
    assert.deepEqual(classesOf(command), [main], command);
    const mainPass = classifyCommandWithMainRules(command);
    assert.ok(mainPass.ok, command);
    assert.deepEqual(mainPass.classes, [main], command);
  }
  // A read of the folder as a copy's source: main's class, except that what
  // lands is judged by #686's destination rule (`backup/.claude/settings.json`
  // is policy.core on main when spelled).
  assert.ok(classesOf("cp -r .claude backup/").includes("policy.core"));
  // Kept by the destination rule: a write INTO the folder.
  for (const command of ["cp -r evil/ .claude", "rsync -a x/ .claude/", "cp -r evil/.claude .", "tar -xf a.tar -C .claude"]) {
    assert.ok(classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
});

test("lead ruling L62013 for the parents rule: a parent takes the classes of the folders it holds (S1), and the commands that delete what they read count (S2, fail closed)", () => {
  const disk = (listings: Record<string, readonly string[]>) => ({ globDisk: { cwd: "/w", home: "/h", listings: new Map(Object.entries(listings)) } });
  // S1: each held folder by the folder rule, routed contents included.
  const routed = classifyCommand("rm -rf .", [{ path: ".github/workflows/", class: "policy.edit.ci" }], disk({ "/w": [".github", "src"] }));
  assert.ok(routed.ok && ["policy.edit", "policy.edit.ci", "files.delete.out_of_scope"].every((cls) => routed.classes.includes(cls)), JSON.stringify(routed));
  assert.deepEqual([...withListing("rm -rf .", { "/w": [".approval", "src"] })].sort(), ["files.delete.out_of_scope", "log.mutate", "policy.core"]);
  // Two held folders: both classes, not only the higher-ranked one.
  const both = withListing("chmod -R 000 .", { "/w": [".claude", ".github"] });
  assert.ok(both.includes("policy.core") && both.includes("policy.edit"), both.join(","));
  // S2: tools that delete what they read or find, by what `.` holds.
  const organ = { "/w": [".claude", "src"] };
  for (const command of [
    "find . -delete",
    "find . -name '*.pyc' -delete",
    "find . -type f -delete",
    "git rm -r .",
    "tar --remove-files -czf x.tgz .",
    "tar --rem -czf x.tgz .",
    "TAR_OPTIONS=--remove-files tar -czf x.tgz .",
    "rsync -a --remove-source-files ./ /tmp/x/",
    "rsync -a --remov ./ /tmp/x/",
  ]) {
    assert.ok(withListing(command, organ).includes("policy.core"), `${command} -> ${withListing(command, organ).join(",")}`);
  }
  // Nothing held: main's class.
  for (const command of ["find . -delete", "git rm -r .", "tar --remove-files -czf x.tgz ."]) {
    assert.ok(!withListing(command, { "/w": ["src", "dist"] }).includes("policy.core"), command);
  }
  // Not a removal of what is below: main's class, wherever `.claude` is.
  for (const [command, main] of [
    ["git rm -r --cached .", "vcs.commit.branch"],
    ["tar -czf x.tgz .", "files.write.workspace"],
    ["rsync -a ./ /tmp/x/", "network.call"],
    ["mkdir -p .", "files.write.workspace"],
    ["touch .", "files.write.workspace"],
    ["git add .", "vcs.commit.branch"],
  ] as const) {
    assert.deepEqual(withListing(command, organ), [main], command);
  }
  // Refused on main and here: no rule, or opaque.
  for (const command of ["git clean -fdx", "zip -rm x.zip .", "chown -R x .", "find . -exec rm {} +", "export TAR_OPTIONS=--remove-files; tar -czf x.tgz ."]) {
    assert.equal(classifyCommand(command).ok, false, command);
  }
});

test("security review of d3ecdd5e: find's leading options, rsync's remove spellings and git's pathspecs are read for the parents rule, fail closed", () => {
  const organ = { "/w": [".claude", "src"] };
  const plain = { "/w": ["src", "dist"], "/w/dist": ["a.o"] };
  // 1. find: BSD's -E -X -d -s -x, -f PATH, GNU's -D OPTS and -O<n>; no start path is `.`.
  for (const command of [
    "find -E . -delete",
    "find -x . -delete",
    "find -s . -delete",
    "find -d . -delete",
    "find -f . -- -delete",
    "find -D tree . -delete",
    "find -O3 . -delete",
    "find -delete",
    "find -name '*.o' -delete",
    "find -Z . -delete",
  ]) {
    assert.ok(withListing(command, organ).includes("policy.core"), `${command} -> ${withListing(command, organ).join(",")}`);
  }
  // 2. rsync: both spellings of removing what it sent, and any prefix.
  for (const command of ["rsync -a --remove-sent-files ./ /tmp/x/", "rsync -a --remove-s ./ /tmp/x/", "rsync -a --remov ./ /tmp/x/"]) {
    assert.ok(withListing(command, organ).includes("policy.core"), command);
  }
  // 3. git rm: without -r too, and a pathspec git expands itself is `.`.
  for (const command of ["git rm .", "git rm -f .", "git rm ':(glob)**'", "git rm '.cl*'", "git rm -r -- '*'", "git rm --pathspec-from-file=list"]) {
    assert.ok(withListing(command, organ).includes("policy.core"), `${command} -> ${withListing(command, organ).join(",")}`);
  }
  // git's valued global options are refused by main, before this rule.
  for (const command of ["git -C sub rm -r .", "git -c core.x=y rm -r .", "git --git-dir=x --work-tree=. rm -r ."]) {
    assert.equal(classifyCommand(command).ok, false, command);
  }
  // The not-strict side keeps main's decision.
  assert.deepEqual(withListing("find dist -name '*.o' -delete", plain), ["files.delete.out_of_scope"]);
  assert.deepEqual(withListing("find . -name '*.o' -delete", plain), ["files.delete.out_of_scope"]);
  assert.deepEqual(withListing("rsync -a src/ dst/", plain), ["network.call"]);
  assert.deepEqual(withListing("git rm -r --cached build/", plain), ["vcs.commit.branch"]);
  assert.deepEqual(withListing("git rm -r --cached .", organ), ["vcs.commit.branch"]);
  assert.deepEqual(withListing("git rm src/a.ts", organ), ["vcs.commit.branch"]);
});

test("security review of cfe27ea2: git rm's --cached is an option only before --, and git clean's valued options are not paths", () => {
  const organ = { "/w": [".claude", "src", "build"] };
  const plain = { "/w": ["src", "build"], "/w/build": ["a.o"] };
  // 1. After `--`, `--cached` is a pathspec: the removal is real.
  for (const command of ["git rm -r -- . --cached", "git rm -r --cache .", "git rm -r --c .", "git rm --no-cached -r .", "git rm -r --unknown ."]) {
    assert.ok(withListing(command, organ).includes("policy.core"), `${command} -> ${withListing(command, organ).join(",")}`);
  }
  // 2. git clean (refused by main today, so refused here; were it classified):
  // -e's value is a pattern, and no pathspec is the whole tree.
  for (const command of ["git clean -fdx -e keepme", "git clean -fd", "git clean -fd --exclude=x"]) {
    assert.equal(classifyCommand(command).ok, false, command);
  }
  // The reader itself: what each removes from the disk.
  for (const [argv, removed] of [
    [["clean", "-fdx", "-e", "keepme"], ["."]],
    [["clean", "-fdx", "-ekeepme"], ["."]],
    [["clean", "-fd", "--exclude", "x"], ["."]],
    [["clean", "-fd", "--exclude=x", "build/"], ["build/"]],
    [["clean", "-fd"], ["."]],
    [["clean", "-fd", "--exc", "x"], ["."]],
    [["clean", "-n"], []],
    [["clean", "--dry-run", "-fd"], []],
    [["clean", "-fd", "build/"], ["build/"]],
    [["rm", "-r", "--", ".claude", "--cached"], [".claude", "--cached"]],
    [["rm", "-r", "--cached", "--", ".claude"], []],
    [["rm", "--cache", "-r", ".claude"], ["."]],
    [["rm", ".cl*"], ["."]],
    [["rm", "--pathspec-from-file=f"], ["."]],
    [["--no-pager", "rm", "x"], ["x"]],
  ] as const) {
    assert.deepEqual(gitRemovedPaths(argv), removed, argv.join(" "));
  }
  // The not-strict side keeps main's decision.
  assert.deepEqual(withListing("git rm --cached -r build/", plain), ["vcs.commit.branch"]);
  assert.deepEqual(withListing("git rm --cached -r .", organ), ["vcs.commit.branch"]);
  assert.deepEqual(withListing("git rm -r -n .", organ), ["vcs.commit.branch"]);
  assert.deepEqual(withListing("git rm -r build/", plain), ["vcs.commit.branch"]);
});
