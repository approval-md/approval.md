#!/usr/bin/env bun
/**
 * Refresh the pinned overlay recipe corpus (0.4.7, EDGEOS-BLOCK, brief item D).
 *
 * The corpus is what `scripts/overlay-recipes-check.mjs` runs through
 * `classifyForHook` before a release: every shell recipe the overlay
 * (Edge-City/agentvillage) ships to its agents, extracted the way the overlay's
 * own EDGEOS-BLOCK test extracts them (`scripts/tests/fetch-url-shape.test.ts`,
 * `agentFacingRecipes` and `recipesIn`, added by agentvillage #427):
 *
 * - every `.md` and `.txt` file under `skills/` and `workspace/`, skipping
 *   `node_modules` and dot entries;
 * - in each, every command in a fenced block whose language is empty, `sh`,
 *   `bash`, `shell`, `zsh` or `console` (continuation lines joined, a leading
 *   `$ ` prompt dropped, `#` comment lines skipped), and every inline
 *   backticked span that starts with `curl ` or `wget ` outside a fence;
 * - the inline cron prompts, `DIGEST_CRON_SPECS[].promptBody` from
 *   `install/install_index.ts`, read as plain text (inline spans only).
 *
 * `recipesIn` below is the overlay's function, copied verbatim but for types,
 * so a refresh extracts exactly what the overlay's test reads. Files are walked
 * in sorted order so a refresh at the same sha writes the same bytes.
 *
 * It also vendors the overlay's template policy block
 * (`skills/approval/templates/APPROVAL.md`, the ```yaml approval-policy fence),
 * so the check resolves classes with this repository's own resolver against the
 * policy the boxes render, at the same sha.
 *
 * Run with bun (the cron specs are TypeScript with extensionless imports), on a
 * read-only export of the overlay at the sha being pinned; it never touches the
 * overlay's own checkout:
 *
 *   git -C <agentvillage> archive <sha> skills workspace install | tar -x -C <dir>
 *   bun scripts/overlay-recipes-extract.mjs --overlay <dir> --sha <sha>
 *
 * It writes `scripts/overlay-recipes/corpus.json` (or `--out`). Commit it with the sha it
 * names; the check never fetches anything.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const overlay = arg("--overlay");
const sha = arg("--sha");
const OUT = arg("--out") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "corpus.json");
const extractedAt = arg("--extracted-at") ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
if (overlay === undefined || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
  process.stderr.write("usage: bun scripts/overlay-recipes-extract.mjs --overlay <export dir> --sha <40-hex overlay sha> [--extracted-at <iso>] [--out <path>]\n");
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(md|txt)$/.test(entry)) out.push(path);
  }
  return out;
}

const SHELL_FENCE = new Set(["", "sh", "bash", "shell", "zsh", "console"]);

/** The overlay's `recipesIn`, verbatim but for types (fetch-url-shape.test.ts). */
function recipesIn(name, text, plain = false) {
  const out = [];
  const lines = text.split("\n");
  let fence = null;
  let lang = "";
  let pending = "";
  let start = 0;
  lines.forEach((line, i) => {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
    if (!plain && fence === null && open) {
      fence = open[1];
      lang = open[2].toLowerCase();
      pending = "";
      return;
    }
    if (!plain && fence !== null && line.trim().startsWith(fence)) {
      fence = null;
      return;
    }
    if (!plain && fence !== null) {
      if (!SHELL_FENCE.has(lang)) return;
      if (pending === "") start = i + 1;
      pending += (pending ? " " : "") + line.replace(/\\\s*$/, "");
      if (/\\\s*$/.test(line)) return;
      const command = pending.replace(/^\s*\$\s+/, "").trim();
      pending = "";
      if (command && !command.startsWith("#")) out.push({ where: `${name}:${start}`, command });
      return;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      if (/^\s*(curl|wget)\s/.test(m[1])) out.push({ where: `${name}:${i + 1}`, command: m[1] });
    }
  });
  return out;
}

const recipes = [];
for (const dir of ["skills", "workspace"]) {
  for (const path of walk(join(overlay, dir))) {
    recipes.push(...recipesIn(relative(overlay, path), readFileSync(path, "utf8")));
  }
}
const { DIGEST_CRON_SPECS } = await import(join(overlay, "install", "install_index.ts"));
for (const spec of DIGEST_CRON_SPECS) {
  if (spec.promptBody !== undefined) recipes.push(...recipesIn(`install/install_index.ts#${spec.name}`, spec.promptBody, true));
}

const TEMPLATE = "skills/approval/templates/APPROVAL.md";
const templateText = readFileSync(join(overlay, TEMPLATE), "utf8");
const block = templateText.match(/^```yaml approval-policy\n([\s\S]*?)\n```$/mu);
if (block === null) {
  process.stderr.write(`no approval-policy fence in ${TEMPLATE}\n`);
  process.exit(1);
}

const corpus = {
  about:
    "Pinned overlay recipe corpus for the release check (approval.md 0.4.7, EDGEOS-BLOCK). Written by scripts/overlay-recipes-extract.mjs; read by scripts/overlay-recipes-check.mjs. Do not hand-edit: refresh at a new overlay sha instead.",
  overlay: {
    repo: "Edge-City/agentvillage",
    sha,
    extracted_at: extractedAt,
    method:
      "agentFacingRecipes() of scripts/tests/fetch-url-shape.test.ts (agentvillage #427): skills/** and workspace/** .md/.txt, shell fences (lang '', sh, bash, shell, zsh, console) plus inline `curl`/`wget` spans, and DIGEST_CRON_SPECS[].promptBody as plain text",
  },
  policy: {
    source: TEMPLATE,
    // The template carries a provisioning placeholder the schema rejects; the
    // check substitutes a syntactically valid id. No class row depends on it.
    substitute: { "<telegram_user_id>": "1" },
    block: block[1],
  },
  // The overlay test fills these placeholders before classifying (its FILL); the
  // check applies the same, and leaves every other placeholder as written.
  fill: [
    { pattern: "\\{(current_iso_timestamp|start_iso|end_iso|occurrence_iso)\\}", value: "2026-10-21T10:00:00Z" },
    { pattern: "\\{(event_id|popup_id)\\}", value: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
  ],
  // The overlay test classifies from /tmp with no protected-path entries beyond
  // the policy's own; the check does the same.
  cwd: "/tmp",
  recipes,
};

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
process.stdout.write(`${recipes.length} recipes at ${sha} -> ${relative(REPO_ROOT, OUT)}\n`);
