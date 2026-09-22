/**
 * Colour forcing is scrubbed out of every test-file process (APRV-417).
 *
 * ## The failure this removes
 *
 * `node --test` colours its own reporter, and to let the file processes it
 * spawns produce coloured output it sets `FORCE_COLOR` in their environment
 * whenever the runner's own stdout is a terminal. Those file processes are
 * this suite's tests, and a test that spawns the CLI hands it `process.env`,
 * so the variable travels one hop further than anybody intended and lands on
 * the thing under test. `src/cli/style.ts` ranks `FORCE_COLOR` above `NO_COLOR`
 * and above a piped stdout by design (APRV-102), so the CLI obeys it and about
 * twenty-five assertions that read plain text find ANSI escapes instead.
 *
 * The suite was therefore green in CI and on a piped run, red on a developer's
 * terminal, with the same code. A test that changes its answer with the
 * terminal it was launched from is pinning the terminal.
 *
 * ## Why here, and why this is the one place
 *
 * The variable is injected into each file process by the runner, so deleting
 * it from the environment `scripts/run-tests.mjs` hands to `node --test` would
 * not reach it. It has to be deleted INSIDE the file process, before any test
 * body runs. `--import` does exactly that, and `node --test` copies its own
 * `execArgv` onto every file process it spawns, so one flag on one spawn in
 * `run-tests.mjs` covers every test file there will ever be. Nothing is
 * scrubbed per file, and a new test file inherits the guarantee by existing.
 *
 * It does not reach the CLI children themselves: `execArgv` is not inherited
 * by a process a test spawns with its own argument list. That is the point.
 * The variable is gone from the environment those children are BUILT from, and
 * a test that wants colour still sets it explicitly in the child's own env
 * (`tests/style.test.ts`, `tests/cli-long-help.test.ts`), which keeps working
 * because an explicit value was never the problem.
 *
 * `NO_COLOR` is deleted for the mirror-image reason: a developer who exports it
 * would otherwise silently turn colour off inside cases that assert colour, and
 * those cases would pass for the wrong reason or fail for a reason not in the
 * diff. Both variables belong to the terminal, and no test may read either.
 */

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
