/**
 * The runner's factor (`tests/cost-runner.ts`): what the cost tests multiply
 * their bounds by. Pinned here: it never tightens a bound, it never excuses
 * more than {@link MOST} times, and the work it times is the same every run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { calibrationWork, factorOf, leastOfThree, MOST, plainLike, ratioJudged, REFERENCE_SECONDS, runner, scaledBound } from "./cost-runner.js";

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

test("the RATIO rule judges a line by its ratio and its control by its own bound, stretched by the runner's factor and by nothing else (#720's list)", () => {
  const rule = { ratioBound: 20, controlCi: 0.1, most: 3 };
  // Under its ratio beside a control at its CI figure: passes.
  assert.deepEqual(ratioJudged(19.99, 0.1, rule, 1), { controlBound: 3 * 0.1, lineOver: false, controlOver: false });
  // At the ratio bound the line is red, on any runner.
  assert.equal(ratioJudged(20, 0.1, rule, 1).lineOver, true);
  assert.equal(ratioJudged(20, 0.1, rule, 4).lineOver, true);
  // A change that slows the line and its control together keeps the ratio and reds on the control.
  assert.deepEqual(ratioJudged(8, 3 * 0.1, rule, 1), { controlBound: 3 * 0.1, lineOver: false, controlOver: true });
  // A slower runner stretches the control's bound, and nothing else.
  assert.equal(ratioJudged(8, 3 * 0.1, rule, 1.2).controlOver, false);
});

test("a line's plain control keeps its head and its length (#720's list)", () => {
  assert.equal(plainLike("git push --force && echo x > ${a:-${a:-x}}"), `git push --force && echo x > ${"a".repeat(13)}`);
  assert.equal(plainLike("tee $a'a\\qa\\q'"), `tee ${"a".repeat(10)}`);
  assert.equal(plainLike("cp a $'x'", "b"), "cp bbbbbb");
  for (const command of ["git push --force && echo x > ${a:-${a:-x}}", "tee $a'a\\qa\\q'", "cp a $'x'"]) assert.equal(plainLike(command).length, command.length);
});

test("a cell kept on its fixed bound is judged on the least of three readings, the first and two more (#720's list)", () => {
  const asked: number[] = [];
  const reading = leastOfThree(2.5, (k) => {
    asked.push(k);
    return k === 1 ? 0.9 : 1.4;
  });
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(reading, { calls: [2.5, 0.9, 1.4], least: 0.9 });
  assert.equal(leastOfThree(0.3, () => 0.7).least, 0.3);
});
