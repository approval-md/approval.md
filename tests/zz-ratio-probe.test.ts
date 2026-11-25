/**
 * MEASUREMENT ONLY, not for merge (build-1, 25 Nov 2026, lead FINDING L62839).
 *
 * Prints what the walked-once cost case reads on this runner: user, system and
 * wall time of every call, both orders, so the 1.25 in merge group run
 * 45545546384 can be told apart: load, the order, system time, or a real cost.
 * Always passes.
 */

import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { classifyCommand, type ProtectedPathEntry } from "../src/core/command-class.js";

const TWO_ROUTES: ProtectedPathEntry[] = [
  { path: "SPEC.md", class: "policy.edit.spec" },
  { path: "design/", class: "policy.edit.design" },
  { path: ".github/workflows/", class: "policy.edit.ci" },
];

test("ratio probe: the walked-once cost case, every call timed three ways (measurement only)", () => {
  const SIZE = 512 * 1024;
  let words = "";
  for (let at = 0; words.length < SIZE; at += 1) words += `x${at} `;
  const timed = (run: () => void): [number, number, number] => {
    const wall = performance.now();
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    return [used.user / 1e6, used.system / 1e6, (performance.now() - wall) / 1e3];
  };
  const lines: Record<string, [string, string]> = {
    node: [`node x.js notes.txt design/x ${words}`, `node x.js .approval/env design/x ${words}`],
    cp: [`cp notes.txt design/x ${words}`, `cp .approval/env design/x ${words}`],
  };
  const fmt = (t: [number, number, number]): string => t.map((n) => n.toFixed(3)).join("/");
  for (const program of ["node", "cp", "node", "cp"]) {
    for (let rep = 0; rep < 4; rep += 1) {
      const controlFirst = rep % 2 === 0;
      const control: [number, number, number][] = [];
      const spent: [number, number, number][] = [];
      for (let round = 0; round < 5; round += 1) {
        const [controlLine, spentLine] = lines[program]!;
        if (controlFirst) control.push(timed(() => classifyCommand(controlLine, TWO_ROUTES)));
        spent.push(timed(() => classifyCommand(spentLine, TWO_ROUTES)));
        if (!controlFirst) control.push(timed(() => classifyCommand(controlLine, TWO_ROUTES)));
      }
      const least = (rows: [number, number, number][], pick: (row: [number, number, number]) => number): number => Math.min(...rows.map(pick));
      const cpu = (row: [number, number, number]): number => row[0] + row[1];
      const ratio = (pick: (row: [number, number, number]) => number): string => (least(spent, pick) / least(control, pick)).toFixed(3);
      console.log(
        `RATIOPROBE ${program} order=${controlFirst ? "control-first" : "spent-first"} cpu=${ratio(cpu)} user=${ratio((row) => row[0])} wall=${ratio((row) => row[2])}` +
          ` control[user/sys/wall]=${control.map(fmt).join(" ")} spent=${spent.map(fmt).join(" ")}`,
      );
    }
  }
});
