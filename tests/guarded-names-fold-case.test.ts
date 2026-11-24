/**
 * Guarded names fold case on every platform.
 *
 * The gate classifies a shell line before it runs, and its guards read path
 * names as text. They compared those names by exact letter case, while APFS,
 * macOS's default volume, opens a name under full Unicode case folding. So on
 * main `echo x > Approval.MD`, `rm -rf .APPROVAL`, `echo x > .Claude/settings.json`
 * and `echo x > .cursor/hoo<U+212A>s.json` were ordinary workspace writes, ran
 * unattended, and landed on the guarded file. The existing folds
 * (`toLowerCase()`, on the credential rows, the Hermes home, the `.git`
 * segment) missed ten of the eleven code points APFS folds to ASCII.
 *
 * Every guarded-name compare now goes through one fold, `foldFileName`. These
 * tests hold it to the measured table, and hold every spelling of every
 * guarded name to the class and rule its canonical spelling takes, pure and
 * through the hook. Controls that only contain a guarded name do not move.
 *
 * Folding can also change WHICH class a path takes (codex's SOURCE HOLD on
 * #688): `.approval/LOG/x` is `policy.core` as spelled and `log.mutate` folded,
 * and a policy may hold the first human-only and the second autonomous. So
 * every guard is read twice, folded and as spelled (exactly as main 21fc5fdc
 * read it), and a line reports both readings' classes: a spelling's answer
 * CONTAINS its canonical spelling's class and rule, and also the class main
 * gave that spelling. These tests pin that shape, hold the as-spelled reading
 * to main's answers, and run codex's two cases through the real hook.
 *
 * Hermetic: HOME is a fixture directory; git runs only to make a checkout, and
 * no line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fileURLToPath } from "node:url";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyApplyPatch, parseApplyPatch } from "../src/core/apply-patch.js";
import { loadPolicy, protectedRouteSpellingNotes } from "../src/core/policy-load.js";
import {
  classifyCommand,
  hermesTails,
  isCredentialPath,
  isGateOrganPath,
  isProtectedPath,
  isSkillScriptPath,
  protectedPathClass,
  protectedPathClassReadings,
  protectedPathClasses,
  type ProtectedPathEntry,
} from "../src/core/command-class.js";
import {
  eachNameReading,
  equalClaims,
  foldedOnly,
  foldFileName,
  foldNameExact,
  namesReadAsSpelled,
  takeAmongEqual,
  withNamesAsSpelled,
  SUBSTITUTION_SENTINEL,
} from "../src/core/name-fold.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-fold-case-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Fold Oracle\n\temail = oracle@example.invalid\n[init]\n\tdefaultBranch = main\n");
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];
delete process.env["CDPATH"];
delete process.env["HERMES_HOME"];
delete process.env["APPROVAL_HERMES_HOME"];

const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

/** A checkout for the hook to classify in, made once. */
let checkout: string | null = null;
function repo(): string {
  if (checkout !== null) return checkout;
  const dir = join(scratch, "repo");
  mkdirSync(dir, { recursive: true });
  const ran = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  checkout = dir;
  return dir;
}

/** Every segment as `class rule`, pure; a refusal as `refused <code>`. */
function pure(command: string, extra: readonly ProtectedPathEntry[] = []): string[] {
  const result = classifyCommand(command, extra);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

/** The same through the hook, in the fixture checkout. */
function hook(command: string, extra: readonly ProtectedPathEntry[] = []): string[] {
  const { result } = classifyForHook(command, extra, repo());
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

/** {@link pure} in the as-spelled reading: how main 21fc5fdc read the line. */
function spelledPure(command: string, extra: readonly ProtectedPathEntry[] = []): string[] {
  return withNamesAsSpelled(() => pure(command, extra));
}

/** {@link hook} in the as-spelled reading. */
function spelledHook(command: string, extra: readonly ProtectedPathEntry[] = []): string[] {
  return withNamesAsSpelled(() => hook(command, extra));
}

/**
 * The answer a one-segment line takes: its folded answer (`folded`), then
 * each as-spelled entry whose class the folded answer lacks.
 */
function union(folded: readonly string[], spelled: readonly string[]): string[] {
  const classOf = (entry: string): string => entry.split(" ")[0] ?? entry;
  if (folded[0]?.startsWith("refused ") === true) return [...folded];
  if (spelled[0]?.startsWith("refused ") === true) return [...spelled];
  return [...folded, ...spelled.filter((entry) => !folded.some((have) => classOf(have) === classOf(entry)))];
}

const KELVIN = "K";
const LONG_S = "ſ";
const SHARP_S = "ß";
const CAPITAL_SHARP_S = "ẞ";
const LIGATURE_FF = "ﬀ";
const LIGATURE_FI = "ﬁ";
const LIGATURE_FL = "ﬂ";
const LIGATURE_FFI = "ﬃ";
const LIGATURE_FFL = "ﬄ";
const LIGATURE_LONG_ST = "ﬅ";
const LIGATURE_ST = "ﬆ";
const DOTLESS_I = "ı";

test("foldFileName: each of the eleven code points APFS folds to ASCII gives its ASCII name", () => {
  // The table measured on APFS (every code point U+0080..U+10FFFF statted
  // against an ASCII name); `toLowerCase()` alone folds only the Kelvin sign.
  const table: readonly (readonly [string, string])[] = [
    [KELVIN, "k"],
    [LONG_S, "s"],
    [SHARP_S, "ss"],
    [CAPITAL_SHARP_S, "ss"],
    [LIGATURE_FF, "ff"],
    [LIGATURE_FI, "fi"],
    [LIGATURE_FL, "fl"],
    [LIGATURE_FFI, "ffi"],
    [LIGATURE_FFL, "ffl"],
    [LIGATURE_LONG_ST, "st"],
    [LIGATURE_ST, "st"],
  ];
  assert.equal(table.length, 11);
  for (const [codePoint, ascii] of table) {
    assert.equal(foldFileName(codePoint), ascii, `U+${(codePoint.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
  }
  assert.equal(foldFileName(`hoo${KELVIN}s.json`), "hooks.json");
  assert.equal(foldFileName(`${LONG_S}ettings.json`), "settings.json");
  assert.equal(foldFileName(`.${SHARP_S}h`), ".ssh");
  assert.equal(foldFileName(`con${LIGATURE_FI}g.toml`), "config.toml");
});

test("foldFileName: ASCII lower case is unchanged, ASCII upper case lowers, and it is idempotent", () => {
  for (const name of ["approval.md", ".approval", ".claude", "settings.json", ".github", "workflows", "config.toml", "a-b_c.0"]) {
    assert.equal(foldFileName(name), name);
    assert.equal(foldFileName(name.toUpperCase()), name);
    assert.equal(foldFileName(foldFileName(name.toUpperCase())), name);
  }
  assert.equal(foldFileName("APPROVAL.md"), "approval.md");
  assert.equal(foldFileName(""), "");
});

test("foldFileName: the dotless i is the one stricter case; the rest APFS keeps apart stays apart", () => {
  // Stricter than the filesystem on one code point: APFS opens `.g<U+0131>t`
  // as a different name, and the fold calls it `.git`. That costs a prompt.
  assert.equal(foldFileName(`.g${DOTLESS_I}t`), ".git");
  // Not folded to ASCII by APFS, and not by the fold: the dotted capital I,
  // a fullwidth letter, a zero-width space (U+200B; HFS+ keeps it too, while
  // it ignores the zero-width joiner U+200D: see the HFS+ tests below).
  assert.notEqual(foldFileName("İ"), "i");
  assert.notEqual(foldFileName("ａpproval.md"), "approval.md");
  assert.notEqual(foldFileName("ap\u200Bproval.md"), "approval.md");
  assert.equal(foldFileName("ap\u200Dproval.md"), "approval.md");
});

/**
 * One row per guarded name: the canonical spelling, the class a write and a
 * read of it take, and the spellings that must take the same. Every row is
 * also removed with `rm -rf`, which is how a directory row is written.
 */
interface Row {
  readonly path: string;
  readonly write: string;
  /** Classes a write onto the bare folder also takes from its contents (lead ruling L62013, S1). */
  readonly contents?: readonly string[];
  readonly read: string;
  readonly spellings: readonly string[];
}

const WRITE_CORE = "policy.core redirect-protected";
const WRITE_EDIT = "policy.edit redirect-protected";
const READ = "read.shell read-shell";
const CREDENTIAL = "account.credential credential-path";

const ROWS: readonly Row[] = [
  { path: "APPROVAL.md", write: WRITE_CORE, read: READ, spellings: ["Approval.MD", "approval.md", "aPpRoVaL.mD"] },
  { path: "APPROVALS.md", write: WRITE_CORE, read: READ, spellings: ["approvals.md", "Approvals.Md", `APPROVAL${LONG_S}.md`] },
  { path: ".approval", write: WRITE_CORE, contents: ["log.mutate redirect-protected"], read: READ, spellings: [".APPROVAL", ".Approval"] },
  { path: ".approval/env", write: WRITE_CORE, read: CREDENTIAL, spellings: [".APPROVAL/env", ".approval/ENV", ".Approval/Env"] },
  { path: ".approval/vault.enc", write: WRITE_CORE, read: CREDENTIAL, spellings: [".APPROVAL/vault.enc", ".approval/VAULT.ENC"] },
  { path: ".approval/keys/k1", write: WRITE_CORE, read: CREDENTIAL, spellings: [".APPROVAL/KEYS/k1", `.approval/${KELVIN}eys/k1`, `.approval/key${LONG_S}/k1`] },
  { path: ".approval/log/events.jsonl", write: "log.mutate redirect-protected", read: READ, spellings: [".APPROVAL/log/events.jsonl", ".approval/LOG/events.jsonl", ".Approval/Log/events.jsonl"] },
  { path: ".claude/settings.json", write: WRITE_CORE, read: READ, spellings: [".Claude/settings.json", ".claude/Settings.json", ".CLAUDE/SETTINGS.JSON", `.claude/${LONG_S}ettings.json`, `.claude/setting${LONG_S}.json`] },
  { path: ".claude/settings.local.json", write: WRITE_CORE, read: READ, spellings: [".CLAUDE/Settings.Local.json", `.claude/${LONG_S}ettings.local.json`] },
  { path: ".cursor/hooks.json", write: WRITE_CORE, read: READ, spellings: [".Cursor/hooks.json", ".cursor/HOOKS.json", `.cursor/hoo${KELVIN}s.json`, `.cursor/hook${LONG_S}.json`, `.cur${LONG_S}or/hooks.json`] },
  { path: ".cursor/agents/a.md", write: WRITE_CORE, read: READ, spellings: [".CURSOR/Agents/a.md", `.cursor/agent${LONG_S}/a.md`] },
  { path: ".grok/hooks.json", write: WRITE_CORE, read: READ, spellings: [".GROK/hooks.json", `.gro${KELVIN}/hooks.json`, `.grok/hoo${KELVIN}s.json`] },
  { path: ".muse/hooks.json", write: WRITE_CORE, read: READ, spellings: [".MUSE/hooks.json", `.mu${LONG_S}e/hooks.json`] },
  { path: ".muse/settings.json", write: WRITE_CORE, read: READ, spellings: [".Muse/Settings.json", `.muse/${LONG_S}ettings.json`] },
  { path: ".codex/config.toml", write: WRITE_CORE, read: READ, spellings: [".Codex/config.toml", ".codex/Config.TOML", `.codex/con${LIGATURE_FI}g.toml`] },
  { path: ".codex/hooks.json", write: WRITE_CORE, read: READ, spellings: [".CODEX/hooks.json", `.codex/hoo${KELVIN}s.json`] },
  { path: "~/.hermes/config.yaml", write: WRITE_CORE, read: READ, spellings: ["~/.HERMES/config.yaml", `~/.herme${LONG_S}/config.yaml`, `~/.hermes/con${LIGATURE_FI}g.yaml`] },
  { path: "~/.hermes/.env", write: WRITE_CORE, read: CREDENTIAL, spellings: ["~/.Hermes/.ENV", `~/.herme${LONG_S}/.env`] },
  { path: "~/.hermes/auth.json", write: WRITE_CORE, read: CREDENTIAL, spellings: ["~/.hermes/AUTH.json", `~/.herme${LONG_S}/auth.json`] },
  { path: "~/.hermes/hermes-agent/.env", write: WRITE_CORE, read: CREDENTIAL, spellings: ["~/.hermes/Hermes-Agent/.env", `~/.hermes/herme${LONG_S}-agent/.env`] },
  { path: "~/.hermes/profiles/p/.env", write: WRITE_CORE, read: CREDENTIAL, spellings: ["~/.hermes/PROFILES/p/.env", `~/.hermes/pro${LIGATURE_FI}le${LONG_S}/p/.env`] },
  { path: "~/.hermes/scripts/x.sh", write: "cron.manage redirect-protected", read: READ, spellings: ["~/.hermes/Scripts/x.sh", `~/.hermes/${LONG_S}cripts/x.sh`] },
  { path: "~/.hermes/shell-hooks-allowlist.json", write: WRITE_CORE, read: READ, spellings: ["~/.hermes/SHELL-HOOKS-ALLOWLIST.json", `~/.hermes/shell-hoo${KELVIN}s-allowlist.json`, `~/.hermes/shell-hooks-allowli${LIGATURE_ST}.json`, `~/.hermes/shell-hooks-allowli${LIGATURE_LONG_ST}.json`] },
  { path: "~/.hermes/plugins/x.py", write: WRITE_CORE, read: READ, spellings: ["~/.hermes/Plugins/x.py", `~/.hermes/plugin${LONG_S}/x.py`] },
  { path: "CLAUDE.md", write: WRITE_EDIT, read: READ, spellings: ["claude.md", "Claude.Md"] },
  { path: "AGENTS.md", write: WRITE_EDIT, read: READ, spellings: ["agents.md", `AGENT${LONG_S}.md`] },
  { path: ".npmrc", write: WRITE_EDIT, read: READ, spellings: [".NPMRC", ".NpmRc"] },
  { path: ".github/workflows/ci.yml", write: WRITE_EDIT, read: READ, spellings: [".GitHub/workflows/ci.yml", ".github/Workflows/ci.yml", `.github/work${LIGATURE_FL}ows/ci.yml`, `.github/workflow${LONG_S}/ci.yml`] },
  { path: ".git/config", write: "vcs.history.rewrite git-dir-write", read: READ, spellings: [".GIT/config", ".Git/config"] },
  { path: "~/.gitconfig", write: "vcs.history.rewrite git-config-file-write", read: READ, spellings: ["~/.GITCONFIG", `~/.gitcon${LIGATURE_FI}g`] },
  { path: "~/.config/git/config", write: "vcs.history.rewrite git-config-file-write", read: READ, spellings: ["~/.CONFIG/git/config", `~/.con${LIGATURE_FI}g/git/config`] },
];

test("every spelling of a guarded name: its canonical spelling's class and rule, then main's class for it, pure", () => {
  for (const row of ROWS) {
    assert.deepEqual(pure(`echo x > ${row.path}`), [row.write, ...(row.contents ?? [])], `canonical write ${row.path}`);
    assert.deepEqual(pure(`cat ${row.path}`), [row.read], `canonical read ${row.path}`);
    const canonical = {
      write: pure(`echo x > ${row.path}`),
      append: pure(`echo x >> ${row.path}`),
      remove: pure(`rm -rf ${row.path}`),
      read: pure(`cat ${row.path}`),
    };
    // A canonical spelling reads alike both ways: nothing is added to it.
    // The folder's contents are claims of equal standing (takeAmongEqual): the
    // as-spelled reading takes the first, the folded one each in turn.
    assert.deepEqual(spelledPure(`echo x > ${row.path}`), row.contents === undefined ? canonical.write : canonical.write.slice(0, 1), `canonical write as spelled ${row.path}`);
    for (const spelled of row.spellings) {
      assert.notEqual(spelled, row.path);
      const lines: readonly (readonly [string, readonly string[]])[] = [
        [`echo x > ${spelled}`, canonical.write],
        [`echo x >> ${spelled}`, canonical.append],
        [`rm -rf ${spelled}`, canonical.remove],
        [`cat ${spelled}`, canonical.read],
        [`echo x > a/b/${spelled.replace(/^~\//u, "")}`, pure(`echo x > a/b/${row.path.replace(/^~\//u, "")}`)],
      ];
      for (const [line, canonicalAnswer] of lines) {
        const got = pure(line);
        // CONTAINS the canonical answer, and the as-spelled (main's) answer, and nothing else.
        assert.deepEqual(got, union(canonicalAnswer, spelledPure(line)), line);
        for (const entry of canonicalAnswer) assert.ok(got.includes(entry), `${line}: ${entry}`);
      }
    }
  }
});

test("every spelling of a guarded name: its canonical spelling's class and rule, then main's class for it, through the hook", { skip }, () => {
  for (const row of ROWS) {
    const canonical = {
      write: hook(`echo x > ${row.path}`),
      remove: hook(`rm -rf ${row.path}`),
      read: hook(`cat ${row.path}`),
    };
    assert.notDeepEqual(canonical.write, ["files.write.workspace redirect-write"], `canonical write ${row.path}`);
    for (const spelled of row.spellings) {
      for (const [line, canonicalAnswer] of [
        [`echo x > ${spelled}`, canonical.write],
        [`rm -rf ${spelled}`, canonical.remove],
        [`cat ${spelled}`, canonical.read],
      ] as const) {
        const got = hook(line);
        assert.deepEqual(got, union(canonicalAnswer, spelledHook(line)), `hook ${line}`);
      }
    }
  }
});

test("a spelling's answer, pinned: the folded class first, then the class main gave that spelling", () => {
  // The shape in exact arrays. Each second entry is what main 21fc5fdc
  // answers for the same line (and the as-spelled reading below).
  assert.deepEqual(pure("echo x > Approval.MD"), [WRITE_CORE, "files.write.workspace redirect-write"]);
  // Codex's case 1: as spelled, `LOG` is not `log` and `.approval` is the
  // approval home, so main says `policy.core`; folded it is the log. Both.
  assert.deepEqual(pure("echo x > .approval/LOG/x"), ["log.mutate redirect-protected", WRITE_CORE]);
  assert.deepEqual(pure(`cp x .approval/key${LONG_S}/k1`), ["account.credential credential-path", "policy.core protected-path"]);
  assert.deepEqual(pure(`git push origin ma${LONG_S}ter`), ["vcs.push.main git-push-main", "vcs.push.branch git-push-branch"]);
  assert.deepEqual(pure(`git push origin lane:refs/head${LONG_S}/main`)[0], "vcs.push.main git-push-main");
  // A canonical spelling, or one main already folded, stays one entry.
  assert.deepEqual(pure("echo x > .approval/log/x"), ["log.mutate redirect-protected"]);
  assert.deepEqual(pure("echo x > ~/.HERMES/config.yaml"), [WRITE_CORE]);
  assert.deepEqual(pure("cat .APPROVAL/ENV"), [CREDENTIAL]);
  assert.deepEqual(pure("git push origin MAIN"), ["vcs.push.main git-push-main"]);
});

test("the brief's examples are guarded, not ordinary writes", () => {
  for (const [command, expected] of [
    ["echo x > Approval.MD", WRITE_CORE],
    ["echo x > approval.md", WRITE_CORE],
    // Its log goes with the folder (lead ruling L62013, S1): below.
    ["rm -rf .APPROVAL", "policy.core protected-path"],
    ["echo x > .APPROVAL/env", WRITE_CORE],
    ["echo x > .APPROVAL/log/events.jsonl", "log.mutate redirect-protected"],
    ["echo x > .Claude/settings.json", WRITE_CORE],
    ["echo x > .claude/Settings.json", WRITE_CORE],
    ["echo x > .Cursor/hooks.json", WRITE_CORE],
    ["echo x > claude.md", WRITE_EDIT],
    ["echo x > .GitHub/workflows/ci.yml", WRITE_EDIT],
    ["echo x > ~/.Codex/config.toml", WRITE_CORE],
    [`echo x > .cursor/hoo${KELVIN}s.json`, WRITE_CORE],
    [`echo x > .claude/${LONG_S}ettings.json`, WRITE_CORE],
    [`echo x > ~/.codex/con${LIGATURE_FI}g.toml`, WRITE_CORE],
    [`cat ~/.herme${LONG_S}/.env`, CREDENTIAL],
  ] as const) {
    // The folded class first; main's class for the spelling may follow it.
    const got = pure(command);
    assert.equal(got[0], expected, command);
    const contents = command === "rm -rf .APPROVAL" ? ["log.mutate protected-path"] : [];
    assert.deepEqual(got, union([expected, ...contents], spelledPure(command)), command);
  }
});

test("the guard functions fold: protectedPathClass, isCredentialPath, isGateOrganPath", () => {
  // `protectedPathClass` answers in the current reading (folded here);
  // `protectedPathClasses` is every class of either reading, folded first.
  assert.equal(protectedPathClass(".approval/LOG/x"), "log.mutate");
  assert.deepEqual(protectedPathClasses(".approval/LOG/x"), ["log.mutate", "policy.core"]);
  assert.deepEqual(protectedPathClassReadings(".approval/LOG/x"), ["log.mutate", "policy.core"]);
  assert.deepEqual(protectedPathClassReadings("Approval.MD"), ["policy.core", null]);
  assert.deepEqual(protectedPathClasses("Approval.MD"), ["policy.core"]);
  assert.deepEqual(protectedPathClassReadings(".approval/log/x"), ["log.mutate"]);
  assert.equal(isProtectedPath("Approval.MD"), true);
  assert.equal(protectedPathClass(".APPROVAL/log/x"), "log.mutate");
  assert.equal(protectedPathClass("Approval.MD"), "policy.core");
  assert.equal(protectedPathClass(`.claude/${LONG_S}ettings.json`), "policy.core");
  assert.equal(protectedPathClass("Agents.md"), "policy.edit");
  assert.equal(protectedPathClass(".GITHUB/WORKFLOWS/x.yml"), "policy.edit");
  assert.equal(isCredentialPath(`~/.herme${LONG_S}/auth.json`), true);
  assert.equal(isCredentialPath(`.approval/key${LONG_S}`), true);
  // An organ is attested by content; the policy file and the approval home
  // never are, in any spelling. The exclusions fold with the class. Being an
  // organ is a GRANT, so it must hold in both readings: `.Claude/Settings.json`
  // is not an organ as spelled (main says no class at all), so it is not one.
  assert.equal(isGateOrganPath(".claude/settings.json"), true);
  assert.equal(isGateOrganPath(".Claude/Settings.json"), false);
  // Both readings call these organ files `policy.core`; the folded reading's
  // exclusions (the approval home, the policy file) fold too, so neither is
  // an organ (main called both organs: its exclusions were exact).
  assert.equal(isGateOrganPath(".Approval/x/.claude/settings.json"), false);
  assert.equal(isGateOrganPath(".claude/settings/Approval.md"), false);
  assert.equal(isGateOrganPath("x/.claude/settings.json"), true);
  assert.equal(isGateOrganPath("APPROVAL.md"), false);
  assert.equal(isGateOrganPath("approval.md"), false);
  assert.equal(isGateOrganPath(`APPROVAL${LONG_S}.md`), false);
  assert.equal(isGateOrganPath(".APPROVAL/queue"), false);
});

test("a policy-declared protected entry matches in another case, bare and routed", () => {
  const extra: ProtectedPathEntry[] = ["design/", "docs/frozen.md", { path: "spec/", class: "policy.edit.spec" }];
  assert.equal(protectedPathClass("Design/x.md", extra), "policy.edit");
  assert.equal(protectedPathClass("DESIGN/x.md", extra), "policy.edit");
  assert.equal(protectedPathClass("docs/FROZEN.md", extra), "policy.edit");
  assert.equal(protectedPathClass("SPEC/a.md", extra), "policy.edit.spec");
  assert.equal(protectedPathClass(`${LONG_S}pec/a.md`, extra), "policy.edit.spec");
  // The entry itself in another case matches the canonical spelling.
  assert.equal(protectedPathClass("design/x.md", ["DESIGN/"]), "policy.edit");
  assert.deepEqual(pure("echo x > Design/notes.md", extra), [WRITE_EDIT, "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("echo x > design/notes.md", extra), [WRITE_EDIT]);
  // Not a looser match: a name that only contains the entry does not move.
  assert.equal(protectedPathClass("designs/x.md", extra), null);
  assert.equal(protectedPathClass("docs/frozen.md.bak", extra), null);
});

test("a policy-declared protected entry matches in another case through the hook", { skip }, () => {
  const extra: ProtectedPathEntry[] = ["design/"];
  assert.deepEqual(hook("echo x > design/notes.md", extra), [WRITE_EDIT]);
  assert.deepEqual(hook("echo x > Design/notes.md", extra), [WRITE_EDIT, "files.write.workspace redirect-write"]);
});

/** Codex's case 2: two routed entries that collide once names fold. */
const OPEN_FIRST: ProtectedPathEntry[] = [
  { path: "SPEC/", class: "policy.edit.open" },
  { path: "spec/", class: "policy.edit.closed" },
];
const CLOSED_FIRST: ProtectedPathEntry[] = [
  { path: "spec/", class: "policy.edit.closed" },
  { path: "SPEC/", class: "policy.edit.open" },
];

test("routed entries that collide by case: each line keeps the class main gives it, in both declaration orders", () => {
  // Main: `spec/x` is `closed` and `SPEC/x` is `open` in either order (each
  // matches one entry). Folded, both entries match with the same depth, and
  // both classes are reported, the first declared first (review S2 on #688).
  for (const extra of [OPEN_FIRST, CLOSED_FIRST]) {
    assert.deepEqual(spelledPure("echo x > spec/x", extra), ["policy.edit.closed redirect-protected"]);
    assert.deepEqual(spelledPure("echo x > SPEC/x", extra), ["policy.edit.open redirect-protected"]);
    assert.ok(pure("echo x > spec/x", extra).includes("policy.edit.closed redirect-protected"));
    assert.ok(pure("echo x > SPEC/x", extra).includes("policy.edit.open redirect-protected"));
    assert.ok(protectedPathClasses("spec/x", extra).includes("policy.edit.closed"));
    assert.ok(protectedPathClasses("SPEC/x", extra).includes("policy.edit.open"));
  }
  const OPEN_THEN_CLOSED = ["policy.edit.open redirect-protected", "policy.edit.closed redirect-protected"];
  const CLOSED_THEN_OPEN = ["policy.edit.closed redirect-protected", "policy.edit.open redirect-protected"];
  // A third spelling, which neither entry names as spelled, takes both too,
  // beside the workspace write main called it.
  const WORKSPACE = "files.write.workspace redirect-write";
  for (const target of ["spec/x", "SPEC/x", "Spec/x", `${LONG_S}pec/x`]) {
    const main = target === "spec/x" || target === "SPEC/x" ? [] : [WORKSPACE];
    assert.deepEqual(pure(`echo x > ${target}`, OPEN_FIRST), [...OPEN_THEN_CLOSED, ...main], target);
    assert.deepEqual(pure(`echo x > ${target}`, CLOSED_FIRST), [...CLOSED_THEN_OPEN, ...main], target);
    assert.deepEqual(protectedPathClasses(target, OPEN_FIRST), ["policy.edit.open", "policy.edit.closed"], target);
    assert.deepEqual(protectedPathClasses(target, CLOSED_FIRST), ["policy.edit.closed", "policy.edit.open"], target);
  }
  // Nested depths: `Design/Frozen/` beside `design/`.
  const nested: ProtectedPathEntry[] = [
    { path: "Design/Frozen/", class: "policy.edit.frozen" },
    { path: "design/", class: "policy.edit.design" },
  ];
  assert.deepEqual(pure("echo x > design/frozen/x", nested), ["policy.edit.frozen redirect-protected", "policy.edit.design redirect-protected"]);
  assert.deepEqual(pure("echo x > Design/Frozen/x", nested), ["policy.edit.frozen redirect-protected"]);
});

test("routes of the same depth that all match one path are all reported, however many and however spelled", () => {
  // Three spellings of one folder.
  const three: ProtectedPathEntry[] = [
    { path: "SPEC/", class: "policy.edit.one" },
    { path: "Spec/", class: "policy.edit.two" },
    { path: "spec/", class: "policy.edit.three" },
  ];
  for (const target of ["spec/x", "SPEC/x", "Spec/x", "sPEC/x"]) {
    assert.deepEqual(protectedPathClasses(target, three), ["policy.edit.one", "policy.edit.two", "policy.edit.three"], target);
    assert.deepEqual(
      pure(`echo x > ${target}`, three),
      [
        "policy.edit.one redirect-protected",
        "policy.edit.two redirect-protected",
        "policy.edit.three redirect-protected",
        // The one spelling no entry names as spelled keeps main's class too.
        ...(target === "sPEC/x" ? ["files.write.workspace redirect-write"] : []),
      ],
      target,
    );
  }
  // As spelled, the one entry spelled like the path answers alone, as on main.
  assert.deepEqual(spelledPure("echo x > Spec/x", three), ["policy.edit.two redirect-protected"]);
  // Two entries can tie with no fold at all: both folders are on the path.
  // Main took the first declared; both are reported, the first declared first.
  const plain: ProtectedPathEntry[] = [
    { path: "a/b/", class: "policy.edit.ab" },
    { path: "c/d/", class: "policy.edit.cd" },
  ];
  assert.deepEqual(spelledPure("echo x > a/b/c/d/x", plain), ["policy.edit.ab redirect-protected"]);
  assert.deepEqual(pure("echo x > a/b/c/d/x", plain), ["policy.edit.ab redirect-protected", "policy.edit.cd redirect-protected"]);
  // Two tied entries of one class are one claim.
  const same: ProtectedPathEntry[] = [
    { path: "SPEC/", class: "policy.edit.one" },
    { path: "spec/", class: "policy.edit.one" },
  ];
  assert.deepEqual(pure("echo x > spec/x", same), ["policy.edit.one redirect-protected"]);
  // A deeper route still wins over a shallower tie.
  const deeper: ProtectedPathEntry[] = [...three, { path: "spec/frozen/", class: "policy.edit.frozen" }];
  assert.deepEqual(protectedPathClasses("spec/frozen/x", deeper), ["policy.edit.frozen"]);
  // Two tied words on one line: each word's claims are all taken.
  assert.deepEqual(pure("echo x > spec/x; echo y > a/b/c/d/y", [...OPEN_FIRST, ...plain]), [
    "policy.edit.open redirect-protected",
    "policy.edit.ab redirect-protected",
    "policy.edit.closed redirect-protected",
    "policy.edit.cd redirect-protected",
  ]);
});

test("equal claims: the folded reading takes each in turn, the as-spelled one the first, and a throw restores the turn", () => {
  const claims = ["a", "b", "c"];
  assert.equal(takeAmongEqual(claims), "a", "outside a reading, the first");
  assert.deepEqual(eachNameReading(() => takeAmongEqual(claims)), ["a", "b", "c"]);
  assert.deepEqual(eachNameReading(() => `${takeAmongEqual(claims)}${takeAmongEqual(["x", "y"])}`), ["ax", "by", "cx"]);
  assert.equal(withNamesAsSpelled(() => takeAmongEqual(claims)), "a");
  assert.deepEqual(withNamesAsSpelled(() => eachNameReading(() => takeAmongEqual(claims))), ["a"]);
  // With a diverging name the as-spelled answer comes last.
  assert.deepEqual(eachNameReading(() => `${takeAmongEqual(claims)}${foldNameExact("K")}`), ["ak", "bk", "ck", "aK"]);
  assert.throws(() =>
    eachNameReading(() => {
      if (takeAmongEqual(claims) === "b") throw new Error("second turn");
      return 0;
    }),
  );
  assert.equal(takeAmongEqual(claims), "a", "the turn is restored after a throw");
  assert.throws(() => takeAmongEqual([]), TypeError);
  // A nested reading takes every claim itself and leaves the outer turn alone.
  assert.deepEqual(
    eachNameReading(() => eachNameReading(() => takeAmongEqual(claims)).join("")),
    ["abc", "abc", "abc"],
  );
  // Inside an outer turn the as-spelled reading still takes the first claim.
  assert.deepEqual(
    eachNameReading(() => eachNameReading(() => `${takeAmongEqual(claims)}${foldNameExact("K")}`).join("")),
    ["akbkckaK", "akbkckaK", "akbkckaK", "aK"],
  );
});

test("routed entries that collide by case, through the hook", { skip }, () => {
  for (const extra of [OPEN_FIRST, CLOSED_FIRST]) {
    assert.ok(hook("echo x > spec/x", extra).includes("policy.edit.closed redirect-protected"));
    assert.ok(hook("echo x > SPEC/x", extra).includes("policy.edit.open redirect-protected"));
  }
});

const CONTROLS: readonly string[] = [
  "echo x > approval-notes.md",
  "echo x > docs/claude.txt",
  "echo x > src/approval/x.ts",
  "echo x > notes/my-APPROVAL.md.bak",
  "echo x > CLAUDE.md.orig",
  "echo x > .claudette/settings.json",
  "echo x > .cursors/hooks.json",
  "echo x > .github/workflow/ci.yml",
  "echo x > ａpproval.md",
  "echo x > .gİt/config",
];

test("controls that only contain a guarded name do not move", () => {
  for (const command of CONTROLS) {
    assert.deepEqual(pure(command), ["files.write.workspace redirect-write"], command);
  }
});

test("controls that only contain a guarded name do not move, through the hook", { skip }, () => {
  for (const command of CONTROLS) {
    assert.deepEqual(hook(command), ["files.write.workspace redirect-write"], command);
  }
});

test("grants stay exact: the skill-script shape and the install's .env.example", () => {
  // A grant makes a line lighter, so it keeps its exact spelling: a home
  // spelled in another case is the home to every guard, and never the
  // skill-script shape.
  assert.equal(isSkillScriptPath("/h/.hermes/skills/s/scripts/f.py"), true);
  assert.equal(isSkillScriptPath("/h/.HERMES/skills/s/scripts/f.py"), false);
  assert.equal(isSkillScriptPath(`/h/.herme${LONG_S}/skills/s/scripts/f.py`), false);
  // `.env.example` is exempt exactly; any other spelling stays a credential.
  assert.equal(isCredentialPath("~/.hermes/hermes-agent/.env.example"), false);
  assert.equal(isCredentialPath("~/.hermes/hermes-agent/.env.EXAMPLE"), true);
});

test("the hook's own passes fold: a home or key folder spelled with the long s", { skip }, (t) => {
  // The hook also reads the disk: a recursive read's root, a glob's
  // directory, a `cd` target. Made-up files stand in a fixture home and
  // checkout; each line is classified, never run. Each spelling takes the
  // canonical line's answer, and that answer names the credential found.
  const RESOLVED = "account.credential credential-path-resolved";
  mkdirSync(join(HOME, ".hermes", "profiles", "p"), { recursive: true });
  writeFileSync(join(HOME, ".hermes", ".env"), "MADE_UP=1\n");
  writeFileSync(join(HOME, ".hermes", "profiles", "p", ".env"), "MADE_UP=1\n");
  mkdirSync(join(HOME, ".hermes", "sub"));
  writeFileSync(join(HOME, ".hermes", "sub", ".env"), "MADE_UP=1\n");
  const dir = repo();
  mkdirSync(join(dir, ".approval", "keys"), { recursive: true });
  writeFileSync(join(dir, ".approval", "keys", "k1"), "made-up\n");
  // A home in the checkout with no credential right under it: only the
  // root's own kind can call a recursive read of it a credential read.
  mkdirSync(join(dir, ".hermes", "profiles", "q"), { recursive: true });
  writeFileSync(join(dir, ".hermes", "profiles", "q", ".env"), "MADE_UP=1\n");
  // Decided by the text alone, on every volume: the approval home's file
  // names, the Hermes home and a credential file's name under a directory
  // the line does not resolve. Each depends on one compare of the hook
  // (found by planting `toLowerCase()` back in each, one at a time).
  const byText: readonly (readonly [string, string])[] = [
    ["cat $H/keys", `cat $H/key${LONG_S}`],
    ["cat $X/.hermes/$F", `cat $X/.herme${LONG_S}/$F`],
    ["cat $X/y/auth.json", `cat $X/y/auth.j${LONG_S}on`],
  ];
  // Decided on the disk, so only where the volume opens `.herme<U+017F>` as
  // `.hermes` (APFS does; a case-sensitive volume keeps them apart, and there
  // the spelled folder is another folder, which does not exist). The last two
  // each depend on one compare: the read root's kind, and the folder that
  // holds a credential.
  const onDisk: readonly (readonly [string, string])[] = [
    ["grep -r x ~/.hermes", `grep -r x ~/.herme${LONG_S}`],
    ["cat ~/.hermes/*", `cat ~/.herme${LONG_S}/*`],
    ["cd ~/.hermes && cat .env", `cd ~/.herme${LONG_S} && cat .env`],
    ["tar cf - ~/.hermes", `tar cf - ~/.herme${LONG_S}`],
    ["cp -r ~/.hermes /tmp/x", `cp -r ~/.herme${LONG_S} /tmp/x`],
    ["cd .approval/keys && cat k1", `cd .approval/key${LONG_S} && cat k1`],
    ["grep -r x .hermes", `grep -r x .herme${LONG_S}`],
    ["grep -r x ~/.hermes/sub", `grep -r x ~/.herme${LONG_S}/sub`],
  ];
  const volumeFolds = existsSync(join(HOME, `.herme${LONG_S}`));
  if (!volumeFolds) t.diagnostic("this volume does not fold names: the on-disk pairs are not asserted here");
  try {
    for (const [canonical, spelled] of volumeFolds ? [...byText, ...onDisk] : byText) {
      const want = hook(canonical);
      assert.ok(want.includes(RESOLVED), `${canonical}: ${want.join(" ; ")}`);
      // The canonical line's answer, then what main gave the spelling.
      const got = hook(spelled);
      for (const entry of want) assert.ok(got.includes(entry), `${spelled}: ${entry} in ${got.join(" ; ")}`);
      for (const entry of spelledHook(spelled)) assert.ok(got.some((have) => have.split(" ")[0] === entry.split(" ")[0]), `${spelled}: main's ${entry}`);
    }
  } finally {
    rmSync(join(HOME, ".hermes"), { recursive: true, force: true });
    rmSync(join(dir, ".approval"), { recursive: true, force: true });
    rmSync(join(dir, ".hermes"), { recursive: true, force: true });
  }
});

test("git ref names fold as file names: trunk and tag spellings, beside main's class", () => {
  for (const [spelled, canonical] of [
    [`git push origin ma${LONG_S}ter`, "git push origin master"],
    [`git push origin ma${LIGATURE_ST}er`, "git push origin master"],
    [`git push origin lane:refs/head${LONG_S}/main`, "git push origin lane:refs/heads/main"],
    [`git push origin tag${LONG_S}/v1`, "git push origin tags/v1"],
  ] as const) {
    assert.deepEqual(pure(spelled), union(pure(canonical), spelledPure(spelled)), spelled);
    assert.notDeepEqual(pure(spelled), spelledPure(spelled), spelled);
  }
  assert.notDeepEqual(pure("git push origin master"), pure("git push origin lane"));
});

test("the as-spelled reading answers what main 21fc5fdc answers, at each kind of compare", () => {
  // Pinned from main 21fc5fdc's own classifier. A compare that was EXACT on
  // main stays exact as spelled (`.APPROVAL`, `Approval.MD`, `claude.md`, a
  // policy entry); one that LOWERED stays lowered (the Hermes home, the
  // credential rows, `.git`, the trunk and tag names).
  const MAIN: readonly (readonly [string, readonly ProtectedPathEntry[], readonly string[]])[] = [
    ["echo x > .APPROVAL/env", [], ["files.write.workspace redirect-write"]],
    ["echo x > Approval.MD", [], ["files.write.workspace redirect-write"]],
    [">> Approval.md", [], ["files.write.workspace redirect-write"]],
    ["echo x > .approval/LOG/x", [], [WRITE_CORE]],
    ["echo x > claude.md", [], ["files.write.workspace redirect-write"]],
    ["echo x > .Claude/settings.json", [], ["files.write.workspace redirect-write"]],
    [`echo x > .cursor/hoo${KELVIN}s.json`, [], ["files.write.workspace redirect-write"]],
    ["echo x > Design/x", ["design/"], ["files.write.workspace redirect-write"]],
    ["echo x > design/x", ["DESIGN/"], ["files.write.workspace redirect-write"]],
    ["echo x > ~/.HERMES/config.yaml", [], [WRITE_CORE]],
    [`echo x > ~/.herme${LONG_S}/config.yaml`, [], ["files.write.workspace redirect-write"]],
    ["cat .APPROVAL/ENV", [], [CREDENTIAL]],
    [`cp x .approval/key${LONG_S}/k1`, [], ["policy.core protected-path"]],
    ["echo x > .GIT/config", [], ["vcs.history.rewrite git-dir-write"]],
    [`echo x > .g${DOTLESS_I}t/config`, [], ["files.write.workspace redirect-write"]],
    ["echo x > ~/.GITCONFIG", [], ["vcs.history.rewrite git-config-file-write"]],
    ["git push origin MAIN", [], ["vcs.push.main git-push-main"]],
    ["git push origin TAGS/v1", [], ["release.publish git-push-tag"]],
    [`git push origin ma${LONG_S}ter`, [], ["vcs.push.branch git-push-branch"]],
  ];
  for (const [line, extra, main] of MAIN) {
    assert.deepEqual(spelledPure(line, extra), main, line);
    // And the line's answer contains it.
    const got = pure(line, extra);
    for (const entry of main) assert.ok(got.includes(entry), `${line}: ${entry} in ${got.join(" ; ")}`);
  }
});

test("the as-spelled reading is never left on: a throw, a nested reading and a promise all restore it", () => {
  assert.equal(namesReadAsSpelled(), false);
  assert.throws(
    () =>
      withNamesAsSpelled(() => {
        assert.equal(namesReadAsSpelled(), true);
        throw new Error("thrown inside");
      }),
    /thrown inside/u,
  );
  assert.equal(namesReadAsSpelled(), false);
  // The as-spelled run of a two-reading call throws: still folded after.
  assert.throws(
    () =>
      eachNameReading(() => {
        foldNameExact("APPROVAL.md");
        if (namesReadAsSpelled()) throw new Error("second reading");
        return 1;
      }),
    /second reading/u,
  );
  assert.equal(namesReadAsSpelled(), false);
  withNamesAsSpelled(() => {
    withNamesAsSpelled(() => undefined);
    assert.equal(namesReadAsSpelled(), true, "an inner reading restores the outer one");
  });
  assert.equal(namesReadAsSpelled(), false);
  assert.throws(() => withNamesAsSpelled(() => Promise.resolve(1)), /synchronously/u);
  assert.equal(namesReadAsSpelled(), false);
  // And the classifier still folds afterwards.
  assert.equal(pure("echo x > Approval.MD")[0], WRITE_CORE);
});

test("the second reading runs only where the two readings can differ", () => {
  assert.equal(eachNameReading(() => classifyCommand("echo x > notes.txt")).length, 1);
  assert.equal(eachNameReading(() => classifyCommand("echo x > .approval/log/x")).length, 1);
  assert.equal(eachNameReading(() => classifyCommand("echo x > Approval.MD")).length, 2);
  assert.equal(eachNameReading(() => classifyCommand("echo x > approval.md")).length, 2);
  assert.equal(eachNameReading(() => classifyCommand(`echo x > .claude/${LONG_S}ettings.json`)).length, 2);
  // Two equal claims (both routes), then the as-spelled reading.
  assert.equal(eachNameReading(() => classifyCommand("echo x > spec/x", OPEN_FIRST)).length, 3);
});

// ---------------------------------------------------------------------------
// Codex's two cases through the REAL hook: `approval hook claude-code` with an
// attested policy in a fixture checkout, for the Bash tool and the Write tool.
// ---------------------------------------------------------------------------

/** dist/tests/guarded-names-fold-case.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

function runCli(args: readonly string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const ran = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(ran.error, undefined, String(ran.error));
  return { code: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

const POLICY_HEAD = ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:", "  autonomy: manual", '  approval_ttl: "1h"', "  on_expiry: reject"];
const POLICY_TAIL = ["  read.*:", "    autonomy: autonomous", "  files.write.workspace:", "    autonomy: autonomous"];

/** Policy A: `policy.core` human-only, `log.mutate` autonomous. */
const POLICY_A = [...POLICY_HEAD, "classes:", ...POLICY_TAIL, "  policy.core:", "    autonomy: human-only", "  log.mutate:", "    autonomy: autonomous", "```", ""].join("\n");

/** Policy B: the two routed entries in one order, `open` autonomous and `closed` manual. */
function policyB(entries: readonly ProtectedPathEntry[]): string {
  const routed = entries.flatMap((entry) => (typeof entry === "string" ? [`  - ${entry}`] : [`  - path: ${entry.path}`, `    class: ${entry.class}`]));
  return [...POLICY_HEAD, "protected_paths:", ...routed, "classes:", ...POLICY_TAIL, "  policy.edit.open:", "    autonomy: autonomous", "  policy.edit.closed:", "    autonomy: manual", "```", ""].join("\n");
}

let labs = 0;
function attestedLab(policy: string): string {
  labs += 1;
  const dir = join(scratch, `lab-${labs}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policy);
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/** The decision the real hook gives one tool call, and its reason. */
function decide(dir: string, tool: Record<string, unknown>): { permission: string; reason: string } {
  labs += 1;
  const ran = runCli(
    ["hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fold", tool_use_id: `fold-${labs}`, cwd: dir, transcript_path: "/dev/null", ...tool }),
  );
  assert.equal(ran.code, 0, ran.stderr);
  const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
}

const bash = (command: string): Record<string, unknown> => ({ tool_name: "Bash", tool_input: { command } });
const write = (file: string): Record<string, unknown> => ({ tool_name: "Write", tool_input: { file_path: file, content: "x\n" } });

/** How strict a decision is: allow, then a manual wait that timed out, then a human-only refusal. */
function strictness(decision: { permission: string; reason: string }): number {
  if (decision.permission === "allow") return 0;
  if (decision.reason.startsWith("hook-timeout: ")) return 1;
  return 2;
}

test("codex's case 1 through the real hook: policy.core human-only, log.mutate autonomous; .approval/LOG/x is refused as main refuses it", { skip }, () => {
  const dir = attestedLab(POLICY_A);
  // Main 21fc5fdc: `hook-class-human-only: class policy.core ...` for both tools.
  for (const tool of [bash("echo x > .approval/LOG/x"), write(".approval/LOG/x")]) {
    const decision = decide(dir, tool);
    assert.equal(decision.permission, "deny", decision.reason);
    assert.match(decision.reason, /^hook-class-human-only: class policy\.core /u);
  }
  // The canonical log path keeps the policy's own answer for it.
  assert.equal(decide(dir, bash("echo x > .approval/log/x")).permission, "allow");
});

test("codex's case 2 through the real hook: colliding routed entries are never lighter than main, in both orders", { skip }, () => {
  // Main 21fc5fdc, in either order: `spec/x` waits (closed, manual) and
  // `SPEC/x` is allowed (open, autonomous).
  const MAIN: Readonly<Record<string, number>> = { "spec/x": 1, "SPEC/x": 0 };
  for (const entries of [OPEN_FIRST, CLOSED_FIRST]) {
    const dir = attestedLab(policyB(entries));
    for (const target of ["spec/x", "SPEC/x"]) {
      for (const tool of [bash(`echo x > ${target}`), write(target)]) {
        const decision = decide(dir, tool);
        assert.ok(
          strictness(decision) >= (MAIN[target] ?? 2),
          `${JSON.stringify(entries)} ${JSON.stringify(tool)}: ${decision.permission} ${decision.reason}`,
        );
        if (target === "spec/x") assert.match(decision.reason, /policy\.edit\.closed/u);
      }
    }
  }
});

test("a Codex apply_patch target keeps every class either reading gives it", () => {
  const root = join(scratch, "patch");
  mkdirSync(root, { recursive: true });
  const parsed = parseApplyPatch(["*** Begin Patch", "*** Add File: .approval/LOG/x", "+x", "*** End Patch"].join("\n"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const classified = classifyApplyPatch(parsed, root);
  assert.equal(classified.ok, true, classified.ok ? "" : classified.detail);
  if (!classified.ok) return;
  assert.deepEqual(classified.classes, ["log.mutate", "policy.core"]);
});

// ---------------------------------------------------------------------------
// The Hermes-home walk is linear (the lead's S2 on #688), and answers as the
// per-segment walk did.
// ---------------------------------------------------------------------------

/** The per-segment walk the linear one replaced (main 21fc5fdc's `hermesTailClass` and `maybeHomeTails`), as the oracle. */
function oldTailClass(tail: readonly string[], judge: (tail: readonly string[]) => string | null): string | null {
  const answers = [judge(tail)];
  const resolved: string[] = [];
  let escaped = false;
  for (const part of tail) {
    if (part === "..") {
      if (resolved.length === 0) {
        escaped = true;
        break;
      }
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  if (!escaped && tail.includes("..")) answers.push(judge(resolved));
  for (const strictest of ["policy.core", "cron.manage", "credential"]) if (answers.includes(strictest)) return strictest;
  return null;
}

function oldMaybeTails(tail: readonly string[]): (readonly string[])[] {
  const tails: (readonly string[])[] = [tail];
  for (const [at, part] of tail.entries()) if (part === "..") tails.push(tail.slice(at + 1));
  return tails;
}

/** The two judges, as the classifier has them in the folded reading (they read four segments at most). */
function profileTail(tail: readonly string[]): readonly string[] {
  const first = tail[0];
  return first !== undefined && foldFileName(first) === "profiles" && tail[1] !== undefined ? tail.slice(2) : tail;
}
function organJudge(full: readonly string[]): string | null {
  const tail = profileTail(full);
  const next = tail[0] === undefined ? undefined : foldFileName(tail[0]);
  if (
    next === undefined || next === "config.yaml" || next === "config.yml" || next === "agent-hooks" || next === "approval" ||
    next === ".env" || next.startsWith(".env.") || next === "auth.json" || next.startsWith("shell-hooks-allowlist.json") ||
    next.startsWith("hooks") || next === "hermes-agent" || next === "plugins" || next === ".op.env" || next.startsWith(".op.env.")
  ) return "policy.core";
  return next === "scripts" ? "cron.manage" : null;
}
function credentialJudge(full: readonly string[]): string | null {
  const tail = profileTail(full);
  const next = tail[0] === undefined ? undefined : foldFileName(tail[0]);
  if (next === undefined) return null;
  if (next === ".env" || next.startsWith(".env.") || next === "auth.json" || next === ".op.env" || next.startsWith(".op.env.")) return "credential";
  if (next !== "hermes-agent") return null;
  const file = tail[1] === undefined ? undefined : foldFileName(tail[1]);
  return file !== undefined && (file === ".env" || (file.startsWith(".env.") && tail[1] !== ".env.example")) ? "credential" : null;
}

test("the linear Hermes walk answers every tail as the per-segment walk did (seeded fuzz)", () => {
  let seed = 688;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const NAMES = [
    ".hermes", "$HERMES_HOME", "$X", "..", "..", "..", "profiles", "p", "config.yaml", "agent-hooks", "approval", ".env",
    ".env.example", "auth.json", ".op.env", "shell-hooks-allowlist.json.lock", "hooks", "hermes-agent", "plugins", "scripts", "x", "workspace",
  ];
  let checked = 0;
  for (let round = 0; round < 3000; round += 1) {
    const segments = Array.from({ length: 1 + Math.floor(next() * 12) }, () => NAMES[Math.floor(next() * NAMES.length)] as string);
    const tails = hermesTails(segments);
    for (let start = 0; start <= segments.length; start += 1) {
      const tail = segments.slice(start);
      const want = [
        tail.includes(".."),
        oldTailClass(tail, organJudge),
        oldMaybeTails(tail).some((each) => each.length > 0 && oldTailClass(each, organJudge) === "policy.core"),
        oldTailClass(tail, credentialJudge) !== null,
        oldMaybeTails(tail).some((each) => oldTailClass(each, credentialJudge) !== null),
      ];
      const got = [tails.dotdotFrom(start), tails.organClass(start), tails.maybeOrgan(start), tails.credential(start), tails.maybeCredential(start)];
      assert.deepEqual(got, want, `${segments.join("/")} from ${start}`);
      checked += 1;
    }
  }
  assert.ok(checked > 10_000);
});

test("a long path of Hermes homes costs about what a same-length ordinary path costs", () => {
  // A ratio, not a fixed bound: CI's runner is several times slower than a
  // laptop. The per-segment walk cost the square of the length here (seconds
  // at this size); the linear one is a few times the control at most.
  const SIZE = 256 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const cpu = (run: () => void): number => {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1e6;
  };
  const judge = (word: string): void => {
    protectedPathClasses(word);
    isCredentialPath(word);
    classifyCommand(`echo x > ${word}`);
  };
  const control = cpu(() => judge(`${fill(".hermez/x/")}.env`));
  // `$X/../` is the shape that took one tail slice per `..` before the walk
  // was linear: the square of the length in memory as well as time.
  for (const unit of [".hermes/x/", ".HERMES/x/", `.herme${LONG_S}/x/`, "$X/x/", "$X/../"]) {
    for (const end of [".env", "../.env"]) {
      const word = `${fill(unit)}${end}`;
      const spent = cpu(() => judge(word));
      assert.ok(spent <= 8 * control + 1, `${unit}…${end}: ${spent.toFixed(3)} s against a control of ${control.toFixed(3)} s`);
    }
  }
});

// ---------------------------------------------------------------------------
// HFS+ ignores some code points inside a name (the lead's S1 on #688),
// measured on an HFS+ image: U+200C..U+200F, U+202A..U+202E, U+206A..U+206F
// and U+FEFF, and no other code point from U+0080 up.
// ---------------------------------------------------------------------------

test("foldFileName drops the code points HFS+ ignores, each range whole, and nothing beside them", () => {
  const RANGES: readonly (readonly [number, number])[] = [
    [0x200c, 0x200f],
    [0x202a, 0x202e],
    [0x206a, 0x206f],
    [0xfeff, 0xfeff],
  ];
  for (const [from, to] of RANGES) {
    for (let cp = from; cp <= to; cp += 1) {
      const ch = String.fromCodePoint(cp);
      assert.equal(foldFileName(`APPRO${ch}VAL.md`), "approval.md", `U+${cp.toString(16)}`);
      assert.equal(foldFileName(`${ch}.approval${ch}`), ".approval", `U+${cp.toString(16)} at the ends`);
    }
    // The neighbours stay: HFS+ opens them as other names.
    for (const cp of [from - 1, to + 1]) {
      assert.notEqual(foldFileName(`APPRO${String.fromCodePoint(cp)}VAL.md`), "approval.md", `U+${cp.toString(16)}`);
    }
  }
  // A name made only of them folds to the empty name, which no guarded name is.
  assert.equal(foldFileName("‍﻿"), "");
  assert.equal(protectedPathClass("‍"), null);
});

test("HFS+ spellings of a guarded name take the canonical class, beside main's class", () => {
  for (const [command, canonical] of [
    ["echo x > APPRO‍VAL.md", "echo x > APPROVAL.md"],
    ["echo x > APPROVAL.md﻿", "echo x > APPROVAL.md"],
    ["echo x > .appro‍val/env", "echo x > .approval/env"],
    ["rm -rf .appro‍val", "rm -rf .approval"],
  ] as const) {
    const want = pure(canonical);
    assert.equal(pure(command)[0], want[0], command);
    assert.deepEqual(pure(command), union(want, spelledPure(command)), command);
  }
  assert.deepEqual(pure("echo x > APPRO‍VAL.md"), [WRITE_CORE, "files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// The route floor reads a policy entry as spelled (the lead's S3 on #688): no
// policy that loads on main fails to load here.
// ---------------------------------------------------------------------------

function routedPolicy(path: string): string {
  return [...POLICY_HEAD, "protected_paths:", `  - path: ${path}`, "    class: policy.edit.mine", "classes:", ...POLICY_TAIL, "  policy.edit.mine:", "    autonomy: autonomous", "```", ""].join("\n");
}

test("a routed entry spelled like a built-in path in another case loads, and its route never lightens that path", () => {
  for (const path of [".APPROVAL/x", "Approval.md", ".Claude/settings.json"]) {
    labs += 1;
    const file = join(scratch, `routed-${labs}.md`);
    writeFileSync(file, routedPolicy(path));
    const loaded = loadPolicy({ file });
    assert.equal(loaded.ok, true, loaded.ok ? "" : `${loaded.code}: ${loaded.message}`);
    assert.equal(protectedRouteSpellingNotes(loaded).length, 1, path);
  }
  // The canonical spelling is refused, as on main.
  const file = join(scratch, "routed-canonical.md");
  writeFileSync(file, routedPolicy(".approval/x"));
  const refused = loadPolicy({ file });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.code, "protected-route-floor");
  // A command aimed at the spelled path keeps main's class (the route, as
  // spelled) and takes the folded built-in class first.
  const extra: ProtectedPathEntry[] = [{ path: ".APPROVAL/x", class: "policy.edit.mine" }];
  assert.deepEqual(spelledPure("echo x > .APPROVAL/x", extra), ["policy.edit.mine redirect-protected"]);
  assert.deepEqual(pure("echo x > .APPROVAL/x", extra), [WRITE_CORE, "policy.edit.mine redirect-protected"]);
  assert.deepEqual(pure("echo x > .approval/x", extra), [WRITE_CORE]);
});

test("a route that names a built-in policy.edit path only in another case never re-labels it (review S1 on #688)", () => {
  // The load floor reads an entry as spelled, so it never judged this route;
  // main let `.GitHub/workflows/ci.yml` through as the routed class alone,
  // and APFS opens that as the workflow file.
  const EDIT = "policy.edit redirect-protected";
  const CI = "policy.edit.ci redirect-protected";
  const ci: ProtectedPathEntry[] = [{ path: ".GitHub/workflows/", class: "policy.edit.ci" }];
  assert.deepEqual(spelledPure("echo x > .GitHub/workflows/ci.yml", ci), [CI]);
  for (const target of [".GitHub/workflows/ci.yml", ".github/workflows/ci.yml", "sub/.GitHub/workflows/a/b.yml"]) {
    assert.deepEqual(pure(`echo x > ${target}`, ci), [EDIT, CI], target);
    assert.deepEqual(protectedPathClasses(target, ci), ["policy.edit", "policy.edit.ci"], target);
  }
  // A third spelling was an ordinary write on main, and keeps that class too.
  assert.deepEqual(pure("echo x > .GITHUB/Workflows/ci.yml", ci), [EDIT, CI, "files.write.workspace redirect-write"]);
  // A protected file name in another case, and a deeper entry under the folder.
  const prose: ProtectedPathEntry[] = [{ path: "Claude.md", class: "policy.edit.prose" }];
  for (const target of ["Claude.md", "CLAUDE.md", "docs/claude.md"]) {
    assert.deepEqual(protectedPathClasses(target, prose), ["policy.edit", "policy.edit.prose"], target);
  }
  const deep: ProtectedPathEntry[] = [{ path: ".GitHub/workflows/release/", class: "policy.edit.release" }];
  assert.deepEqual(protectedPathClasses(".github/workflows/release/x.yml", deep), ["policy.edit", "policy.edit.release"]);
  assert.deepEqual(protectedPathClasses(".github/workflows/ci.yml", deep), ["policy.edit"]);
  // The canonical spelling is the floor's to judge at load, so its route
  // answers alone, as on main.
  const canonical: ProtectedPathEntry[] = [{ path: ".github/workflows/", class: "policy.edit.ci" }];
  assert.deepEqual(protectedPathClasses(".github/workflows/ci.yml", canonical), ["policy.edit.ci"]);
  assert.deepEqual(protectedPathClasses(".GitHub/workflows/ci.yml", canonical), ["policy.edit.ci"]);
  // Tied with a judged route, the unjudged one still brings the built-in class.
  assert.deepEqual(protectedPathClasses(".github/workflows/ci.yml", [...canonical, { path: ".GitHub/workflows/", class: "policy.edit.other" }]), [
    "policy.edit",
    "policy.edit.ci",
    "policy.edit.other",
  ]);
  // A route on a path the runtime does not protect is not touched.
  const design: ProtectedPathEntry[] = [{ path: "Design/", class: "policy.edit.design" }];
  assert.deepEqual(protectedPathClasses("design/x.md", design), ["policy.edit.design"]);
});

/** `.GitHub/workflows/` routed to a class the policy runs unattended; `policy.edit` itself is manual (the default). */
const POLICY_CI = [...POLICY_HEAD, "protected_paths:", "  - path: .GitHub/workflows/", "    class: policy.edit.ci", "classes:", ...POLICY_TAIL, "  policy.edit.ci:", "    autonomy: autonomous", "```", ""].join("\n");

test("through the real hook, a workflow write still asks under a policy that routes .GitHub/workflows/ to an unattended class", { skip }, () => {
  // The policy loads, as on main (the floor reads the entry as spelled).
  const dir = attestedLab(POLICY_CI);
  for (const target of [".GitHub/workflows/ci.yml", ".github/workflows/ci.yml"]) {
    for (const tool of [bash(`echo x > ${target}`), write(target)]) {
      const decision = decide(dir, tool);
      assert.equal(strictness(decision), 1, `${JSON.stringify(tool)}: ${decision.permission} ${decision.reason}`);
      assert.match(decision.reason, /:policy\.edit within /u, decision.reason);
    }
  }
  const checked = runCli(["policy", "check", "files.write.workspace"], dir);
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(
    checked.stdout,
    /note: protected_paths entry "\.GitHub\/workflows\/" names a built-in policy\.edit path in another spelling; the built-in class always applies to that path, and the route to "policy\.edit\.ci" is judged beside it and can only make the answer stricter\./u,
  );
});

test("through the real hook, two routes that differ only by case give the stricter decision for every spelling, in both orders", { skip }, () => {
  for (const entries of [OPEN_FIRST, CLOSED_FIRST]) {
    const dir = attestedLab(policyB(entries));
    for (const target of ["spec/x", "SPEC/x", "Spec/x"]) {
      for (const tool of [bash(`echo x > ${target}`), write(target)]) {
        const decision = decide(dir, tool);
        assert.equal(strictness(decision), 1, `${JSON.stringify(entries)} ${JSON.stringify(tool)}: ${decision.permission} ${decision.reason}`);
        assert.match(decision.reason, /policy\.edit\.closed/u);
      }
    }
  }
});

test("under such a policy the real hook answers an ordinary write as main does, and policy check names the entry", { skip }, () => {
  for (const path of [".APPROVAL/x", "Approval.md", ".Claude/settings.json"]) {
    const dir = attestedLab(routedPolicy(path));
    const decision = decide(dir, bash("echo x > a.txt"));
    assert.equal(decision.permission, "allow", `${path}: ${decision.reason}`);
    const checked = runCli(["policy", "check", "files.write.workspace"], dir);
    assert.equal(checked.code, 0, checked.stderr);
    assert.match(checked.stdout, new RegExp(`note: protected_paths entry "${path.replace(/[.]/gu, "\\.")}" names a built-in policy\\.core path in another spelling; the built-in class answers that path, and the route to "policy\\.edit\\.mine" never lightens it\\.`, "u"));
  }
});

// ---------------------------------------------------------------------------
// Every protected target of a segment is judged (review-b's FINDING on main,
// the lead's ruling: one command writing two routed paths was judged by the
// first named only).
// ---------------------------------------------------------------------------

/** The shape of this repository's own entries: design docs light, CI strict. */
const TWO_ROUTES: ProtectedPathEntry[] = [
  { path: "SPEC.md", class: "policy.edit.spec" },
  { path: "design/", class: "policy.edit.design" },
  { path: ".github/workflows/", class: "policy.edit.ci" },
];

test("a segment that writes two protected paths reports both classes, in either order, for every verb", () => {
  const DESIGN = "policy.edit.design protected-path";
  const CI = "policy.edit.ci protected-path";
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["tee design/x .github/workflows/ci.yml", [DESIGN, CI]],
    ["tee .github/workflows/ci.yml design/x", [CI, DESIGN]],
    ["cp design/x .github/workflows/ci.yml", [DESIGN, CI]],
    ["cp .github/workflows/ci.yml design/x", [CI, DESIGN]],
    ["cp a design/x .github/workflows/", [DESIGN, CI]],
    ["cp -t .github/workflows/ design/x", [CI, DESIGN]],
    ["mv design/x .github/workflows/ci.yml", [DESIGN, CI]],
    ["mv .github/workflows/ci.yml design/x", [CI, DESIGN]],
    ["ln design/x .github/workflows/ci.yml", [DESIGN, CI]],
    // Two write redirections, and a writer in front of a redirection.
    ["echo x > design/a > .github/workflows/ci.yml", ["policy.edit.design redirect-protected", "policy.edit.ci redirect-protected"]],
    ["echo x > .github/workflows/ci.yml >> design/a", ["policy.edit.ci redirect-protected", "policy.edit.design redirect-protected"]],
    ["tee .github/workflows/ci.yml > design/x", ["policy.edit.design redirect-protected", CI]],
    ["tee design/x > .github/workflows/ci.yml", ["policy.edit.ci redirect-protected", DESIGN]],
    ["tee SPEC.md .github/workflows/ci.yml > design/x", ["policy.edit.design redirect-protected", "policy.edit.spec protected-path", CI]],
    // An input redirection stands in for a named argument.
    ["node x.js design/x < .github/workflows/ci.yml", [DESIGN, CI]],
    // One word that brace expansion makes two files of.
    ["tee {design/x,.github/workflows/ci.yml}", [DESIGN, CI]],
    // Its classes come strictest rank first, whatever order the files are
    // written in, so the first is the one class main gave the word.
    ["tee {CLAUDE.md,APPROVAL.md}", ["policy.core protected-path", "policy.edit protected-path"]],
    ["tee {design/x,CLAUDE.md,.approval/log/x}", ["log.mutate protected-path", DESIGN, "policy.edit protected-path"]],
    // A download's outputs.
    ["curl -o design/x -o .github/workflows/ci.yml https://e.example/a https://e.example/b", [DESIGN, CI]],
    // A copy whose destination the text cannot know keeps `policy.core` first.
    ["cp $X design/x .github/workflows/ci.yml", ["policy.core copy-target-unknown", DESIGN, CI]],
    // The classifier's own precedence still names the segment; nothing is dropped.
    ["tee design/x SPEC.md .github/workflows/ci.yml APPROVAL.md", ["policy.core protected-path", DESIGN, "policy.edit.spec protected-path", CI]],
    ["tee design/x CLAUDE.md", [DESIGN, "policy.edit protected-path"]],
    ["tee design/x .approval/log/x", ["log.mutate protected-path", DESIGN]],
    ["git add SPEC.md design/x", ["policy.edit.spec protected-path", DESIGN]],
    ["rm design/x SPEC.md", [DESIGN, "policy.edit.spec protected-path"]],
  ];
  for (const [line, want] of cases) {
    assert.deepEqual(pure(line, TWO_ROUTES), want, line);
    // As spelled, the one class main gave answers alone.
    assert.deepEqual(spelledPure(line, TWO_ROUTES), [want[0]], line);
  }
  // A credential read that a protected path outranks rides beside it, as it
  // did, and the other protected class follows.
  assert.deepEqual(pure("cp .approval/env APPROVAL.md design/x", TWO_ROUTES), [
    "policy.core protected-path",
    "account.credential credential-path",
    DESIGN,
  ]);
  assert.deepEqual(spelledPure("cp .approval/env APPROVAL.md design/x", TWO_ROUTES), [
    "policy.core protected-path",
    "account.credential credential-path",
  ]);
  // Each further class names the word that takes it.
  const classified = classifyCommand("tee design/x .github/workflows/ci.yml", TWO_ROUTES);
  assert.equal(classified.ok, true);
  if (classified.ok) {
    assert.deepEqual(classified.segments.map((segment) => segment.path), ["design/x", ".github/workflows/ci.yml"]);
    assert.deepEqual(classified.segments.map((segment) => segment.text), ["tee design/x .github/workflows/ci.yml", "tee design/x .github/workflows/ci.yml"]);
    assert.deepEqual(classified.classes, ["policy.edit.design", "policy.edit.ci"]);
  }
});

test("a segment with one protected class, or none the classifier scans, answers as it did", () => {
  const DESIGN = "policy.edit.design protected-path";
  for (const [line, want] of [
    ["tee design/x design/y", [DESIGN]],
    ["tee design/x notes.txt", [DESIGN]],
    // A reader's arguments are not targets: only the redirection is a write.
    ["cat .github/workflows/ci.yml > design/x", ["policy.edit.design redirect-protected"]],
    ["grep foo SPEC.md >> design/notes.md", ["policy.edit.design redirect-protected"]],
    ["cat design/x .github/workflows/ci.yml", ["read.shell read-shell"]],
    // A download's URL is not a target, whatever its last segment spells.
    ["curl -o design/x https://e.example/SPEC.md", [DESIGN]],
    // Each segment of a line keeps its own answer.
    ["tee design/x; tee .github/workflows/ci.yml", [DESIGN, "policy.edit.ci protected-path"]],
  ] as const) {
    assert.deepEqual(pure(line, TWO_ROUTES), want, line);
    assert.deepEqual(spelledPure(line, TWO_ROUTES), want, line);
  }
});

test("two targets that each have tied routes report every class of both", () => {
  const extra: ProtectedPathEntry[] = [
    ...OPEN_FIRST,
    { path: "a/b/", class: "policy.edit.ab" },
    { path: "c/d/", class: "policy.edit.cd" },
  ];
  const all = ["policy.edit.open", "policy.edit.closed", "policy.edit.ab", "policy.edit.cd"];
  const classes = (line: string): string[] => {
    const classified = classifyCommand(line, extra);
    return classified.ok ? [...classified.classes].sort() : [`refused ${classified.code}`];
  };
  for (const line of [
    "touch spec/x a/b/c/d/y",
    "touch a/b/c/d/y spec/x",
    "tee {spec/x,a/b/c/d/y}",
    "tee {a/b/c/d/y,spec/x}",
    "echo x > spec/x > a/b/c/d/y",
    "tee spec/x > a/b/c/d/y",
  ]) {
    assert.deepEqual(classes(line), [...all].sort(), line);
  }
  // One word of two expansions is one path class as spelled, as on main.
  assert.deepEqual(spelledPure("tee {spec/x,a/b/c/d/y}", extra), ["policy.edit.closed protected-path"]);
  assert.deepEqual(protectedPathClasses("{spec/x,a/b/c/d/y}", extra).sort(), [...all].sort());
});

test("equalClaims and foldedOnly: all claims folded; the first, or none, as spelled", () => {
  assert.deepEqual(equalClaims(["a", "b"]), ["a", "b"]);
  assert.deepEqual(withNamesAsSpelled(() => equalClaims(["a", "b"])), ["a"]);
  assert.deepEqual(withNamesAsSpelled(() => equalClaims([])), []);
  assert.deepEqual(foldedOnly(() => ["a"]), ["a"]);
  let made = 0;
  assert.deepEqual(withNamesAsSpelled(() => foldedOnly(() => { made += 1; return ["a"]; })), []);
  assert.equal(made, 0, "as spelled the other answers are not even computed");
});

/** `design/` runs unattended, the workflow folder is a tap; the shape of the repository's own policy. */
const POLICY_TWO_ROUTES = [
  ...POLICY_HEAD,
  "protected_paths:",
  "  - { path: design/, class: policy.edit.design }",
  "  - { path: .github/workflows/, class: policy.edit.ci }",
  "classes:",
  ...POLICY_TAIL,
  "  policy.edit.design:",
  "    autonomy: autonomous",
  "  policy.edit.ci:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

test("through the real hook, a command that writes a design file and a workflow waits for the workflow's tap, in either order", { skip }, () => {
  const dir = attestedLab(POLICY_TWO_ROUTES);
  for (const command of [
    "tee design/x .github/workflows/ci.yml",
    "tee .github/workflows/ci.yml design/x",
    "cp design/x .github/workflows/ci.yml",
    "mv design/x .github/workflows/ci.yml",
    "echo x > design/a > .github/workflows/ci.yml",
    "tee .github/workflows/ci.yml > design/x",
    "tee {design/x,.github/workflows/ci.yml}",
  ]) {
    const decision = decide(dir, bash(command));
    assert.equal(strictness(decision), 1, `${command}: ${decision.permission} ${decision.reason}`);
    assert.match(decision.reason, /:policy\.edit\.ci within /u, command);
  }
  // One class, or a reader in front of the redirection: unattended, as before.
  for (const command of ["tee design/x design/y", "cat .github/workflows/ci.yml > design/x"]) {
    const decision = decide(dir, bash(command));
    assert.equal(decision.permission, "allow", `${command}: ${decision.reason}`);
  }
});

test("a segment with a protected redirection is walked once: it costs about what it costs without the redirection", () => {
  // The command in front of a protected redirection is asked for its own
  // answer. That is the walk every segment takes, made once. A ratio of CPU
  // time, like the tests around it, over 1 MiB of plain words. Measured five
  // times each: with one walk the line costs 0.59 to 0.73 of the control;
  // with the walk made twice, 1.04 to 1.34. The bound sits between, and each
  // side is the least of three runs, so one slow run does not decide it.
  const SIZE = 1024 * 1024;
  const words = "x ".repeat(SIZE / 2);
  const cpu = (run: () => void): number => {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1e6;
  };
  const least = (run: () => void): number => Math.min(cpu(run), cpu(run), cpu(run));
  const control = least(() => classifyCommand(`tee design/x ${words}`, TWO_ROUTES));
  const spent = least(() => classifyCommand(`tee design/x ${words}> .github/workflows/ci.yml`, TWO_ROUTES));
  assert.ok(spent <= 0.9 * control, `${spent.toFixed(3)} s against a control of ${control.toFixed(3)} s`);
  assert.deepEqual(pure(`tee design/x ${"x ".repeat(8)}> .github/workflows/ci.yml`, TWO_ROUTES), [
    "policy.edit.ci redirect-protected",
    "policy.edit.design protected-path",
  ]);
});

// ---------------------------------------------------------------------------
// The placeholder a `$(…)` leaves in a word is not a name: it is not folded,
// and a word that differs from its folded form only there runs one reading.
// ---------------------------------------------------------------------------

test("the fold leaves the substitution placeholder as it is, and folds the text around it", () => {
  const S = SUBSTITUTION_SENTINEL;
  assert.notEqual(S.toLowerCase(), S, "the placeholder has capitals, which is why this matters");
  assert.equal(foldFileName(S), S);
  assert.equal(foldFileName(`Approval${S}.MD`), `approval${S}.md`);
  assert.equal(foldFileName(`${S}${S}X${S}`), `${S}${S}x${S}`);
  assert.equal(foldFileName(foldFileName(`A${S}${LONG_S}`)), foldFileName(`A${S}${LONG_S}`));
  // Text that merely resembles it is folded like any other.
  assert.equal(foldFileName("${__APPROVAL_SUBST_}"), "${__approval_subst_}");
});

test("a word with a substitution runs one reading unless a name in it folds, and its answers are unmoved", () => {
  const readings = (command: string): number => eachNameReading(() => classifyCommand(command)).length;
  // Only the placeholder would differ: one reading. Each of these ran two.
  for (const command of [
    'echo x > "$(echo a)"',
    "echo x > .approval/$(echo a)",
    "echo x > .git/$(echo a)",
    'git push origin "$(echo main)"',
    "cat $(echo a)/.env",
    "cat .approval/$(echo a)",
  ]) {
    assert.equal(readings(command), 1, command);
  }
  // A name beside the substitution that does fold still runs both.
  assert.equal(readings("echo x > .APPROVAL/$(echo a)"), 2);
  assert.equal(readings("echo x > Approval.MD$(echo a)"), 2);
  // The answers, in both readings, are what they were.
  for (const [command, want] of [
    ['echo x > "$(echo a)"', ["files.write.workspace redirect-write"]],
    ["echo x > .approval/$(echo a)", [WRITE_CORE]],
    ["echo x > .APPROVAL/$(echo a)", [WRITE_CORE, "files.write.workspace redirect-write"]],
    ["cat $(echo a)/.env", ["account.credential credential-path"]],
  ] as const) {
    assert.deepEqual(pure(command), want, command);
  }
  assert.deepEqual(spelledPure("echo x > .APPROVAL/$(echo a)"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(spelledPure("echo x > .approval/$(echo a)"), [WRITE_CORE]);
});

test("a line of many folded segments costs about what the same line spelled canonically costs", () => {
  // Both readings run on the folded line and their segments are joined; the
  // join is keyed, so it stays linear in the number of segments. A ratio, for
  // the same reason as the Hermes test above. 1 MiB: a scanning join stays
  // cheap below about 10,000 segments and costs tens of seconds here.
  const SIZE = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE - 40);
  const cpu = (run: () => void): number => {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1e6;
  };
  const control = cpu(() => classifyCommand(fill("echo x > .cursor/hooks.json; ")));
  const spent = cpu(() => classifyCommand(fill(`echo x > .Cursor/hoo${KELVIN}s.json; `)));
  assert.ok(spent <= 8 * control + 1, `${spent.toFixed(3)} s against a control of ${control.toFixed(3)} s`);
});
