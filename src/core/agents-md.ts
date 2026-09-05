/**
 * AGENTS.md permissions import (SPEC.md §2, §12) — turn permissions PROSE into
 * a DRAFT policy block a human can read, correct, and confirm.
 *
 * SPEC.md §2 names the gap this closes: AGENTS.md files "routinely contain
 * permissions sections splitting actions into 'allowed without prompting' and
 * 'require approval first'", and "nothing checks". SPEC.md §12 gives the verb:
 * `approval import agents-md` "parses ... permissions sections into draft
 * policy classes for human confirmation".
 *
 * ## This module is deterministic, and there is no model in it
 *
 * Per CLAUDE.md's engineering invariants, routing and policy are pure
 * deterministic code; LLMs are confined to language tasks. Reading a bullet
 * list is a language task in appearance only — its OUTPUT is a permission
 * document, so the mapping is a fixed, ordered, documented keyword table
 * ({@link CLASS_TABLE}), not a judgement. The same bytes always produce the
 * same draft, on any machine, with no network and no clock. An LLM-assisted
 * `--suggest` (proposing classes for bullets this table cannot place) is a
 * separate, opt-in, out-of-scope idea: it would be allowed to propose, never
 * to decide.
 *
 * ## The grammar
 *
 * Input is CommonMark-ish markdown. The scanner is line-based:
 *
 * - **Fenced code blocks** (``` or ~~~, 3+ markers, indented at most 3 spaces)
 *   are skipped entirely. A bullet inside an example block is an example.
 * - **Headings** are ATX only: `^ {0,3}#{1,6}\s+text`, trailing `#`s stripped.
 *   Setext headings are not recognised; the convention in the wild is ATX.
 * - A heading whose text contains `permissions` (case-insensitive, at any
 *   level) opens the **permissions region**. The region closes at the next
 *   non-canonical heading whose level is less than or equal to the permissions
 *   heading's level.
 * - Three **canonical sub-headings** open a section, matched case-insensitively
 *   against {@link SECTION_PHRASES} after normalisation (lowercased, markdown
 *   emphasis and backticks stripped, whitespace collapsed, trailing `:`
 *   dropped). They are recognised at ANY level and, deliberately, whether or
 *   not a parent `Permissions` heading exists: the bare three-heading layout is
 *   common in AGENTS.md files.
 * - **Bullets** are `-` or `*` list items (`^\s*[-*]\s+`) appearing while a
 *   section is open. A following line that is not blank, not a heading, not a
 *   list item and not a fence is a **continuation** and is joined to the
 *   previous bullet with a single space. Any heading closes the open section.
 * - Every other line is ignored.
 *
 * Non-canonical headings seen inside the permissions region, and non-canonical
 * headings that interrupt an open section, are reported in `ignored` rather
 * than silently dropped: a heading the importer did not understand may be
 * carrying permissions prose, and the human confirming the draft is the one who
 * should decide.
 *
 * ## Fail closed
 *
 * A bullet the table cannot place is NOT guessed at and NOT dropped. It becomes
 * an `unmapped` entry, is preserved verbatim as a comment in the draft, and is
 * covered by `defaults.autonomy: manual` — the strictest outcome available.
 * Likewise a source with no permissions section produces an empty draft (all
 * classes manual by default) plus a warning, never a permissive one.
 *
 * ## The values draft
 *
 * Since APRV-240 the same file is scanned a second time for four optional
 * headings ("what I value", "what good looks like", "how I like to work",
 * "what I want from you") and their bullets are drafted into a
 * ` ```yaml approval-values ` block (SPEC.md §5.3). Every bullet lands in
 * `wants:`, and nothing is ever placed in `love:`, `like:` or `dislike:`.
 * Grading is the human's act. This importer can see that a line was written
 * down; it cannot see how much its author meant it, and a guessed grade would
 * put words in their mouth inside the one block of `APPROVAL.md` that exists to
 * carry their own.
 *
 * ## Namespaces
 *
 * SPEC.md §7 reserves top-level namespaces to the spec and lets implementations
 * add sub-classes freely. The developer-workstation vocabulary this table emits
 * (`vcs.*`, `deps.*`, `release.*`, `exec.*`, `network.*`, `policy.edit`) is not
 * in the §7 table, which was written for life-admin side effects. That is a
 * deliberate, visible property of a DRAFT: the classes are proposals a human
 * renames or upstreams before confirming, and the draft says so in its header.
 */

/** Which prose section a bullet came from. */
export type AgentsMdSection = "allowed" | "approval-first" | "never";

/** SPEC.md §5.2 autonomy levels, strictest first. */
export type Autonomy = "manual" | "supervised" | "autonomous";

/** One list item of a permissions section. */
export interface Bullet {
  /** The bullet's text, continuation lines joined, marker stripped. */
  text: string;
  /** 1-based line number of the bullet's first line, for diagnostics. */
  line: number;
}

/** The three recognised sections, each in source order. */
export interface AgentsMdSections {
  allowed: Bullet[];
  approvalFirst: Bullet[];
  never: Bullet[];
}

/** Result of {@link parseAgentsMd}. Pure function of the input bytes. */
export interface AgentsMdParse {
  sections: AgentsMdSections;
  /** Headings the scanner met inside the permissions area and did not use. */
  ignored: string[];
  /** Human-facing notes; never a reason to relax anything. */
  warnings: string[];
}

/**
 * Canonical section phrases and their tolerant variants, matched against a
 * normalised heading by exact equality first and then by prefix/containment of
 * the variant inside the heading. Order matters only between sections: a
 * heading matching more than one section's variants takes the FIRST section in
 * this list, and the list is ordered strictest-first so an ambiguous heading
 * lands on the stricter reading.
 */
const SECTION_PHRASES: ReadonlyArray<readonly [AgentsMdSection, readonly string[]]> = [
  ["never", ["never", "never do", "forbidden", "prohibited", "not permitted", "off limits"]],
  [
    "approval-first",
    [
      "require approval first",
      "requires approval",
      "require approval",
      "approval required",
      "ask first",
      "ask before",
      "needs approval",
    ],
  ],
  [
    "allowed",
    [
      "allowed without prompting",
      "allowed without asking",
      "allowed",
      "autonomous",
      "no prompt needed",
      "safe to run",
    ],
  ],
];

/** Marker that a heading opens the permissions region. */
const PERMISSIONS_MARKER = "permissions";

/**
 * The class heuristic: an ORDERED, STABLE table. First match wins, and the
 * order of this array IS the precedence. Each entry lists alternative keyword
 * conjunctions; an alternative matches when every one of its keywords appears
 * as a substring of the normalised bullet text.
 *
 * Ordering rules, so future edits stay principled:
 *
 * 1. The most consequential and most specific classes come first, because a
 *    bullet naming several actions ("git push, merges to main, tag creation")
 *    is placed by its first match and the safer placement is the broader,
 *    more consequential class.
 * 2. `network.call` precedes `deps.add` on purpose: "any network call beyond
 *    package installs" contains "install" and is not a dependency bullet.
 * 3. `vcs.push` precedes `vcs.push.main`: a bullet naming pushes generally
 *    should govern all pushes, not only pushes to the default branch.
 * 4. Generic verbs (`edit`, `read`) come last, since almost every bullet
 *    contains one.
 *
 * Adding a keyword here changes what a draft proposes for existing files, so
 * the table is pinned byte-for-byte by `tests/agents-md.test.ts` fixtures.
 */
export const CLASS_TABLE: ReadonlyArray<{
  readonly cls: string;
  readonly any: ReadonlyArray<readonly string[]>;
}> = [
  {
    cls: "account.credential",
    any: [["credential"], ["token"], ["vault"], ["secret"], ["api key"], ["password"]],
  },
  {
    cls: "vcs.history.rewrite",
    any: [["rewrite", "history"], ["force-push"], ["force push"], ["--force"]],
  },
  {
    cls: "policy.edit",
    any: [
      ["approval.md"],
      ["approvals.md"],
      [".approval/"],
      ["agents.md"],
      ["claude.md"],
      ["policy file"],
      ["ci config"],
      ["ci/release"],
      ["release config"],
      ["workflow file"],
    ],
  },
  { cls: "vcs.push", any: [["git push"], ["push"]] },
  { cls: "vcs.push.main", any: [["merge", "main"], ["merge", "master"], ["merge", "trunk"]] },
  {
    cls: "release.publish",
    any: [
      ["npm publish"],
      ["npm version"],
      ["registry"],
      ["tag creation"],
      ["create a tag"],
      ["publish"],
      ["release"],
    ],
  },
  {
    cls: "network.call",
    any: [["network"], ["api call"], ["webhook"], ["send"], ["http"], ["outbound"], ["email"]],
  },
  { cls: "deps.add", any: [["depend"], ["install"], ["upgrade"]] },
  // "delet" rather than "delete": the stem is what matches "deleting" and
  // "deletion" too, and a bullet that says "Deleting files ..." must not fall
  // through to unmapped on an inflection.
  { cls: "data.delete", any: [["delet"], ["rm -rf"], ["destroy"], ["drop table"]] },
  { cls: "vcs.commit.branch", any: [["commit"]] },
  {
    cls: "exec.local",
    any: [
      ["run tests"],
      ["run the tests"],
      ["lint"],
      ["typecheck"],
      ["type-check"],
      ["build"],
      ["script"],
    ],
  },
  {
    cls: "files.write.workspace",
    any: [["edit"], ["write"], ["writing"], ["modif"], ["refactor"]],
  },
  { cls: "read.*", any: [["read"], ["list director"], ["search"], ["inspect"], ["grep"]] },
];

/** Strictness rank; lower is stricter (SPEC.md §5.2 "deny beats allow"). */
const STRICTNESS: Readonly<Record<Autonomy, number>> = {
  manual: 0,
  supervised: 1,
  autonomous: 2,
};

/** Autonomy a section proposes. `never` has no v0.1 level of its own. */
const SECTION_AUTONOMY: Readonly<Record<AgentsMdSection, Autonomy>> = {
  allowed: "autonomous",
  "approval-first": "manual",
  never: "manual",
};

/** Lowercase, strip emphasis/backticks, collapse whitespace, drop trailing ':'. */
function normaliseHeading(text: string): string {
  return text
    .replace(/[`*_]/gu, "")
    .trim()
    .replace(/[:.]+$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

/** Match a heading against the section phrases; `null` when it is not one. */
function sectionOf(heading: string): AgentsMdSection | null {
  const text = normaliseHeading(heading);
  if (text.length === 0) return null;
  for (const [section, phrases] of SECTION_PHRASES) {
    for (const phrase of phrases) {
      if (text === phrase || text.startsWith(`${phrase} `) || text.includes(phrase)) {
        return section;
      }
    }
  }
  return null;
}

/** Text used for keyword matching: lowercased with whitespace collapsed. */
export function normaliseBullet(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * The class this bullet proposes, or `null` when the table cannot place it.
 *
 * Deterministic, total, and side-effect free: the first entry of
 * {@link CLASS_TABLE} with a satisfied keyword conjunction wins.
 */
export function classifyBullet(text: string): string | null {
  const haystack = normaliseBullet(text);
  for (const entry of CLASS_TABLE) {
    for (const alternative of entry.any) {
      if (alternative.every((keyword) => haystack.includes(keyword))) return entry.cls;
    }
  }
  return null;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/u;
const LIST_ITEM = /^\s*[-*]\s+(.*)$/u;

/**
 * Parse the permissions region of an AGENTS.md-style document.
 *
 * Never throws. Pure function of `markdown`; see the module header for the
 * grammar it accepts.
 */
export function parseAgentsMd(markdown: string): AgentsMdParse {
  const sections: AgentsMdSections = { allowed: [], approvalFirst: [], never: [] };
  const ignored: string[] = [];
  const warnings: string[] = [];

  const lines = markdown.split(/\r\n|\n|\r/u);

  let fence: string | null = null;
  let inRegion = false;
  let regionLevel = 0;
  let sawPermissionsHeading = false;
  let current: AgentsMdSection | null = null;
  let currentLevel = 0;
  let lastBullet: Bullet | null = null;

  const bucket = (section: AgentsMdSection): Bullet[] =>
    section === "allowed"
      ? sections.allowed
      : section === "approval-first"
        ? sections.approvalFirst
        : sections.never;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const lineNumber = index + 1;

    if (fence !== null) {
      const close = FENCE_OPEN.exec(line);
      const marker = close === null ? "" : (close[1] ?? "");
      if (marker.length >= fence.length && marker.startsWith(fence.slice(0, 1))) fence = null;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = open[1] as string;
      lastBullet = null;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] as string).length;
      const raw = (heading[2] as string).replace(/\s+#+\s*$/u, "").trim();
      lastBullet = null;

      const section = sectionOf(raw);
      if (section !== null) {
        current = section;
        currentLevel = level;
        continue;
      }

      const wasInSection = current !== null;
      const sectionLevel = currentLevel;
      current = null;

      if (normaliseHeading(raw).includes(PERMISSIONS_MARKER)) {
        inRegion = true;
        sawPermissionsHeading = true;
        regionLevel = level;
        continue;
      }

      if (inRegion && level <= regionLevel) {
        inRegion = false;
        continue;
      }
      if (inRegion || (wasInSection && level > sectionLevel)) ignored.push(raw);
      continue;
    }

    if (current === null) {
      lastBullet = null;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const text = (item[1] as string).trim();
      if (text.length === 0) {
        lastBullet = null;
        continue;
      }
      const bullet: Bullet = { text, line: lineNumber };
      bucket(current).push(bullet);
      lastBullet = bullet;
      continue;
    }

    if (line.trim().length === 0) {
      lastBullet = null;
      continue;
    }

    // A continuation of the previous bullet: wrapped prose, joined with one
    // space so the draft's comment carries the whole sentence.
    if (lastBullet !== null) lastBullet.text = `${lastBullet.text} ${line.trim()}`;
  }

  const total =
    sections.allowed.length + sections.approvalFirst.length + sections.never.length;
  if (total === 0) {
    warnings.push(
      sawPermissionsHeading
        ? "a permissions heading was found but no bullets under any recognised section (allowed / require approval first / never); the draft declares no classes and everything falls to defaults.autonomy: manual"
        : "no permissions section found (looked for a heading containing \"permissions\", or the sub-headings \"allowed without prompting\" / \"require approval first\" / \"never\"); the draft declares no classes and everything falls to defaults.autonomy: manual",
    );
  }

  return { sections, ignored, warnings };
}

// ---------------------------------------------------------------------------
// The values headings (APRV-240)

/**
 * Headings whose bullets become a DRAFT values block (SPEC.md §5.3).
 *
 * Matched against a heading run through {@link normaliseHeading}, at ANY level,
 * with the tolerance {@link sectionOf} already uses (equality, then prefix,
 * then containment), so "## What I value most" and "**What I want from you:**"
 * are recognised too. Four phrases and no more: this is a fixed vocabulary a
 * human can be told about in one line of documentation, and a wider net would
 * start collecting prose nobody offered as values.
 */
const VALUES_HEADING_PHRASES: readonly string[] = [
  "what i value",
  "what good looks like",
  "how i like to work",
  "what i want from you",
];

/**
 * The caps of `values.schema.json` `$defs/valueList`, restated so the renderer
 * can respect them without importing a validator. `tests/agents-md.test.ts`
 * reads the schema and asserts these two numbers still match it, so the copy
 * cannot drift.
 */
const VALUES_MAX_ITEMS = 20;
const VALUES_MAX_LENGTH = 200;

/** Result of {@link parseValuesHeadings}. Pure function of the input bytes. */
export interface ValuesDraft {
  /** The recognised headings, normalised, in source order. */
  headings: string[];
  /** Bullets destined for `wants:`: truncated, deduped, capped. */
  wants: string[];
  /** Bullets past {@link VALUES_MAX_ITEMS}, kept so none is dropped silently. */
  overflow: string[];
  /** Human-facing notes; never a reason to relax anything. */
  warnings: string[];
}

/** True when this heading opens a values section. */
function isValuesHeading(heading: string): boolean {
  const text = normaliseHeading(heading);
  if (text.length === 0) return false;
  return VALUES_HEADING_PHRASES.some(
    (phrase) => text === phrase || text.startsWith(`${phrase} `) || text.includes(phrase),
  );
}

/**
 * Bring one bullet under the schema's 200-character cap.
 *
 * Truncation with a visible marker, rather than refusing the draft or dropping
 * the entry. The draft exists to be read and corrected by hand, so a line the
 * human can see is over-long is a line they can repair in place; refusing would
 * cost them the other nineteen bullets over one long sentence, and dropping is
 * the one outcome ruled out everywhere in this module. Sliced by CODE POINT, so
 * an astral character is never cut in half (Ajv measures `maxLength` the same
 * way).
 */
function capLength(text: string): { text: string; truncated: boolean } {
  const points = [...text];
  if (points.length <= VALUES_MAX_LENGTH) return { text, truncated: false };
  return { text: `${points.slice(0, VALUES_MAX_LENGTH - 1).join("")}…`, truncated: true };
}

/**
 * Collect the bullets under the optional values headings of an AGENTS.md-style
 * document (SPEC.md §5.3).
 *
 * ## Everything goes to `wants`, and nothing is graded
 *
 * The values block has three standing grades (`love`, `like`, `dislike`) and
 * one behavioural list (`wants`). This function fills `wants` and leaves the
 * three grades empty, always. A grade is a statement of taste, and it is the
 * human's to make: the source shows that a line was written under a heading, it
 * does not show how strongly it was meant, and an importer that inferred
 * "love" from an exclamation mark or a heading's wording would be putting words
 * in its reader's mouth in the one block of `APPROVAL.md` that exists to carry
 * theirs. `wants` is the honest destination for a bullet whose grade is
 * unknown: it says the operator asked for something, which is exactly what a
 * bullet under "what I want from you" demonstrates.
 *
 * ## The scan
 *
 * A second line-based pass over the same primitives {@link parseAgentsMd} uses,
 * with the same rules: fenced code blocks are skipped whole (a bullet in an
 * example block is an example), headings are ATX at any level, a values heading
 * opens a section, any other heading closes one, and a non-blank line that is
 * not a bullet, heading or fence is a continuation joined to the previous
 * bullet with a single space.
 *
 * Never throws. No clock, no filesystem, no network.
 */
export function parseValuesHeadings(markdown: string): ValuesDraft {
  const headings: string[] = [];
  const collected: Array<{ text: string }> = [];
  const warnings: string[] = [];

  const lines = markdown.split(/\r\n|\n|\r/u);

  let fence: string | null = null;
  let open = false;
  let lastBullet: { text: string } | null = null;

  for (const line of lines) {
    if (fence !== null) {
      const close = FENCE_OPEN.exec(line);
      const marker = close === null ? "" : (close[1] ?? "");
      if (marker.length >= fence.length && marker.startsWith(fence.slice(0, 1))) fence = null;
      continue;
    }

    const opened = FENCE_OPEN.exec(line);
    if (opened !== null) {
      fence = opened[1] as string;
      lastBullet = null;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const raw = (heading[2] as string).replace(/\s+#+\s*$/u, "").trim();
      lastBullet = null;
      open = isValuesHeading(raw);
      if (open) headings.push(normaliseHeading(raw));
      continue;
    }

    if (!open) {
      lastBullet = null;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const text = (item[1] as string).trim();
      if (text.length === 0) {
        lastBullet = null;
        continue;
      }
      const bullet = { text };
      collected.push(bullet);
      lastBullet = bullet;
      continue;
    }

    if (line.trim().length === 0) {
      lastBullet = null;
      continue;
    }

    if (lastBullet !== null) lastBullet.text = `${lastBullet.text} ${line.trim()}`;
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicates = 0;

  for (const bullet of collected) {
    const capped = capLength(bullet.text);
    if (capped.truncated) {
      warnings.push(
        `a values bullet is ${String([...bullet.text].length)} characters and values.schema.json caps an entry at ${String(VALUES_MAX_LENGTH)}; the draft carries it truncated rather than dropping it, so shorten it by hand before confirming: ${JSON.stringify(capped.text)}`,
      );
    }
    // Deduped AFTER truncation, because `uniqueItems` is checked on the values
    // the block actually carries: two long bullets that differ only past the
    // cap become one entry, and a draft that emitted both would fail its schema.
    if (seen.has(capped.text)) {
      duplicates += 1;
      continue;
    }
    seen.add(capped.text);
    unique.push(capped.text);
  }

  if (duplicates > 0) {
    warnings.push(
      `${String(duplicates)} repeated values ${duplicates === 1 ? "bullet was" : "bullets were"} collapsed; values.schema.json requires the entries of a list to be unique`,
    );
  }

  const wants = unique.slice(0, VALUES_MAX_ITEMS);
  const overflow = unique.slice(VALUES_MAX_ITEMS);
  if (overflow.length > 0) {
    warnings.push(
      `${String(overflow.length)} values ${overflow.length === 1 ? "bullet is" : "bullets are"} past the cap of ${String(VALUES_MAX_ITEMS)}; they are preserved as comments in the draft instead of in wants:, and a human promotes the ones they want`,
    );
  }

  return { headings, wants, overflow, warnings };
}

/** One proposed class rule, with the bullets that produced it. */
export interface DraftClass {
  cls: string;
  autonomy: Autonomy;
  /** Every bullet that mapped here, in source order. */
  bullets: Array<{ text: string; section: AgentsMdSection }>;
  /** The bullet that decided the autonomy (strictest, earliest on ties). */
  from: { text: string; section: AgentsMdSection };
}

/** A bullet the table could not place. Covered by `defaults.autonomy`. */
export interface UnmappedBullet {
  text: string;
  section: AgentsMdSection;
}

/** Result of {@link importAgentsMd}: the draft, and everything it could not use. */
export interface AgentsMdImport {
  classes: DraftClass[];
  unmapped: UnmappedBullet[];
  ignored: string[];
  warnings: string[];
  /**
   * The values headings the same source declared (APRV-240). Empty `headings`
   * means the source declared none, and no values fence is rendered at all: an
   * absent values block is a declaration in its own right (SPEC.md §5.3), and a
   * draft of one would be this importer inventing the declaration.
   */
  values: ValuesDraft;
}

/** Ordered (section, bullet) pairs: allowed, then approval-first, then never. */
function orderedBullets(parse: AgentsMdParse): Array<{ bullet: Bullet; section: AgentsMdSection }> {
  return [
    ...parse.sections.allowed.map((bullet) => ({ bullet, section: "allowed" as const })),
    ...parse.sections.approvalFirst.map((bullet) => ({
      bullet,
      section: "approval-first" as const,
    })),
    ...parse.sections.never.map((bullet) => ({ bullet, section: "never" as const })),
  ];
}

/**
 * Parse and classify: the whole deterministic half of `approval import
 * agents-md`. Emitting bytes is {@link renderDraftPolicy}'s job.
 *
 * Conflicts follow SPEC.md §5.2 "deny beats allow": when bullets from different
 * sections claim the same class, the strictest autonomy wins and a warning
 * names both bullets, because a class that appears in both an allow list and an
 * approval list is a contradiction in the SOURCE that a human must resolve.
 */
export function importAgentsMd(markdown: string): AgentsMdImport {
  const parse = parseAgentsMd(markdown);
  const values = parseValuesHeadings(markdown);
  // The values notes join the one list every surface already prints. They are
  // notes about a block that enforces nothing, so they change no verdict and
  // never make the policy half of this import fail.
  const warnings = [...parse.warnings, ...values.warnings];
  const unmapped: UnmappedBullet[] = [];
  const byClass = new Map<string, DraftClass>();

  for (const { bullet, section } of orderedBullets(parse)) {
    const cls = classifyBullet(bullet.text);
    if (cls === null) {
      unmapped.push({ text: bullet.text, section });
      warnings.push(
        `no class matched ${JSON.stringify(bullet.text)} (section: ${section}); it is preserved as a comment and covered by defaults.autonomy: manual`,
      );
      continue;
    }

    const autonomy = SECTION_AUTONOMY[section];
    const existing = byClass.get(cls);
    if (existing === undefined) {
      byClass.set(cls, {
        cls,
        autonomy,
        bullets: [{ text: bullet.text, section }],
        from: { text: bullet.text, section },
      });
      continue;
    }

    existing.bullets.push({ text: bullet.text, section });
    if (existing.from.section !== section) {
      const stricter = STRICTNESS[autonomy] < STRICTNESS[existing.autonomy];
      const winner = stricter ? autonomy : existing.autonomy;
      warnings.push(
        `class ${cls} is claimed by two sections; the stricter autonomy wins (${winner}): ${JSON.stringify(existing.from.text)} (${existing.from.section}) and ${JSON.stringify(bullet.text)} (${section})`,
      );
      if (stricter) {
        existing.autonomy = autonomy;
        existing.from = { text: bullet.text, section };
      }
    }
  }

  return { classes: [...byClass.values()], unmapped, ignored: parse.ignored, warnings, values };
}

/** Info string of the machine-readable policy block (SPEC.md §5). */
export const POLICY_INFO_STRING = "yaml approval-policy";

/**
 * Info string of the OPTIONAL values block (SPEC.md §5.3).
 *
 * Spelled here rather than imported from `core/values.ts`, exactly as
 * {@link POLICY_INFO_STRING} is spelled rather than imported from
 * `core/policy-load.ts`. `tests/values-inert.test.ts` (APRV-237) lets three CLI
 * surfaces import the values reader and no module under `src/core/` at all,
 * because a core module holding a reference to that reader is something review
 * has to re-argue on every change. A label is not a reader, and this renderer
 * needs only the label. The two spellings are pinned to each other by
 * `tests/agents-md.test.ts`, so the copy cannot drift.
 */
const VALUES_INFO_STRING = "yaml approval-values";

function draftHeader(source: string): string[] {
  return [
    `# DRAFT policy, generated from ${source} by \`approval import agents-md\`.`,
    "#",
    "# NOTHING HAS BEEN APPLIED. This block was printed, not written: APPROVAL.md",
    "# is untouched, no event was appended, and no attestation was made. A human",
    "# confirms a draft by pasting it into APPROVAL.md and running",
    "# `approval policy amend`, which diffs it, attests it, and commits it.",
    "#",
    "# The v0.1 vocabulary has three levels (manual > supervised > autonomous) and",
    "# NO forbid level, so bullets from a \"Never\" section are rendered `manual`",
    "# and carry a `# never:` comment. Manual is not never — a human can still say",
    "# yes. Read every `# never:` line before confirming this draft.",
    "#",
    "# Class names are PROPOSALS. The importer places bullets with a fixed keyword",
    "# table into the SPEC.md §7 developer-workstation namespaces (vcs.*, deps.*,",
    "# release.*, exec.*, network.*, policy.*). Rename any that do not match the",
    "# classes your adapters actually declare.",
    "#",
    "# No `approvers:` and no `channels:` are invented here: a generated file must",
    "# not name who may approve, or where. Add them by hand (SPEC.md §5.1).",
  ];
}

/**
 * True when a values draft should be rendered at all: the source declared at
 * least one of the four headings. One predicate, so "when is there a values
 * draft" is answered in one place rather than at each surface.
 */
function hasValuesDraft(values: ValuesDraft | null | undefined): values is ValuesDraft {
  return values !== null && values !== undefined && values.headings.length > 0;
}

/**
 * Render the values draft, fenced (APRV-240).
 *
 * The argument is the whole {@link ValuesDraft} rather than its bullets alone,
 * because the entries past the cap have to appear in the output as comments:
 * the renderer needs to see what was left out in order to say so.
 *
 * Deterministic, like everything else here. Entries are emitted as
 * double-quoted scalars via `JSON.stringify`, whose escapes are all valid YAML
 * double-quoted escapes, so a bullet full of backticks, colons and `#` survives
 * the round trip without the renderer having to reason about YAML quoting.
 */
export function renderFencedValuesDraft(draft: ValuesDraft, source: string): string {
  const lines: string[] = [
    `# DRAFT values block, imported from ${source} by \`approval import agents-md\`.`,
    "#",
    "# NOTHING HAS BEEN APPLIED, exactly as for the policy draft: this block was",
    "# printed, not written. APPROVAL.md is untouched and nothing was attested.",
    "# The values block lives INSIDE APPROVAL.md, so pasting it changes the file's",
    "# bytes and invalidates the standing attestation; renew it immediately after.",
    "#",
    "# EVERY bullet is in `wants:`, and nothing is graded. `love:`, `like:` and",
    "# `dislike:` are yours to fill in. A grade is a statement of taste and it is",
    "# yours to make: this importer can see that you wrote a line down, and cannot",
    "# see how much you meant it. Guessing would put words in your mouth.",
    "#",
    "# This block is guidance and never policy. Nothing here is enforced, counted",
    "# or checked, and no routing, class match, sampling draw, budget or token",
    "# reads it (SPEC.md §11.1 invariant 10).",
    "",
    "version: 1",
  ];

  if (draft.wants.length === 0) {
    lines.push(
      "# The headings were there and carried no bullets. An empty list is a real",
      "# answer: it says the question was considered and left blank.",
      "wants: []",
    );
  } else {
    lines.push("wants:");
    for (const want of draft.wants) lines.push(`  - ${JSON.stringify(want)}`);
  }

  if (draft.overflow.length > 0) {
    lines.push(
      "",
      `# OVER THE CAP: values.schema.json admits ${String(VALUES_MAX_ITEMS)} entries and the source`,
      "# offered more. These are preserved verbatim and are NOT in `wants:`. Promote",
      "# the ones you want by hand, in place of ones above:",
    );
    for (const want of draft.overflow) lines.push(`#   ${want}`);
  }

  return `\`\`\`${VALUES_INFO_STRING}\n${lines.join("\n")}\n\`\`\`\n`;
}

/**
 * The fenced values draft for an import, or `null` when the source declared no
 * values headings. The `--json` surface's `values_draft` field, verbatim.
 */
export function valuesDraftOf(result: AgentsMdImport, source: string): string | null {
  return hasValuesDraft(result.values) ? renderFencedValuesDraft(result.values, source) : null;
}

/**
 * Render the draft policy YAML. Deterministic: no clock, no cwd, no
 * randomness — the only inputs are the import result and the source label, so
 * the same file always produces the same bytes.
 *
 * With `values` omitted (or from a source that declared no values headings) the
 * output is bare YAML with no fence, a valid policy under
 * `schema/policy.schema.json` that loads through `loadPolicy` once wrapped in a
 * ` ```yaml approval-policy ` fence.
 *
 * With a values draft the shape changes, and it has to. A values fence appended
 * to bare YAML could not be pasted into a policy fence, because the values
 * block's own closing fence would close the policy block and leave a file that
 * loads as neither. So a two-block draft is emitted already fenced: the policy
 * inside its ` ```yaml approval-policy ` fence, then the values fence after it,
 * which is the shape `APPROVAL.md` itself has and which the policy loader and
 * the values reader each read straight off disk.
 */
export function renderDraftPolicy(
  result: AgentsMdImport,
  source: string,
  values?: ValuesDraft | null,
): string {
  const lines: string[] = [...draftHeader(source), ""];

  lines.push('version: "0.1"', "");
  lines.push(
    "defaults:",
    "  autonomy: manual          # anything not named below needs sign-off",
    '  approval_ttl: "24h"',
    "  on_expiry: reject",
    "",
  );

  if (result.classes.length === 0) {
    lines.push(
      "# No classes: the source declared no permissions bullets this importer could",
      "# use. Every class therefore resolves to defaults.autonomy (manual).",
    );
  } else {
    lines.push("classes:");
    for (const entry of result.classes) {
      for (const bullet of entry.bullets) {
        // The section is named only when more than one bullet mapped here: with
        // one bullet the heading it came from is not in question, and with two
        // the reader needs to see which section the surviving autonomy came from.
        const label =
          bullet.section === "never"
            ? "never"
            : entry.bullets.length > 1
              ? `from (${bullet.section})`
              : "from";
        lines.push(`  # ${label}: ${bullet.text}`);
      }
      lines.push(`  ${entry.cls}: { autonomy: ${entry.autonomy} }`);
    }
  }

  if (result.unmapped.length > 0) {
    lines.push(
      "",
      "# UNMAPPED — the importer could not place these bullets, and refuses to",
      "# guess. They are covered by defaults.autonomy (manual) until a human names",
      "# their class:",
    );
    for (const bullet of result.unmapped) {
      lines.push(`#   (${bullet.section}) ${bullet.text}`);
    }
  }

  const yaml = `${lines.join("\n")}\n`;
  if (!hasValuesDraft(values)) return yaml;
  return `\`\`\`${POLICY_INFO_STRING}\n${yaml}\`\`\`\n\n${renderFencedValuesDraft(values, source)}`;
}

/**
 * The draft wrapped in its ` ```yaml approval-policy ` fence, for stdout, with
 * the values fence printed after it when the source declared values headings.
 */
export function renderFencedDraft(
  result: AgentsMdImport,
  source: string,
  values?: ValuesDraft | null,
): string {
  const policy = `\`\`\`${POLICY_INFO_STRING}\n${renderDraftPolicy(result, source)}\`\`\`\n`;
  if (!hasValuesDraft(values)) return policy;
  return `${policy}\n${renderFencedValuesDraft(values, source)}`;
}
