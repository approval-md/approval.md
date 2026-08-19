/**
 * The wordmark (APRV-91 #7/#12).
 *
 * The brief's fifth principle: "the brand shows up where a person pauses, not
 * on every line." So this appears in exactly three places — `approval` with no
 * arguments, `approval --help`, and `approval init` — and nowhere else. Verbs
 * are tools, not billboards, and a banner above a refusal at 2am is an insult.
 *
 * Two rules constrain the art itself. It is six lines and pure ASCII: no
 * half-blocks, no box-drawing, no emoji, because those are the characters that
 * break in Terminal.app's default font and in every CI log. And it DEGRADES —
 * with colour off it collapses to a single line, so a pipe, a `NO_COLOR`
 * terminal or an ASCII locale gets `approval.md v0.0.1` and no decoration at
 * all. The banner is ornament; the name and the version are the information,
 * and only the information survives the degradation.
 */

import { style as processStyle, type Style } from "./style.js";

/** Kept in step with package.json by a test rather than by memory. */
export const VERSION = "0.0.1";

export const TAGLINE = "human approval for agent actions";

/**
 * The six-line form. Written as a raw array so no editor reflows it: every
 * space here is load-bearing, and a prettier pass over a template literal has
 * eaten this kind of art before.
 */
const ART: readonly string[] = [
  "                                            _",
  "  __ _ _ __  _ __  _ __ _____   ____ _| |  _ __ ___   __| |",
  " / _` | '_ \\| '_ \\| '__/ _ \\ \\ / / _` | | | '_ ` _ \\ / _` |",
  "| (_| | |_) | |_) | | | (_) \\ V / (_| | |_| | | | | | (_| |",
  " \\__,_| .__/| .__/|_|  \\___/ \\_/ \\__,_|_(_)_| |_| |_|\\__,_|",
  "      |_|   |_|",
];

/** The one-line form, and the only form a pipe ever sees. */
export function plainWordmark(): string {
  return `approval.md v${VERSION}`;
}

/**
 * The wordmark for this invocation.
 *
 * Colour off means the banner is off: the art is decoration that a log file
 * should not carry, and the degradation is the whole reason it is safe to print
 * a banner at all. ASCII mode also collapses it, since a terminal that cannot
 * promise UTF-8 is not a terminal to draw on.
 */
export function wordmark(style: Style = processStyle()): string {
  if (!style.enabled || style.ascii) return plainWordmark();
  const art = ART.map((line) => style.brand(line)).join("\n");
  return `${art}\n${style.muted(`${TAGLINE} · v${VERSION}`)}`;
}
