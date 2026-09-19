/**
 * chat.ts — continuous Q&A session over a completed run: "did anyone test
 * the settings page?", "why is this critical?", "what did chaos-hunter
 * actually do on step 12?"
 *
 * Design: read-only, one LLM call per turn, grounded ONLY in the run's
 * artifacts (REPORT.md + per-persona findings/step logs + run metadata).
 * The run digest is loaded ONCE per session; each turn also sees the
 * conversation so far, so follow-ups ("why?", "what about C-2?") work.
 * Every answer must cite its source (finding code, persona, step); when the
 * artifacts don't cover something, the honest answer is "no tester covered
 * this" — which is itself valuable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { callLLM } from "./llm.js";
import { RunLogger } from "./logger.js";
import { artifactCatalogue, readArtifact } from "./artifacts.js";

const STEP_REASONING_CHARS = 300;
/** Artifact pulls: how much the analyst may inline, and how often it may ask. */
const PULL_MAX_ROUNDS = 2;
const PULL_CHARS_PER_FILE = 30_000;
const PULL_CHARS_TOTAL = 90_000;
/** Follow-ups stay cheap: only the most recent turns ride along, truncated. */
const HISTORY_TURNS = 20;
const HISTORY_ANSWER_CHARS = 1500;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

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
  mergedFindings: unknown[];
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

  // Chair-merged findings (findings-merged.json) — the verified repro steps,
  // expected/actual, filing step. Richer than the raw per-persona copies.
  const mergedFindings: unknown[] = [];
  const mergedPath = path.join(runDir, "findings-merged.json");
  if (existsSync(mergedPath)) {
    try {
      const raw = JSON.parse(readFileSync(mergedPath, "utf8")) as { findings?: Record<string, unknown>[] };
      for (const f of (raw.findings ?? []).slice(0, 30)) {
        mergedFindings.push({
          code: f["code"],
          severity: f["severity"],
          title: String(f["title"] ?? "").slice(0, 300),
          category: f["category"],
          found_by: f["found_by"],
          repro: f["repro"],
          steps: Array.isArray(f["steps"]) ? (f["steps"] as unknown[]).slice(0, 12).map((s) => String(s).slice(0, 220)) : [],
          expected: String(f["expected"] ?? "").slice(0, 400),
          actual: String(f["actual"] ?? "").slice(0, 400),
          atStep: f["atStep"],
          goal_gap: f["goal_gap"] ?? false,
        });
      }
    } catch {
      // corrupt merged file — per-persona findings still cover it
    }
  }

  return { meta, report: readFileSync(reportPath, "utf8"), personas, mergedFindings };
}

const SYSTEM = `You are the analyst for a completed user-testing council run. Several LLM personas explored a web app in a real browser, filed findings, and a chair deduped/verified them into REPORT.md. When a CODE MAP section is present, it is a static analysis of the project's source (mapd: files, functions, what each function calls, imports, workflows, which files have real automated tests).

Rules:
- Answer ONLY from the provided artifacts (REPORT.md, merged findings, per-persona step logs, code map when present, metadata). Never invent results, files, or functions.
- Cite sources inline: finding codes (e.g. C-1, M-3) and/or [persona step N] for test evidence; file paths (e.g. src/server.js) for code claims.
- You can answer BOTH kinds of questions:
  * testing/QA — what broke, who found it, how to reproduce, what was verified
  * architecture/coverage (when the code map is present) — what a file or function does, how modules import each other, which workflows exist, which files lack real tests and whether the testers covered them anyway
- Connect the two when relevant: e.g. a finding's likely root cause given what the code map shows; whether an untested file was exercised by the personas.
- If the artifacts do not cover the question, say exactly that ("no tester covered this", "the code map doesn't show …") — do not guess.
- An ARTIFACT CATALOGUE lists every file this run wrote. The digests above are summaries; when a question needs the raw file — the exact action trace, a full step log, the event log, the cached code map — pull it instead of guessing. Reply with ONLY this block and nothing else:
\`\`\`pull
{"artifacts":["findings/chaos-hunter.actions.json"]}
\`\`\`
  The files come back inlined and you answer on the next turn. Ask for at most 3 at a time, only files listed in the catalogue, and only when the summaries genuinely fall short — a pull costs the user an extra turn. Screenshots are images: you cannot read them, but you may cite their filenames as evidence.
- When an answer rests on a pulled file, say which one (e.g. "from findings/chaos-hunter.actions.json").
- Questions may be follow-ups in an ongoing conversation. Short or vague questions ("why?", "what about C-2?", "tell me more") refer to the conversation so far and/or the artifacts — answer them in that context.
- Be concise. Markdown is fine.`;

/** Appended only for dashboard (serve) chats: lets the model request an inline chart. */
const VISUAL_ADDENDUM = `

You may accompany an answer with ONE fenced \`\`\`visual JSON block, which the UI renders as a chart. Put it at the very end of your reply, only when it genuinely helps:
{"type":"timeline","persona":"<persona name>"}  — that persona's step/finding timeline
{"type":"flow","code":"<finding code>"}          — repro path for a finding (e.g. C-1)
{"type":"severity"}                                — findings grouped by severity
{"type":"cost"}                                    — LLM cost per persona
Valid finding codes are the ones in REPORT.md (C-1, M-2, m-3, G-1, A-1).`;

/**
 * A chat session bound to one run folder. The expensive digestRun() happens
 * once, at construction; each ask() reuses it and appends the conversation
 * history so follow-up questions have context.
 */
export class RunChat {
  private readonly meta: Record<string, unknown>;
  private readonly report: string;
  private readonly personas: unknown[];
  private readonly mergedFindings: unknown[];
  private readonly codeMap: string | null;
  private readonly catalogue: string;
  private turn = 0;
  private readonly allowVisuals: boolean;

  constructor(
    private readonly runDir: string,
    private readonly logger?: RunLogger,
    opts: { allowVisuals?: boolean; codeMap?: string | null } = {}
  ) {
    const digest = digestRun(runDir);
    this.meta = digest.meta;
    this.report = digest.report;
    this.personas = digest.personas;
    this.mergedFindings = digest.mergedFindings;
    this.codeMap = opts.codeMap ?? null;
    this.allowVisuals = opts.allowVisuals ?? false;
    try {
      this.catalogue = artifactCatalogue(runDir);
    } catch {
      this.catalogue = ""; // an unreadable folder shouldn't break chat
    }
  }

  get runName(): string {
    return path.basename(this.runDir);
  }

  get target(): unknown {
    return this.meta["target"];
  }

  /**
   * Inline the artifacts the analyst asked for (or the UI pinned), truncated
   * per-file and in total. Unknown or unreadable ids come back as an explicit
   * "not available" line so the model never silently invents the contents.
   */
  private pullArtifacts(files: string[]): { block: string; pulled: string[] } {
    const pulled: string[] = [];
    const parts: string[] = [];
    let budget = PULL_CHARS_TOTAL;
    for (const raw of files.slice(0, 4)) {
      const file = String(raw).trim();
      if (!file || pulled.includes(file)) continue;
      const art = readArtifact(this.runDir, file, PULL_CHARS_PER_FILE);
      if (!art) {
        parts.push(`--- ${file} ---\n[not available in this run folder]`);
        continue;
      }
      if (art.binary) {
        parts.push(`--- ${file} ---\n[binary file, ${art.bytes.toLocaleString()} bytes — an image you cannot read; cite it by filename]`);
        pulled.push(file);
        continue;
      }
      const body = (art.text ?? "").slice(0, Math.max(0, budget));
      budget -= body.length;
      pulled.push(file);
      parts.push(`--- ${file} (${art.bytes.toLocaleString()} bytes${art.truncated || body.length < (art.text ?? "").length ? ", truncated" : ""}) ---\n${body}`);
      if (budget <= 0) break;
    }
    return { block: parts.join("\n\n"), pulled };
  }

  /** Files the analyst requested via a ```pull block, if the reply is only that. */
  private parsePull(answer: string): string[] | null {
    const m = answer.match(/```pull\s*\n?([\s\S]*?)```/);
    if (!m) return null;
    if (answer.replace(m[0], "").trim().length > 240) return null; // it answered too — don't loop
    try {
      const spec = JSON.parse(m[1]!.trim()) as { artifacts?: unknown };
      const list = Array.isArray(spec.artifacts) ? spec.artifacts.map((x) => String(x)) : [];
      return list.length ? list.slice(0, 3) : null;
    } catch {
      return null;
    }
  }

  async ask(
    question: string,
    history: ChatTurn[],
    context?: string,
    attach?: string[]
  ): Promise<{ answer: string; costUsd: number | null; pulled: string[] }> {
    const recent = history.slice(-HISTORY_TURNS).map((t) => ({
      role: t.role,
      content:
        t.role === "assistant" && t.content.length > HISTORY_ANSWER_CHARS
          ? t.content.slice(0, HISTORY_ANSWER_CHARS) + " …[truncated]"
          : t.content,
    }));
    const sections = [
      `=== RUN METADATA ===\n${JSON.stringify(this.meta, null, 2)}`,
      `=== REPORT.md ===\n${this.report}`,
      `=== MERGED FINDINGS (chair-verified; repro steps, expected vs actual) ===\n${JSON.stringify(this.mergedFindings, null, 2)}`,
      `=== PER-PERSONA STEP LOGS + RAW FINDINGS ===\n${JSON.stringify(this.personas, null, 2)}`,
    ];
    if (this.codeMap) {
      sections.splice(3, 0, `=== CODE MAP (mapd static analysis of the source: files, functions, calls, imports, workflows, test status) ===\n${this.codeMap}`);
    }
    if (recent.length > 0) {
      sections.push(
        `=== CONVERSATION SO FAR ===\n${recent
          .map((t) => `[${t.role}] ${t.content}`)
          .join("\n\n")}`
      );
    }
    if (this.catalogue) {
      sections.push(`=== ARTIFACT CATALOGUE (every file this run wrote — pull any of them by id) ===\n${this.catalogue}`);
    }
    sections.push(`=== QUESTION ===\n${question}`);
    if (context && context.trim()) {
      sections.splice(sections.length - 1, 0, `=== CURRENT DASHBOARD VIEW (what the user is looking at right now) ===\n${context.trim()}`);
    }

    const pulled: string[] = [];
    // The user can pin artifacts from the dashboard; those ride along turn one.
    if (attach && attach.length) {
      const { block, pulled: got } = this.pullArtifacts(attach);
      if (block) {
        pulled.push(...got);
        sections.splice(sections.length - 1, 0, `=== ARTIFACTS THE USER PINNED (verbatim) ===\n${block}`);
      }
    }

    const system = this.allowVisuals ? SYSTEM + VISUAL_ADDENDUM : SYSTEM;
    let cost = 0;
    let answer = "";
    // One extra round-trip per pull: ask → model requests files → re-ask with them.
    for (let round = 0; round <= PULL_MAX_ROUNDS; round++) {
      const resp = await callLLM({ system, user: sections.join("\n\n") });
      cost += resp.costUsd ?? 0;
      answer = resp.text;
      this.turn += 1;
      this.logger?.event("chat", {
        run: this.runName,
        turn: this.turn,
        question: question.slice(0, 200),
        model: resp.model,
        input_tokens: resp.inputTokens,
        output_tokens: resp.outputTokens,
        cost_usd: resp.costUsd,
        pull_round: round,
      });
      const want = round < PULL_MAX_ROUNDS ? this.parsePull(answer) : null;
      if (!want) break;
      const { block, pulled: got } = this.pullArtifacts(want.filter((f) => !pulled.includes(f)));
      if (!block) break;
      pulled.push(...got);
      this.logger?.event("chat_pull", { run: this.runName, turn: this.turn, artifacts: got });
      sections.splice(sections.length - 1, 0, `=== ARTIFACTS YOU PULLED (verbatim) ===\n${block}`);
    }
    return { answer, costUsd: cost || null, pulled };
  }
}
