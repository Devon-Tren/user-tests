/**
 * ask.ts — interrogate a completed run: "did anyone test the settings page?",
 * "why is this critical?", "what did chaos-hunter actually do on step 12?"
 *
 * Design: read-only, one LLM call per question, grounded ONLY in the run's
 * artifacts (REPORT.md + per-persona findings/step logs + run metadata).
 * Every answer must cite its source (finding code, persona, step); when the
 * artifacts don't cover something, the honest answer is "no tester covered
 * this" — which is itself valuable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { callLLM } from "./llm.js";
import { RunLogger } from "./logger.js";

const STEP_REASONING_CHARS = 300;

interface StepDigest {
  step: number;
  action: string;
  ok?: boolean;
  error?: string;
  reasoning?: string;
  finding?: { title: string; severity: string; category: string };
}

function digestRun(runDir: string): {
  meta: Record<string, unknown>;
  report: string;
  personas: unknown[];
} {
  const reportPath = path.join(runDir, "REPORT.md");
  if (!existsSync(reportPath)) {
    throw new Error(`No REPORT.md in ${runDir} — is that a finished run folder?`);
  }

  // Metadata from the run.log envelope (first = phase:start, last = phase:done).
  let meta: Record<string, unknown> = { run: path.basename(runDir) };
  const logPath = path.join(runDir, "run.log");
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      meta = {
        run: path.basename(runDir),
        target: first["target"],
        testers: first["testers"],
        persona_hashes: first["persona_hashes"],
        llm_calls: last["llm_calls"],
        cost_usd: last["cost_usd"],
        partial: last["partial"],
      };
    } catch {
      // meta stays minimal — the report itself is the real context
    }
  }

  const findingsDir = path.join(runDir, "findings");
  const personas = readdirSync(findingsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".actions.json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(path.join(findingsDir, f), "utf8")) as {
        persona: string;
        steps: (Record<string, unknown> & { reasoning?: string; finding?: unknown })[];
        findings: unknown[];
        stoppedReason?: string;
      };
      const steps: StepDigest[] = raw.steps.map((s) => ({
        step: s["step"] as number,
        action: s["action"] as string,
        ok: s["ok"] as boolean | undefined,
        error: s["error"] as string | undefined,
        reasoning: s.reasoning?.slice(0, STEP_REASONING_CHARS),
        finding: s.finding
          ? {
              title: (s.finding as { title: string }).title,
              severity: (s.finding as { severity: string }).severity,
              category: (s.finding as { category: string }).category,
            }
          : undefined,
      }));
      return { persona: raw.persona, stoppedReason: raw.stoppedReason ?? null, steps, findings: raw.findings };
    });

  return { meta, report: readFileSync(reportPath, "utf8"), personas };
}

const SYSTEM = `You are the analyst for a completed user-testing council run. Several LLM personas explored a web app in a real browser, filed findings, and a chair deduped/verified them into REPORT.md.

Rules:
- Answer ONLY from the provided artifacts (REPORT.md, per-persona step logs, metadata). Never invent results.
- Cite sources inline: finding codes from REPORT.md (e.g. C-1, M-3) and/or [persona step N].
- If the artifacts do not cover the question, say exactly that ("no tester covered this", "the artifacts don't show …") — do not guess.
- Be concise. Markdown is fine.`;

export async function askRun(
  question: string,
  runDir: string,
  logger?: RunLogger
): Promise<{ answer: string; costUsd: number | null }> {
  const { meta, report, personas } = digestRun(runDir);
  const user = [
    `=== RUN METADATA ===\n${JSON.stringify(meta, null, 2)}`,
    `=== REPORT.md ===\n${report}`,
    `=== PER-PERSONA STEP LOGS + FINDINGS ===\n${JSON.stringify(personas, null, 2)}`,
    `=== QUESTION ===\n${question}`,
  ].join("\n\n");

  const resp = await callLLM({ system: SYSTEM, user });
  logger?.event("ask", {
    run: path.basename(runDir),
    question: question.slice(0, 200),
    model: resp.model,
    input_tokens: resp.inputTokens,
    output_tokens: resp.outputTokens,
    cost_usd: resp.costUsd,
  });
  return { answer: resp.text, costUsd: resp.costUsd };
}
