/**
 * chair.ts — runs after all testers finish.
 *
 *  1. Reads every persona's findings JSON.
 *  2. ONE LLM call (chair.md persona): dedupe + rank, capped by
 *     max_findings_per_run (lowest-severity overflow goes to the appendix).
 *  3. Repro verification: for findings at or above min_severity_to_verify,
 *     mechanically replays the source persona's recorded action log in a FRESH
 *     browser session. Replay failure ⇒ "unverified" in the appendix.
 *     (Minor findings are never replayed and are reported as "unverified".)
 *  4. Goal-gap findings are collected separately for the Goal Gaps section.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { callLLM } from "../llm.js";
import { replayLog, type ActionLogEntry } from "../runner.js";
import type { ChairConfig, Severity } from "../config.js";
import type { Finding } from "./tester.js";
import type { RunLogger } from "../logger.js";

export interface MergedFinding {
  title: string;
  severity: Severity;
  category: string;
  found_by: string[];
  steps: string[];
  expected: string;
  actual: string;
  screenshot?: string;
  goal_gap: boolean;
  /** Replay provenance: which persona's log + step to replay for verification. */
  source_persona: string;
  atStep: number;
}

export type ReproStatus = "confirmed" | "unverified" | "not-checked";

export interface ReportFinding extends MergedFinding {
  repro: ReproStatus;
  reproNote?: string;
}

export interface ChairResult {
  main: ReportFinding[];
  appendix: ReportFinding[];
  goalGaps: ReportFinding[];
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };

interface PersonaFindingsFile {
  persona: string;
  findings: Finding[];
}

function readAllFindings(runDir: string, personas: string[]): PersonaFindingsFile[] {
  const out: PersonaFindingsFile[] = [];
  for (const persona of personas) {
    const file = path.join(runDir, "findings", `${persona}.json`);
    if (!existsSync(file)) continue;
    try {
      out.push(JSON.parse(readFileSync(file, "utf8")) as PersonaFindingsFile);
    } catch (e) {
      throw new Error(
        `Chair could not parse findings file ${file}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  return out;
}

function buildChairUserPrompt(all: PersonaFindingsFile[]): string {
  const payload = all.map((pf) => ({
    persona: pf.persona,
    findings: pf.findings.map((f) => ({ ...f, found_by: [pf.persona] })),
  }));
  return `Here are all findings filed by the council, grouped by persona (JSON):

${JSON.stringify(payload, null, 2)}

Dedupe and rank them per your instructions. Reply with ONE JSON object, no prose:
{
  "findings": [
    {
      "title": "…",
      "severity": "critical|major|minor",
      "category": "confusion|goal-gap|bug|a11y|polish",
      "found_by": ["persona-a", "persona-b"],
      "steps": ["1. …"],
      "expected": "…",
      "actual": "…",
      "screenshot": "shots/….png" | null,
      "goal_gap": true | false,
      "source_persona": "persona whose action log best reproduces this",
      "atStep": <step number in that persona's log>
    }
  ]
}
Order by severity (critical first). Include every distinct root cause.`;
}

function validateMerged(value: unknown): MergedFinding[] {
  if (typeof value !== "object" || value === null) return [];
  const list = (value as Record<string, unknown>)["findings"];
  if (!Array.isArray(list)) return [];
  const out: MergedFinding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    const title = typeof f["title"] === "string" ? f["title"].trim() : "";
    const severity = f["severity"];
    if (!title || !["critical", "major", "minor"].includes(String(severity))) continue;
    out.push({
      title,
      severity: severity as Severity,
      category: typeof f["category"] === "string" ? f["category"] : "bug",
      found_by: Array.isArray(f["found_by"]) ? f["found_by"].map(String) : [],
      steps: Array.isArray(f["steps"]) ? f["steps"].map(String) : [],
      expected: typeof f["expected"] === "string" ? f["expected"] : "",
      actual: typeof f["actual"] === "string" ? f["actual"] : "",
      screenshot: typeof f["screenshot"] === "string" ? f["screenshot"] : undefined,
      goal_gap: f["goal_gap"] === true,
      source_persona: typeof f["source_persona"] === "string" ? f["source_persona"] : "",
      atStep: typeof f["atStep"] === "number" ? f["atStep"] : 0,
    });
  }
  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

function needsVerification(sev: Severity, chair: ChairConfig): boolean {
  return SEV_ORDER[sev] <= SEV_ORDER[chair.min_severity_to_verify];
}

/** Cap per-finding snapshot size so the batched pruning call stays cheap. */
const PRUNE_SNAPSHOT_CHARS = 4_000;

/**
 * False-positive pruning: ONE batched LLM call comparing each replay-CONFIRMED
 * finding's claim against the actual end-of-replay page snapshot. Contradicted
 * claims are demoted to the appendix. Fails open — a bad/absent LLM reply
 * prunes nothing, so tester work is never lost here.
 */
async function pruneContradicted(
  main: ReportFinding[],
  confirmed: { mainIndex: number; snapshot: string }[],
  appendix: ReportFinding[],
  opts: { logger?: RunLogger; onProgress?: (msg: string) => void }
): Promise<void> {
  const payload = confirmed.map(({ mainIndex, snapshot }) => ({
    index: mainIndex,
    title: main[mainIndex]!.title,
    expected: main[mainIndex]!.expected,
    actual: main[mainIndex]!.actual,
    replay_snapshot: snapshot.slice(0, PRUNE_SNAPSHOT_CHARS),
  }));
  const user = `Each item below is a user-testing finding whose reproduction was mechanically replayed in a fresh browser, plus the actual page state (accessibility snapshot) at the end of that replay.

${JSON.stringify(payload, null, 2)}

An item is CONTRADICTED only if its replay snapshot clearly shows the claim (expected/actual) is false — e.g. it claims a white screen but the snapshot shows a full page, or claims a missing element that is plainly present. When in doubt, do NOT flag it.
Reply with ONE JSON object, no prose: {"contradicted": [<index>, ...]} (empty list if none).`;

  let text: string;
  try {
    const resp = await callLLM({
      system:
        "You are a strict fact-checker for a user-testing council. You only flag a finding when the provided page snapshot directly contradicts its claim. You never flag on suspicion. Output JSON only.",
      user,
    });
    opts.logger?.event("llm_call", {
      persona: "chair-prune",
      model: resp.model,
      provider: resp.provider,
      duration_ms: resp.durationMs,
      input_tokens: resp.inputTokens,
      output_tokens: resp.outputTokens,
      cost_usd: resp.costUsd,
    });
    text = resp.text;
  } catch (e) {
    opts.onProgress?.(
      `pruning skipped (${e instanceof Error ? e.message.split("\n")[0] : e}) — findings kept`
    );
    return;
  }

  let indices: number[] = [];
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const list = parsed["contradicted"];
      if (Array.isArray(list)) {
        const valid = new Set(confirmed.map((c) => c.mainIndex));
        indices = list.filter((i): i is number => Number.isInteger(i) && valid.has(i as number));
      }
    }
  } catch {
    // unparseable → prune nothing
  }

  const drop = new Set(indices);
  for (let i = main.length - 1; i >= 0; i--) {
    if (!drop.has(i)) continue;
    const [f] = main.splice(i, 1);
    appendix.push({
      ...f!,
      repro: "unverified",
      reproNote: "contradicted by replay snapshot (false-positive pruning)",
    });
    opts.logger?.event("prune", { title: f!.title });
    opts.onProgress?.(`pruned (contradicted by replay snapshot): ${f!.title}`);
  }
}

export async function runChair(opts: {
  runDir: string;
  personas: string[];
  chairPersonaFile: string;
  chairConfig: ChairConfig;
  target: string;
  viewport: { width: number; height: number };
  logger?: RunLogger;
  onProgress?: (msg: string) => void;
}): Promise<ChairResult> {
  const all = readAllFindings(opts.runDir, opts.personas);
  const totalRaw = all.reduce((n, p) => n + p.findings.length, 0);
  opts.onProgress?.(`read ${totalRaw} raw findings from ${all.length} personas`);

  if (totalRaw === 0) {
    return { main: [], appendix: [], goalGaps: [] };
  }

  const system = readFileSync(opts.chairPersonaFile, "utf8");
  let raw: string | null = null;
  try {
    const resp = await callLLM({ system, user: buildChairUserPrompt(all) });
    opts.logger?.event("llm_call", {
      persona: "chair",
      model: resp.model,
      provider: resp.provider,
      duration_ms: resp.durationMs,
      input_tokens: resp.inputTokens,
      output_tokens: resp.outputTokens,
      cost_usd: resp.costUsd,
    });
    raw = resp.text;
  } catch (e) {
    // A thrown LLM error (including budget caps) must never lose tester work —
    // fall through to the deterministic unmerged fallback below.
    opts.onProgress?.(
      `chair LLM call failed (${e instanceof Error ? e.message : e}) — falling back to unmerged findings`
    );
  }

  let merged: MergedFinding[] | null = null;
  if (raw) {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      const v = validateMerged(parsed);
      if (v.length > 0) merged = v;
    }
  } catch {
    // fall through to the no-LLM merge below
  }
  }

  if (!merged) {
    // Deterministic fallback: never lose tester work because of one bad reply.
    // Findings are passed through unmerged rather than dropped; the appendix
    // path still applies, and the report states dedupe was skipped.
    opts.onProgress?.("chair LLM reply unparseable — falling back to unmerged findings");
    merged = all.flatMap((pf) =>
      pf.findings.map((f) => ({
        ...f,
        category: String(f.category),
        found_by: [pf.persona],
        goal_gap: f.category === "goal-gap",
        source_persona: pf.persona,
      }))
    );
  }

  // Enforce max_findings_per_run: lowest-severity overflow → appendix.
  const capped = merged.slice(0, opts.chairConfig.max_findings_per_run);
  const overflow = merged.slice(opts.chairConfig.max_findings_per_run);

  const main: ReportFinding[] = [];
  const appendix: ReportFinding[] = overflow.map((f) => ({
    ...f,
    repro: "not-checked",
    reproNote: "dropped by max_findings_per_run cap",
  }));
  const confirmed: { mainIndex: number; snapshot: string }[] = [];

  for (const finding of capped) {
    if (!opts.chairConfig.verify_repro || !needsVerification(finding.severity, opts.chairConfig)) {
      // Below the verification threshold (minors with default config): never
      // replayed, reported in the appendix as "unverified" with the reason.
      appendix.push({
        ...finding,
        repro: "unverified",
        reproNote: `below verification threshold (${finding.severity} < ${opts.chairConfig.min_severity_to_verify})`,
      });
      continue;
    }

    const logFile = path.join(opts.runDir, "findings", `${finding.source_persona}.actions.json`);
    if (!existsSync(logFile) || finding.atStep < 1) {
      appendix.push({
        ...finding,
        repro: "unverified",
        reproNote: "no replayable action log (fabricated or missing provenance)",
      });
      opts.onProgress?.(`unverified (no log): ${finding.title}`);
      continue;
    }

    const log = JSON.parse(readFileSync(logFile, "utf8")) as ActionLogEntry[];
    const result = await replayLog(log, finding.atStep, opts.target, opts.viewport);
    if (result.ok) {
      main.push({ ...finding, repro: "confirmed" });
      confirmed.push({ mainIndex: main.length - 1, snapshot: result.snapshot ?? "" });
      opts.onProgress?.(`confirmed: ${finding.title}`);
    } else {
      appendix.push({
        ...finding,
        repro: "unverified",
        reproNote: `replay failed at step ${result.failedAtStep}: ${result.error}`,
      });
      opts.onProgress?.(`unverified (replay failed): ${finding.title}`);
    }
  }

  if (opts.chairConfig.false_positive_pruning && confirmed.length > 0) {
    await pruneContradicted(main, confirmed, appendix, opts);
  }

  const goalGaps = main.filter((f) => f.goal_gap || f.category === "goal-gap");
  return { main, appendix, goalGaps };
}
