/**
 * CommonMark fenced-block scanning, as a leaf module.
 *
 * `APPROVAL.md` is prose for humans plus fenced blocks for machines: exactly
 * one ` ```yaml approval-policy ` block (SPEC.md §5) and at most one optional
 * ` ```yaml approval-values ` block (SPEC.md §5.3). Two readers, two info
 * strings, one question: which fenced blocks in this markdown carry that label,
 * and was one of them left open at end of file.
 *
 * This module answers that question and nothing else. It was lifted out of
 * `policy-load.ts` unchanged (APRV-238) so the values reader could ask it too
 * without importing the policy loader, which is the module a values reader must
 * stay clear of (SPEC.md §11.1 invariant 10, `tests/values-inert.test.ts`). The
 * splitter is the one place allowed to know both info strings, because knowing
 * a label is not reading a block: what it returns is text, and what a caller
 * does with the text is the caller's whole subject.
 *
 * Pure function of the markdown and the info string. No filesystem, no clock,
 * no schema, no YAML.
 */

/** The blocks a scan found, and whether one was left open at end of file. */
export interface FenceScan {
  /** Bodies of every block whose info string matched, in document order. */
  blocks: string[];
  /** True when a MATCHING fence was opened and never closed before EOF. */
  unterminated: boolean;
}

/** Normalise a fence info string: trim ends, collapse internal whitespace. */
function normaliseInfoString(info: string): string {
  return info.trim().replace(/\s+/gu, " ");
}

/**
 * Scan CommonMark fenced code blocks and collect the bodies of those whose info
 * string is `infoString` (compared after {@link normaliseInfoString}).
 *
 * CommonMark rules honoured, because they decide what is and is not a fence:
 * an opening fence is 3+ backticks indented at most 3 spaces; its info string
 * may not contain a backtick; the closing fence is at least as long as the
 * opener and carries nothing but whitespace. Every non-matching fenced block
 * (```js, ```yaml, …) is still scanned as a block, so text *inside* it can
 * never be mistaken for a matching fence. Everything outside a fence — including
 * yaml-looking prose and 4-space-indented code blocks, which are not fences —
 * is ignored entirely.
 */
export function scanFences(markdown: string, infoString: string): FenceScan {
  const wanted = normaliseInfoString(infoString);
  const lines = markdown.split(/\r\n|\n|\r/u);
  const blocks: string[] = [];

  let openLength = 0;
  let openMatches = false;
  let body: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (!inFence) {
      const open = /^ {0,3}(`{3,})(.*)$/u.exec(line);
      if (open === null) continue;
      const info = open[2] ?? "";
      // CommonMark: a backtick fence's info string may not contain a backtick.
      if (info.includes("`")) continue;
      inFence = true;
      openLength = (open[1] ?? "").length;
      openMatches = normaliseInfoString(info) === wanted;
      body = [];
      continue;
    }

    const close = /^ {0,3}(`{3,})[ \t]*$/u.exec(line);
    if (close !== null && (close[1] ?? "").length >= openLength) {
      if (openMatches) blocks.push(body.join("\n"));
      inFence = false;
      openMatches = false;
      body = [];
      continue;
    }
    body.push(line);
  }

  return { blocks, unterminated: inFence && openMatches };
}
