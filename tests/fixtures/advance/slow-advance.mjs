/**
 * An advance child that takes five seconds to say anything (APRV-211).
 *
 * Stands in for `daemon/advance-child.js` in the one test that needs an advance
 * to still be running while something else happens: `git fetch` + `git push` +
 * `gh pr create` against a scratch remote is milliseconds, and a property about
 * what the daemon does DURING an advance cannot be pinned by an advance that is
 * over before the assertion is written.
 *
 * It speaks the child protocol and nothing else: one JSON line on stdout, here
 * a refusal, so the test also sees a child's failure reason reach the daemon's
 * event stream. It touches no log, no policy and no gate — neither does the
 * real one.
 */

const BLOCK_MS = Number.parseInt(process.env["SLOW_ADVANCE_MS"] ?? "5000", 10);

await new Promise((resolve) => setTimeout(resolve, BLOCK_MS));

process.stdout.write(
  `${JSON.stringify({
    ok: false,
    code: "log-advance-push-rejected",
    message: `the slow advance stub held the child open for ${String(BLOCK_MS)}ms and refused`,
  })}\n`,
);
