/**
 * estimate.ts — the pre-run cost/time estimate, in one place.
 *
 * The CLI prints it; the dashboard shows it in a confirm dialog before it will
 * start a run. Both must quote the same number, so the arithmetic lives here
 * rather than being duplicated per caller.
 */
import { currentModel, estimateCostUsd } from "./llm.js";
import { estimateRunSeconds, formatEta } from "./eta.js";
import type { CouncilConfig } from "./config.js";

/** Rough per-call token assumptions (screenshot + briefing included). */
const EST_STEP_TOKENS = { input: 6_000, output: 300 };
const EST_CHAIR_TOKENS = { input: 20_000, output: 4_000 };

export interface RunEstimate {
  provider: string;
  model: string;
  /** Estimated LLM calls: tester steps + the chair. */
  calls: number;
  costUsd: number;
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
  const etaSeconds =
    runsDir === null ? null : estimateRunSeconds(runsDir, testerCount, config.max_steps_per_agent);
  return {
    provider,
    model,
    calls: testerCalls + 1, // + chair
    costUsd,
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
    `estimate: ~${est.calls} LLM calls, ~$${est.costUsd.toFixed(2)} on ${est.model} ` +
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
