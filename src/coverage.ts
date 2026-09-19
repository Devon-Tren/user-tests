/**
 * coverage.ts — mapd-powered "coverage briefing" for the personas.
 *
 * Before the council runs, we ask mapd (static code cartography, deterministic,
 * no API key) two questions about the app under test:
 *
 *   1. `mapd map`      — what are the app's real surfaces? (routes, pages,
 *      entry points, workflows + confidence)
 *   2. `mapd tools test gaps` — which source files have NO real automated tests
 *      (vs padding tests that never import them)?
 *
 * The composed briefing steers every persona toward high-value untested flows.
 *
 * HARD RULE: this module NEVER throws. mapd is an optional accelerator — a
 * missing binary, a timeout, or a parse failure must never sink a test run.
 * Fail-open → return null → personas run exactly as they did before mapd.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MapdConfig } from "./config.js";

const execFileP = promisify(execFile);
const MAPD_TIMEOUT_MS = 15_000;
/** Per-section line caps keep the briefing inside its char budget. */
const MAX_ENTRY_LINES = 15;
const MAX_WORKFLOW_LINES = 10;

// Minimal typings over mapd's JSON — extra keys are ignored, missing ones tolerated.
interface MapdEntryPoint {
  file?: string;
  kind?: string;
  detail?: string;
}
interface MapdWorkflow {
  id?: string;
  files?: string[];
  confidence?: { score?: number };
}
interface MapdGraph {
  repoConfidence?: number;
  entryPoints?: MapdEntryPoint[];
  workflows?: MapdWorkflow[];
}
interface MapdGap {
  file?: string;
  status?: string;
}
interface MapdGaps {
  summary?: Record<string, unknown>;
  gaps?: MapdGap[];
}

const GAP_LABELS: Record<string, string> = {
  untested: "untested",
  "tested-nameonly": "tested-nameonly (a test exists but never imports this file)",
  "tested-shallow": "tested-shallow",
};
const GAP_PRIORITY: Record<string, number> = { untested: 0, "tested-nameonly": 1, "tested-shallow": 2 };

async function runMapd(
  cfg: { path: string },
  args: string[],
  repoPath: string
): Promise<{ stdout: string }> {
  // execFile resolves bare names via PATH and absolute paths directly.
  return execFileP(cfg.path, args, {
    cwd: repoPath,
    timeout: MAPD_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024, // big repos emit big JSON
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function capLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… (${lines.length - max} more)`];
}

/**
 * Raw mapd primitives for other modules (serve.ts architecture view).
 * These THROW on failure — callers decide how to fail (briefing is fail-open,
 * the architecture tab shows an error).
 */
export async function fetchMapdGraph(repoPath: string, cfg: { path: string }): Promise<MapdGraph> {
  const tmp = mkdtempSync(path.join(tmpdir(), "usertests-mapd-"));
  const graphFile = path.join(tmp, "graph.json");
  try {
    await runMapd(cfg, ["map", "--json", graphFile, "."], repoPath);
    return JSON.parse(readFileSync(graphFile, "utf8")) as MapdGraph;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function fetchMapdGaps(repoPath: string, cfg: { path: string }): Promise<MapdGaps> {
  const { stdout } = await runMapd(cfg, ["tools", "test", "gaps", "--json", "."], repoPath);
  return JSON.parse(stdout) as MapdGaps;
}

/**
 * Build the coverage briefing for repoPath. Returns null when mapd is disabled,
 * unavailable, or unhappy — callers then run personas without it.
 */
export async function buildCoverageBriefing(
  repoPath: string,
  cfg: MapdConfig,
  log: (msg: string) => void
): Promise<string | null> {
  if (!cfg.enabled) return null;

  let graph: MapdGraph;
  let gaps: MapdGaps;
  try {
    graph = await fetchMapdGraph(repoPath, cfg);
  } catch (e) {
    const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
    log(`mapd map failed (${reason}) — running without coverage briefing`);
    return null;
  }
  try {
    gaps = await fetchMapdGaps(repoPath, cfg);
  } catch (e) {
    const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
    log(`mapd test gaps failed (${reason}) — briefing covers routes only`);
    gaps = {};
  }

  // --- Section 1: app surfaces -------------------------------------------
  const entries = graph.entryPoints ?? [];
  // "import-root" is the fallback kind ("not imported by any file") — noise when
  // real routes/pages were detected, signal when nothing else was.
  const nonRoot = entries.filter((e) => e.kind !== "import-root");
  const surfaceLines =
    nonRoot.length > 0
      ? nonRoot.map((e) => `- ${e.kind}: ${e.file}${e.detail ? ` (${e.detail})` : ""}`)
      : entries.map((e) => `- ${e.file} (not imported by any other file — likely an entry point)`);
  const workflowLines = (graph.workflows ?? []).map(
    (w) => `- ${w.id} — ${w.files?.length ?? 0} files, confidence ${(w.confidence?.score ?? 0).toFixed(2)}`
  );

  const header = [
    "===== mapd: app surfaces (static analysis of the source) =====",
    ...capLines(surfaceLines, MAX_ENTRY_LINES),
    ...(workflowLines.length > 0
      ? ["", "===== mapd: workflows =====", ...capLines(workflowLines, MAX_WORKFLOW_LINES)]
      : []),
    ...(typeof graph.repoConfidence === "number"
      ? [`repo confidence: ${graph.repoConfidence.toFixed(2)}`]
      : []),
  ].join("\n");

  // --- Section 2: untested files (fill whatever budget remains) -----------
  const sorted = [...(gaps.gaps ?? [])].sort(
    (a, b) => (GAP_PRIORITY[a.status ?? ""] ?? 9) - (GAP_PRIORITY[b.status ?? ""] ?? 9)
  );
  const summary = gaps.summary ?? {};
  const counts = ["untested", "tested-nameonly", "tested-shallow"]
    .filter((k) => typeof summary[k] === "number" && (summary[k] as number) > 0)
    .map((k) => `${summary[k]} ${k}`)
    .join(", ");
  const gapsHeader = "===== mapd: files with no real automated tests =====" + (counts ? ` (${counts})` : "");

  const budget = cfg.max_chars;
  const lines: string[] = [header, "", gapsHeader];
  for (const g of sorted) {
    if (!g.file) continue;
    const line = `- ${g.file} (${GAP_LABELS[g.status ?? ""] ?? g.status ?? "unknown"})`;
    if (lines.join("\n").length + line.length + 1 > budget) {
      lines.push("… (truncated — more untested files exist)");
      break;
    }
    lines.push(line);
  }

  // Nothing useful mapped (e.g. a static HTML app mapd can't parse) — an empty
  // "coverage map" would only confuse the personas, so skip it entirely.
  if (surfaceLines.length === 0 && workflowLines.length === 0 && sorted.length === 0) {
    log("mapd found no routes, workflows, or test gaps — skipping briefing");
    return null;
  }

  const briefing = lines.join("\n");
  return briefing.length > budget ? briefing.slice(0, budget) + "\n… (truncated)" : briefing;
}
