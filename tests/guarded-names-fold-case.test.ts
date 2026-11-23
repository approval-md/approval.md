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
 * Every guarded-name compare now goes through one helper, `foldFileName`. These
 * tests hold the helper to the measured table, and hold every spelling of every
 * guarded name to the class and rule its canonical spelling takes, pure and
 * through the hook. Controls that only contain a guarded name do not move.
 *
 * Hermetic: HOME is a fixture directory; git runs only to make a checkout, and
 * no line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import {
  classifyCommand,
  isCredentialPath,
  isGateOrganPath,
  isSkillScriptPath,
  protectedPathClass,
  type ProtectedPathEntry,
} from "../src/core/command-class.js";
import { foldFileName } from "../src/core/name-fold.js";

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
  // a fullwidth letter, a zero-width joiner.
  assert.notEqual(foldFileName("İ"), "i");
  assert.notEqual(foldFileName("ａpproval.md"), "approval.md");
  assert.notEqual(foldFileName("ap‍proval.md"), "approval.md");
});

/**
 * One row per guarded name: the canonical spelling, the class a write and a
 * read of it take, and the spellings that must take the same. Every row is
 * also removed with `rm -rf`, which is how a directory row is written.
 */
interface Row {
  readonly path: string;
  readonly write: string;
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
  { path: ".approval", write: WRITE_CORE, read: READ, spellings: [".APPROVAL", ".Approval"] },
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

test("every spelling of a guarded name takes the canonical spelling's class and rule, pure", () => {
  for (const row of ROWS) {
    assert.deepEqual(pure(`echo x > ${row.path}`), [row.write], `canonical write ${row.path}`);
    assert.deepEqual(pure(`cat ${row.path}`), [row.read], `canonical read ${row.path}`);
    const canonical = {
      write: pure(`echo x > ${row.path}`),
      append: pure(`echo x >> ${row.path}`),
      remove: pure(`rm -rf ${row.path}`),
      read: pure(`cat ${row.path}`),
    };
    for (const spelled of row.spellings) {
      assert.notEqual(spelled, row.path);
      assert.deepEqual(pure(`echo x > ${spelled}`), canonical.write, `write ${spelled}`);
      assert.deepEqual(pure(`echo x >> ${spelled}`), canonical.append, `append ${spelled}`);
      assert.deepEqual(pure(`rm -rf ${spelled}`), canonical.remove, `rm -rf ${spelled}`);
      assert.deepEqual(pure(`cat ${spelled}`), canonical.read, `read ${spelled}`);
      assert.deepEqual(pure(`echo x > a/b/${spelled.replace(/^~\//u, "")}`), pure(`echo x > a/b/${row.path.replace(/^~\//u, "")}`), `nested ${spelled}`);
    }
  }
});

test("every spelling of a guarded name takes the canonical spelling's class and rule, through the hook", { skip }, () => {
  for (const row of ROWS) {
    const canonical = {
      write: hook(`echo x > ${row.path}`),
      remove: hook(`rm -rf ${row.path}`),
      read: hook(`cat ${row.path}`),
    };
    assert.notDeepEqual(canonical.write, ["files.write.workspace redirect-write"], `canonical write ${row.path}`);
    for (const spelled of row.spellings) {
      assert.deepEqual(hook(`echo x > ${spelled}`), canonical.write, `hook write ${spelled}`);
      assert.deepEqual(hook(`rm -rf ${spelled}`), canonical.remove, `hook rm -rf ${spelled}`);
      assert.deepEqual(hook(`cat ${spelled}`), canonical.read, `hook read ${spelled}`);
    }
  }
});

test("the brief's examples are guarded, not ordinary writes", () => {
  for (const [command, expected] of [
    ["echo x > Approval.MD", WRITE_CORE],
    ["echo x > approval.md", WRITE_CORE],
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
    assert.deepEqual(pure(command), [expected], command);
  }
});

test("the guard functions fold: protectedPathClass, isCredentialPath, isGateOrganPath", () => {
  assert.equal(protectedPathClass(".APPROVAL/log/x"), "log.mutate");
  assert.equal(protectedPathClass("Approval.MD"), "policy.core");
  assert.equal(protectedPathClass(`.claude/${LONG_S}ettings.json`), "policy.core");
  assert.equal(protectedPathClass("Agents.md"), "policy.edit");
  assert.equal(protectedPathClass(".GITHUB/WORKFLOWS/x.yml"), "policy.edit");
  assert.equal(isCredentialPath(`~/.herme${LONG_S}/auth.json`), true);
  assert.equal(isCredentialPath(`.approval/key${LONG_S}`), true);
  // An organ is attested by content; the policy file and the approval home
  // never are, in any spelling. The exclusions fold with the class.
  assert.equal(isGateOrganPath(".claude/settings.json"), true);
  assert.equal(isGateOrganPath(".Claude/Settings.json"), true);
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
  assert.deepEqual(pure("echo x > Design/notes.md", extra), [WRITE_EDIT]);
  assert.deepEqual(pure("echo x > design/notes.md", extra), [WRITE_EDIT]);
  // Not a looser match: a name that only contains the entry does not move.
  assert.equal(protectedPathClass("designs/x.md", extra), null);
  assert.equal(protectedPathClass("docs/frozen.md.bak", extra), null);
});

test("a policy-declared protected entry matches in another case through the hook", { skip }, () => {
  const extra: ProtectedPathEntry[] = ["design/"];
  assert.deepEqual(hook("echo x > Design/notes.md", extra), hook("echo x > design/notes.md", extra));
  assert.notDeepEqual(hook("echo x > Design/notes.md", extra), ["files.write.workspace redirect-write"]);
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

test("the hook's on-disk passes fold: a home or key folder that exists, spelled with the long s", { skip }, () => {
  // The hook also reads the disk: a recursive read's root, a glob's
  // directory, a `cd` target. Made-up files stand in a fixture home and
  // checkout; each line is classified, never run. APFS opens `.herme<U+017F>`
  // as `.hermes`, so each spelling takes the canonical line's answer, and that
  // answer names the credential the disk pass found.
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
  try {
    for (const [canonical, spelled] of [
      ["grep -r x ~/.hermes", `grep -r x ~/.herme${LONG_S}`],
      ["cat ~/.hermes/*", `cat ~/.herme${LONG_S}/*`],
      ["cd ~/.hermes && cat .env", `cd ~/.herme${LONG_S} && cat .env`],
      ["tar cf - ~/.hermes", `tar cf - ~/.herme${LONG_S}`],
      ["cp -r ~/.hermes /tmp/x", `cp -r ~/.herme${LONG_S} /tmp/x`],
      ["cd .approval/keys && cat k1", `cd .approval/key${LONG_S} && cat k1`],
      // Each of the next five is decided by one compare of the hook alone
      // (found by planting `toLowerCase()` back in each, one at a time): the
      // read root's kind, the folder that holds a credential, the approval
      // home's file names, the Hermes home and a credential file's name under
      // an unresolved directory.
      ["grep -r x .hermes", `grep -r x .herme${LONG_S}`],
      ["grep -r x ~/.hermes/sub", `grep -r x ~/.herme${LONG_S}/sub`],
      ["cat $H/keys", `cat $H/key${LONG_S}`],
      ["cat $X/.hermes/$F", `cat $X/.herme${LONG_S}/$F`],
      ["cat $X/y/auth.json", `cat $X/y/auth.j${LONG_S}on`],
    ] as const) {
      const want = hook(canonical);
      assert.ok(want.includes(RESOLVED), `${canonical}: ${want.join(" ; ")}`);
      assert.deepEqual(hook(spelled), want, spelled);
    }
  } finally {
    rmSync(join(HOME, ".hermes"), { recursive: true, force: true });
    rmSync(join(dir, ".approval"), { recursive: true, force: true });
    rmSync(join(dir, ".hermes"), { recursive: true, force: true });
  }
});

test("git ref names fold as file names: trunk and tag spellings", () => {
  assert.deepEqual(pure(`git push origin ma${LONG_S}ter`), pure("git push origin master"));
  assert.deepEqual(pure(`git push origin ma${LIGATURE_ST}er`), pure("git push origin master"));
  assert.deepEqual(pure(`git push origin lane:refs/head${LONG_S}/main`), pure("git push origin lane:refs/heads/main"));
  assert.deepEqual(pure(`git push origin tag${LONG_S}/v1`), pure("git push origin tags/v1"));
  assert.notDeepEqual(pure("git push origin master"), pure("git push origin lane"));
});
