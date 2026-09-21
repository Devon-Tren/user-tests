/**
 * estimate.ts — the pre-run cost/time estimate, in one place.
 *
 * The CLI prints it; the dashboard shows it in a confirm dialog before it will
 * start a run. Both must quote the same number, so the arithmetic lives here
 * rather than being duplicated per caller.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentModel, estimateCostUsd } from "./llm.js";
import { estimateRunSeconds, formatEta } from "./eta.js";
import type { CouncilConfig } from "./config.js";

/** Rough per-call token assumptions (screenshot + briefing included). */
const EST_STEP_TOKENS = { input: 6_000, output: 300 };
const EST_CHAIR_TOKENS = { input: 20_000, output: 4_000 };

/**
 * What prior runs ACTUALLY cost, per persona-step.
 *
 * The token assumptions below are a worst case and measured ~3.4x high: they
 * price every persona burning its whole step budget, when real personas stop
 * as soon as they have seen enough. Once there is history, believe the history
 * — the same way eta.ts already learns seconds-per-step.
 */
export function learnedCostPerStep(runsDir: string): number | null {
  if (!existsSync(runsDir)) return null;
  let cost = 0;
  let steps = 0;
  for (const dir of readdirSync(runsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const logFile = path.join(runsDir, dir.name, "run.log");
    if (!existsSync(logFile)) continue;
    try {
      let runCost = 0;
      let runSteps = 0;
      let done = false;
      for (const line of readFileSync(logFile, "utf8").trim().split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as { type?: string; phase?: string; steps?: number; cost_usd?: number };
        if (e.type === "llm_call") runCost += e.cost_usd ?? 0;
        if (e.type === "persona_end" && typeof e.steps === "number") runSteps += e.steps;
        if (e.type === "phase" && e.phase === "done") done = true;
      }
      // Partial runs would bias the rate — they stopped for reasons unrelated to cost.
      if (done && runSteps > 0 && runCost > 0) {
        cost += runCost;
        steps += runSteps;
      }
    } catch {
      continue; // corrupt log — skip this run
    }
  }
  return steps > 0 ? cost / steps : null;
}

/** Steps a persona actually uses, as a fraction of its budget. Null without history. */
export function learnedStepUtilisation(runsDir: string, plannedSteps: number): number | null {
  if (!existsSync(runsDir) || plannedSteps <= 0) return null;
  const ratios: number[] = [];
  for (const dir of readdirSync(runsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const logFile = path.join(runsDir, dir.name, "run.log");
    if (!existsSync(logFile)) continue;
    try {
      let budget: number | null = null;
      let personas = 0;
      let steps = 0;
      let done = false;
      for (const line of readFileSync(logFile, "utf8").trim().split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as { type?: string; phase?: string; steps?: number; max_steps_per_agent?: number };
        if (e.type === "phase" && e.phase === "start" && typeof e.max_steps_per_agent === "number") {
          budget = e.max_steps_per_agent;
        }
        if (e.type === "persona_end" && typeof e.steps === "number") { steps += e.steps; personas += 1; }
        if (e.type === "phase" && e.phase === "done") done = true;
      }
      // Runs predating the budget being logged cannot be normalised — skip them.
      if (done && budget && personas > 0 && steps > 0) ratios.push(steps / (personas * budget));
    } catch {
      continue;
    }
  }
  if (ratios.length === 0) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

export interface RunEstimate {
  provider: string;
  model: string;
  /** Estimated LLM calls: tester steps + the chair. */
  calls: number;
  /** Worst case: every persona burns its whole step budget. */
  costUsd: number;
  /** What a run like this has actually cost, when there is history to say. */
  typicalUsd: number | null;
  /** "measured" once prior runs inform the number, else "assumed". */
  basis: "measured" | "assumed";
  /** Seconds, learned from prior runs — null when there is no history yet. */
  etaSeconds: number | null;
  /** Human form of etaSeconds, or null. */
  eta: string | null;
  /** True when the estimate already exceeds limits.max_cost_usd (the run will stop early). */
  exceedsCostCap: boolean;
  caps: { maxCalls: number; maxCostUsd: number | null; maxRunMinutes: number };
}

/**
 * Estimate a run without touching the network or needing an API key —
 * currentModel() resolves the model from env alone, precisely so estimates are free.
 */
export function estimateRun(
  config: CouncilConfig,
  testerCount: number,
  runsDir: string | null
): RunEstimate {
  const { provider, model } = currentModel();
  const testerCalls = testerCount * config.max_steps_per_agent;
  const stepCost = estimateCostUsd(model, EST_STEP_TOKENS.input, EST_STEP_TOKENS.output) ?? 0;
  const chairCost = estimateCostUsd(model, EST_CHAIR_TOKENS.input, EST_CHAIR_TOKENS.output) ?? 0;
  const costUsd = testerCalls * stepCost + chairCost;

  // History beats assumption. Personas stop early, so the budget-shaped number
  // above is a ceiling, not a forecast — say both rather than pick one.
  const perStep = runsDir === null ? null : learnedCostPerStep(runsDir);
  const utilisation = runsDir === null ? null : learnedStepUtilisation(runsDir, config.max_steps_per_agent);
  const typicalUsd =
    perStep === null ? null : perStep * testerCalls * (utilisation ?? 1) + chairCost;

  const etaSeconds =
    runsDir === null ? null : estimateRunSeconds(runsDir, testerCount, config.max_steps_per_agent);
  return {
    provider,
    model,
    calls: testerCalls + 1, // + chair
    costUsd,
    typicalUsd,
    basis: typicalUsd === null ? "assumed" : "measured",
    etaSeconds,
    eta: etaSeconds === null ? null : formatEta(etaSeconds),
    exceedsCostCap: config.limits.max_cost_usd !== null && costUsd > config.limits.max_cost_usd,
    caps: {
      maxCalls: config.limits.max_llm_calls,
      maxCostUsd: config.limits.max_cost_usd,
      maxRunMinutes: config.limits.max_run_minutes,
    },
  };
}

/** The CLI's one-or-two-line rendering of an estimate. */
export function formatEstimate(est: RunEstimate): string[] {
  const lines = [
    (est.typicalUsd !== null
      ? `estimate: ~${est.calls} LLM calls, ~$${est.typicalUsd.toFixed(2)} typical / $${est.costUsd.toFixed(2)} max on ${est.model} `
      : `estimate: ~${est.calls} LLM calls, ~$${est.costUsd.toFixed(2)} on ${est.model} `) +
      `(caps: ${est.caps.maxCalls} calls` +
      (est.caps.maxCostUsd !== null ? `, $${est.caps.maxCostUsd.toFixed(2)}` : ", no cost cap") +
      `, ${est.caps.maxRunMinutes}min wall-clock)`,
  ];
  if (est.exceedsCostCap && est.caps.maxCostUsd !== null) {
    lines.push(
      `WARNING: estimate (~$${est.costUsd.toFixed(2)}) exceeds limits.max_cost_usd ` +
        `($${est.caps.maxCostUsd.toFixed(2)}) — the run will stop early when the cap is hit.`
    );
  }
  return lines;
}
