/**
 * eta.ts — rough run-duration estimate from prior runs' run.log files.
 * Learns the average seconds-per-persona-step of THIS setup (model, target,
 * hardware) and scales linearly. Deliberately simple; no history → no ETA.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Average seconds per persona-step across past completed runs; null if none. */
export function estimateSecondsPerStep(runsDir: string): number | null {
  if (!existsSync(runsDir)) return null;
  const rates: number[] = [];
  for (const dir of readdirSync(runsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const logFile = path.join(runsDir, dir.name, "run.log");
    if (!existsSync(logFile)) continue;
    try {
      let start: number | null = null;
      let done: number | null = null;
      let steps = 0;
      for (const line of readFileSync(logFile, "utf8").trim().split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as { type?: string; phase?: string; ts?: string; steps?: number };
        if (e.type === "phase" && e.phase === "start") start = Date.parse(e.ts ?? "");
        if (e.type === "phase" && e.phase === "done") done = Date.parse(e.ts ?? "");
        if (e.type === "persona_end" && typeof e.steps === "number") steps += e.steps;
      }
      if (start && done && done > start && steps > 0) {
        rates.push((done - start) / 1000 / steps);
      }
    } catch {
      continue; // corrupt log — skip this run
    }
  }
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

const CHAIR_ALLOWANCE_SECONDS = 60;

export function estimateRunSeconds(
  runsDir: string,
  testerCount: number,
  maxSteps: number
): number | null {
  const rate = estimateSecondsPerStep(runsDir);
  if (rate === null) return null;
  return Math.round(rate * testerCount * maxSteps + CHAIR_ALLOWANCE_SECONDS);
}

export function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `~${m}m ${s}s` : `~${s}s`;
}
