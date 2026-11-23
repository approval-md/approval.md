/**
 * The runner's factor (`tests/cost-runner.ts`): what the cost tests multiply
 * their bounds by. Pinned here: it never tightens a bound, it never excuses
 * more than {@link MOST} times, and the work it times is the same every run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { calibrationWork, factorOf, MOST, REFERENCE_SECONDS, runner, scaledBound } from "./cost-runner.js";

test("the factor is the calibration time over the reference, held between 1 and the most a runner may stretch a bound", () => {
  assert.equal(factorOf(REFERENCE_SECONDS), 1);
  assert.equal(factorOf(REFERENCE_SECONDS / 10), 1, "a fast runner keeps the bound as written");
  assert.equal(factorOf(0), 1);
  assert.equal(factorOf(REFERENCE_SECONDS * 2.5), 2.5);
  assert.equal(factorOf(REFERENCE_SECONDS * MOST), MOST);
  assert.equal(factorOf(REFERENCE_SECONDS * 1000), MOST, "no runner excuses a walk that has become quadratic");
  assert.ok(MOST >= 2 && MOST <= 5);
});

test("the calibration work is the same work every run, and this runner's measurement is made once", () => {
  assert.equal(calibrationWork(), calibrationWork());
  const first = runner();
  assert.equal(runner(), first);
  assert.ok(first.seconds > 0 && Number.isFinite(first.seconds));
  assert.equal(first.factor, factorOf(first.seconds));
  assert.match(first.line, /^runner factor \d+\.\d\d \(calibration \d+\.\d{3} CPU s, reference /u);
  assert.equal(scaledBound(8), 8 * first.factor);
  assert.equal(scaledBound(0), 0);
});
