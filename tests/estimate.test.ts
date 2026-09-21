import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { learnedCostPerStep, learnedStepUtilisation } from "../src/estimate.js";

/** A run folder with a synthetic log: `personas` testers, `steps` each, `cost` total. */
function runFolder(root: string, name: string, o: { personas: number; steps: number; cost: number; budget?: number; done?: boolean }) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const lines: Record<string, unknown>[] = [
    { ts: "2026-01-01T00:00:00.000Z", type: "phase", phase: "start", testers: o.personas, ...(o.budget ? { max_steps_per_agent: o.budget } : {}) },
  ];
  const perCall = o.cost / (o.personas * o.steps);
  for (let p = 0; p < o.personas; p++) {
    for (let i = 0; i < o.steps; i++) lines.push({ type: "llm_call", persona: `p${p}`, cost_usd: perCall });
    lines.push({ type: "persona_end", persona: `p${p}`, steps: o.steps });
  }
  if (o.done !== false) lines.push({ type: "phase", phase: "done" });
  writeFileSync(path.join(dir, "run.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("cost per step is learned from what runs actually spent", () => {
  const runs = mkdtempSync(path.join(tmpdir(), "usertests-est-"));
  runFolder(runs, "a", { personas: 4, steps: 10, cost: 0.40 }); // $0.01/step
  runFolder(runs, "b", { personas: 2, steps: 10, cost: 0.20 }); // $0.01/step
  assert.equal(learnedCostPerStep(runs)?.toFixed(4), "0.0100");
});

test("partial runs do not drag the learned rate", () => {
  const runs = mkdtempSync(path.join(tmpdir(), "usertests-est-partial-"));
  runFolder(runs, "good", { personas: 2, steps: 10, cost: 0.20 });          // $0.01/step
  runFolder(runs, "bailed", { personas: 2, steps: 1, cost: 0.50, done: false }); // would skew to $0.25
  assert.equal(learnedCostPerStep(runs)?.toFixed(4), "0.0100", "a run that stopped early says nothing about the rate");
});

test("no history means no learned rate — assumptions must be used instead", () => {
  assert.equal(learnedCostPerStep(mkdtempSync(path.join(tmpdir(), "usertests-empty-"))), null);
  assert.equal(learnedCostPerStep("/nonexistent/runs"), null);
});

test("step utilisation captures that personas stop before their budget", () => {
  const runs = mkdtempSync(path.join(tmpdir(), "usertests-util-"));
  // 15 of 30 steps used — the exact reason a budget-shaped estimate reads high.
  runFolder(runs, "a", { personas: 4, steps: 15, cost: 0.5, budget: 30 });
  assert.equal(learnedStepUtilisation(runs, 30)?.toFixed(2), "0.50");

  // Runs predating the budget being logged cannot be normalised, so are skipped.
  const legacy = mkdtempSync(path.join(tmpdir(), "usertests-legacy-"));
  runFolder(legacy, "old", { personas: 4, steps: 15, cost: 0.5 }); // no budget field
  assert.equal(learnedStepUtilisation(legacy, 30), null);
});
