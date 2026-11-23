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

import { classifyCommand, globWriteListingDirs } from "../src/core/command-class.js";

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
  // A whole `**` descends into dot-directories only with dot matching on.
  assert.deepEqual(classesOf("echo x > ~/**/auth.json"), ["files.write.workspace"]);
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

test("dot-names: *, ? and [...] do not reach them unless the same line turns dot matching on", () => {
  for (const [command, alone] of [
    ["echo x > dist/*/x.txt", "files.write.workspace"],
    ["echo x > ~/*/auth.json", "files.write.workspace"],
    ["echo x > */env", "files.write.workspace"],
    ["echo x > ?approval/env", "files.write.workspace"],
    ["echo x > [.]approval/env", "files.write.workspace"],
    ["cp a ~/*/auth.json", "files.write.workspace"],
  ] as const) {
    assert.deepEqual(classesOf(command), [alone], command);
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
  // A pattern for a DIRECTORY reaches only dot-directories: main's class by
  // default, strict when the line turns dot matching on.
  assert.deepEqual(classesOf("echo x > dist/*/x.txt"), ["files.write.workspace"]);
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
  // A line with none of them keeps the default reading.
  for (const line of [target, `cd out && ${target}`, `ls; ${target}`, `true && ${target}`]) {
    assert.equal(lastClass(line), "files.write.workspace", line);
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
  // Builtin names count as a WHOLE word only: assets/ and dataset/ are plain.
  assert.deepEqual(classesOf("echo x > assets/*/x.txt"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("echo x > dataset/*/x.txt"), ["files.write.workspace"]);
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

function withListing(command: string, listings: Record<string, readonly string[] | "unreadable">): string[] {
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
    assert.deepEqual(withListing(command, { [dir]: [".approval"] }), [main], `${command} dot-name, plain line`);
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
  for (const command of ["cp evil/notes.txt .claude/", "cp a.txt out/", "mv a.txt b.txt"]) {
    assert.ok(!classesOf(command).includes("policy.core"), `${command} -> ${classesOf(command).join(",")}`);
  }
  // A glob source is expanded from its own directory's listing, not the destination's.
  const listed = (command: string, names: readonly string[]): string[] => withListing(command, { "/w/evil": names, "/w/.claude": [] });
  assert.ok(listed("cp evil/* .claude/", ["settings.json"]).includes("policy.core"));
  assert.ok(!listed("cp evil/* .claude/", ["notes.txt"]).includes("policy.core"));
  assert.ok(!withListing("cp -r src/* out/", { "/w/src": ["a.ts", "lib"], "/w/out": [] }).includes("policy.core"));
});

test("review-b S2: an option-dependent zsh form is literal text on a plain line", () => {
  assert.deepEqual(classesOf("rm -f *~"), ["files.delete.out_of_scope"]);
  assert.deepEqual(classesOf("rm -f out/#x"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("echo x > out/^x"), ["files.write.workspace"]);
  // With options possibly set on the line, they are patterns again.
  assert.equal(lastClass("setopt extendedglob; echo x > APPROVAL.m*~x"), "policy.core");
});
