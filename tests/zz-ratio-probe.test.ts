/**
 * MEASUREMENT ONLY, not for merge (build-1, 25 Nov 2026, lead FINDING L62839).
 *
 * Round 2. Round 1 showed the node pair of the walked-once cost case centred
 * near 1.0 on GitHub's runner (0.90 to 1.10 over 8 samples, each call 1.0 to
 * 2.1 s, the runner's speed moving in phases of seconds). This prints, on the
 * same runner and under the shard's own load, three designs side by side:
 *   old    512 KiB, 5 rounds in turn, least of each side (the test in #707)
 *   pairs  64 KiB, 40 rounds, order alternating, the MEDIAN of the per-round
 *          ratios (each ratio from two calls made back to back)
 *   plant  the same as pairs with the credential side doing 1.5 times the work
 * Always passes. The same file is copied under three names so each shard runs one.
 */

import { test } from "node:test";

import { classifyCommand, type ProtectedPathEntry } from "../src/core/command-class.js";

const TWO_ROUTES: ProtectedPathEntry[] = [
  { path: "SPEC.md", class: "policy.edit.spec" },
  { path: "design/", class: "policy.edit.design" },
  { path: ".github/workflows/", class: "policy.edit.ci" },
];

const wordsOf = (size: number): string => {
  let words = "";
  for (let at = 0; words.length < size; at += 1) words += `x${at} `;
  return words;
};
const cpu = (run: () => void): number => {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
};
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

test("ratio probe, round 2: three designs of the walked-once cost case on this runner (measurement only)", () => {
  const big = wordsOf(512 * 1024);
  const small = wordsOf(64 * 1024);
  const half = small.slice(0, small.length / 2);
  const control = (words: string) => (): void => void classifyCommand(`node x.js notes.txt design/x ${words}`, TWO_ROUTES);
  const spent = (words: string) => (): void => void classifyCommand(`node x.js .approval/env design/x ${words}`, TWO_ROUTES);
  const planted = (): void => {
    spent(small)();
    spent(half)();
  };
  const pairs = (controlRun: () => void, spentRun: () => void, rounds: number): { ratios: number[]; controls: number[]; spents: number[] } => {
    const ratios: number[] = [];
    const controls: number[] = [];
    const spents: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      let c: number;
      let s: number;
      if (round % 2 === 0) {
        c = cpu(controlRun);
        s = cpu(spentRun);
      } else {
        s = cpu(spentRun);
        c = cpu(controlRun);
      }
      controls.push(c);
      spents.push(s);
      ratios.push(s / c);
    }
    return { ratios, controls, spents };
  };
  // Warm both lines once so the first round is not the compiler's.
  control(small)();
  spent(small)();
  for (let rep = 0; rep < 6; rep += 1) {
    const old = pairs(control(big), spent(big), 5);
    console.log(`RATIOPROBE2 old rep=${rep} leastleast=${(Math.min(...old.spents) / Math.min(...old.controls)).toFixed(3)} median=${median(old.ratios).toFixed(3)} control=${old.controls.map((n) => n.toFixed(2)).join(",")}`);
    for (let sub = 0; sub < 3; sub += 1) {
      const now = pairs(control(small), spent(small), 40);
      console.log(
        `RATIOPROBE2 pairs rep=${rep}.${sub} median=${median(now.ratios).toFixed(3)} leastleast=${(Math.min(...now.spents) / Math.min(...now.controls)).toFixed(3)}` +
          ` min=${Math.min(...now.ratios).toFixed(3)} max=${Math.max(...now.ratios).toFixed(3)} controlLeast=${Math.min(...now.controls).toFixed(3)} controlMost=${Math.max(...now.controls).toFixed(3)}`,
      );
    }
    const plant = pairs(control(small), planted, 40);
    console.log(`RATIOPROBE2 plant rep=${rep} median=${median(plant.ratios).toFixed(3)} leastleast=${(Math.min(...plant.spents) / Math.min(...plant.controls)).toFixed(3)} min=${Math.min(...plant.ratios).toFixed(3)} max=${Math.max(...plant.ratios).toFixed(3)}`);
  }
});
