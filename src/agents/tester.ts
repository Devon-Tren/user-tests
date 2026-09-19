/**
 * tester.ts — the generic persona-driven tester loop.
 *
 * Persona behavior lives ENTIRELY in the persona .md file (plus harshness and
 * optional repo context injected here). This loop never changes per persona:
 *
 *   observe → think (LLM returns JSON) → act (closed action set) → log → repeat
 *
 * Guard rails per the spec:
 *  - invalid JSON from the LLM → re-ask once → if still invalid, log as an
 *    observation and keep going
 *  - a failed action is fed back as the next observation, so agents experience
 *    dead buttons exactly like users do
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { callLLM, BudgetExceededError } from "../llm.js";
import { Runner, type ActionName, type ActionParams } from "../runner.js";
import type { Severity } from "../config.js";
import type { RunLogger } from "../logger.js";

export type FindingCategory = "confusion" | "goal-gap" | "bug" | "a11y" | "polish";

export interface Finding {
  title: string;
  severity: Severity;
  category: FindingCategory;
  steps: string[];
  expected: string;
  actual: string;
  screenshot?: string;
  /** Step number in this persona's action log where the finding manifested — used by chair replay. */
  atStep: number;
}

export interface StepRecord {
  step: number;
  action: ActionName | "done" | "invalid";
  params?: ActionParams;
  reasoning?: string;
  observation?: string;
  ok?: boolean;
  error?: string;
  finding?: Finding;
}

export interface TesterResult {
  persona: string;
  steps: StepRecord[];
  findings: Finding[];
  /** Set when the loop ended early for a safety rail (findings so far are kept). */
  stoppedReason?: "budget" | "deadline";
}

const ACTIONS: ActionName[] = [
  "goto",
  "click",
  "type",
  "pressKey",
  "scroll",
  "hover",
  "goBack",
  "screenshot",
];
const SEVERITIES: Severity[] = ["critical", "major", "minor"];
const CATEGORIES: FindingCategory[] = ["confusion", "goal-gap", "bug", "a11y", "polish"];

const FINDING_SCHEMA_REMINDER = `
When you observe something worth reporting, include a "finding" object in your JSON reply with EXACTLY this shape:
{
  "title": "one-line summary",
  "severity": "critical" | "major" | "minor",
  "category": "confusion" | "goal-gap" | "bug" | "a11y" | "polish",
  "steps": ["1. …", "2. …"],
  "expected": "what should happen",
  "actual": "what actually happens"
}
CRITICAL: describing an issue in "reasoning" does NOT file it — only the finding object does. If your reasoning states a gap, bug, or confusion, the SAME reply must carry the finding object.
Severity guide: critical = data loss / crash / completely blocked task; major = feature broken or seriously misleading; minor = polish, papercut, small confusion.`;

interface LLMDecision {
  action: ActionName | "done";
  params?: ActionParams;
  reasoning?: string;
  finding?: Omit<Finding, "atStep">;
}

function buildSystemPrompt(
  personaMd: string,
  harshness: number,
  repoContext: string | null,
  coverageBriefing: string | null
): string {
  const contextBlock =
    repoContext === null
      ? "You receive NO documentation about this app. Judge it purely by what the UI shows you."
      : `Here is the app's documented intent (from its repository):\n\n${repoContext}`;
  const coverageBlock =
    coverageBriefing === null
      ? ""
      : `\n\n---\n\nCOVERAGE MAP (from mapd, static analysis of the app's source):\n\n${coverageBriefing}\n\nUse it to aim your exploration: flows that pass through untested code are the highest-value targets — exercise them first. If you break an untested flow, file a finding. Do NOT file findings about missing unit tests or low test coverage itself — judge only the running app's user-visible behavior.`;
  return `${personaMd}

---

HARSHNESS: ${harshness}/10 (3–4 = report what a reasonable user would notice; 7–8 = actively try to break it).

${contextBlock}${coverageBlock}

${FINDING_SCHEMA_REMINDER}

Reply with ONE JSON object only, no prose around it:
{ "action": "goto|click|type|pressKey|scroll|hover|goBack|screenshot|done",
  "params": { "url"?, "selector"?, "text"?, "key"?, "direction"? },
  "reasoning": "what you intend and why (narrate like a user thinking out loud)",
  "finding"?: { …schema above… } }
Pick selectors ONLY from the ELEMENTS list you are shown. Return {"action":"done"} only when your persona's instructions say your checklist is complete — ending early wastes the run.`;
}

/** Extract the first JSON object from an LLM reply that may contain markdown fences or chatter. */
function extractJson(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateDecision(value: unknown): LLMDecision | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  if (d["action"] === "done") return { action: "done", reasoning: str(d["reasoning"]) };
  if (!ACTIONS.includes(d["action"] as ActionName)) return null;

  const decision: LLMDecision = {
    action: d["action"] as ActionName,
    reasoning: str(d["reasoning"]),
    params: typeof d["params"] === "object" && d["params"] !== null
      ? (d["params"] as ActionParams)
      : {},
  };

  if (d["finding"] !== undefined) {
    const finding = validateFinding(d["finding"]);
    if (finding) decision.finding = finding;
  }
  return decision;
}

function validateFinding(value: unknown): Omit<Finding, "atStep"> | null {
  if (typeof value !== "object" || value === null) return null;
  const f = value as Record<string, unknown>;
  const title = str(f["title"]);
  const expected = str(f["expected"]);
  const actual = str(f["actual"]);
  if (!title || !expected || !actual) return null;
  if (!SEVERITIES.includes(f["severity"] as Severity)) return null;
  if (!CATEGORIES.includes(f["category"] as FindingCategory)) return null;
  const steps = Array.isArray(f["steps"]) ? f["steps"].map((s) => String(s)) : [];
  if (steps.length === 0) return null;
  return {
    title,
    severity: f["severity"] as Severity,
    category: f["category"] as FindingCategory,
    steps,
    expected,
    actual,
    screenshot: str(f["screenshot"]),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export interface TesterOptions {
  personaName: string;
  personaFile: string;
  harshness: number;
  /** null ⇒ persona receives no repo context (everyone except goal-gap-auditor). */
  repoContext: string | null;
  /** null ⇒ no mapd coverage briefing (mapd disabled/unavailable). Optional accelerator. */
  coverageBriefing?: string | null;
  target: string;
  maxSteps: number;
  runDir: string;
  runner: Runner;
  logger?: RunLogger;
  /** Epoch ms after which the loop stops cleanly (wall-clock limit). */
  deadlineAt?: number;
  onProgress?: (msg: string) => void;
}

export async function runTester(opts: TesterOptions): Promise<TesterResult> {
  const { runner } = opts;
  const personaMd = readFileSync(opts.personaFile, "utf8");
  const system = buildSystemPrompt(personaMd, opts.harshness, opts.repoContext, opts.coverageBriefing ?? null);

  const steps: StepRecord[] = [];
  const findings: Finding[] = [];
  const history: string[] = [];
  let stoppedReason: TesterResult["stoppedReason"];

  // --- Duplicate-finding guard (code-level; LLMs re-report the same issue
  // with slightly different wording every step otherwise) ---
  const normTokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const filedTokenSets: Set<string>[] = [];

  /** File a finding: dedupe vs this persona's already-filed titles, attach evidence, log. Returns null if dropped as duplicate. */
  const recordFinding = async (step: number, data: Omit<Finding, "atStep">): Promise<Finding | null> => {
    const tokens = normTokens(data.title);
    if (filedTokenSets.some((fs) => jaccard(fs, tokens) > 0.6)) {
      opts.onProgress?.(`duplicate finding skipped: ${data.title}`);
      return null;
    }
    filedTokenSets.push(tokens);
    let shot = data.screenshot;
    if (!shot) {
      try {
        shot = await runner.saveFindingScreenshot(`${opts.personaName}-s${step}-${data.title}`);
      } catch {
        shot = undefined; // evidence is nice-to-have; the finding stands on its steps
      }
    }
    const finding: Finding = { ...data, screenshot: shot, atStep: step };
    findings.push(finding);
    opts.logger?.event("finding", {
      persona: opts.personaName,
      step,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
    });
    opts.onProgress?.(`finding [${finding.severity}/${finding.category}] ${finding.title}`);
    return finding;
  };

  /** One LLM round-trip + structured usage logging. BudgetExceededError propagates. */
  const ask = async (step: number, userPrompt: string, screenshot: Buffer): Promise<string> => {
    const resp = await callLLM({ system, user: userPrompt, images: [screenshot] });
    opts.logger?.event("llm_call", {
      persona: opts.personaName,
      step,
      model: resp.model,
      provider: resp.provider,
      duration_ms: resp.durationMs,
      input_tokens: resp.inputTokens,
      output_tokens: resp.outputTokens,
      cost_usd: resp.costUsd,
    });
    return resp.text;
  };

  // Step 0: land on the target.
  const first = await runner.act(0, "goto", { url: opts.target });
  history.push(`Step 0: goto ${opts.target} → ${first.ok ? "ok" : `FAILED: ${first.error}`}`);

  /** Persist whatever this persona has gathered — called on success AND on crash. */
  const persist = () => {
    const findingsDir = path.join(opts.runDir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      path.join(findingsDir, `${opts.personaName}.json`),
      JSON.stringify({ persona: opts.personaName, steps, findings, stoppedReason: stoppedReason ?? null }, null, 2)
    );
    runner.saveLog(path.join(findingsDir, `${opts.personaName}.actions.json`));
  };

  try {
  for (let step = 1; step <= opts.maxSteps; step++) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
      stoppedReason = "deadline";
      opts.onProgress?.("stopped: wall-clock deadline reached");
      break;
    }
    const screenshot = await runner.screenshotBuffer();
    const observation = await runner.snapshot();

    const userPrompt = [
      `STEP ${step}/${opts.maxSteps}. This is what you currently see.`,
      "",
      "--- HISTORY (your actions and their outcomes so far) ---",
      history.slice(-12).join("\n") || "(none yet)",
      "",
      "--- CURRENT PAGE (accessibility snapshot) ---",
      observation,
      "",
      "The attached screenshot is your visual view of the same page. What do you do next? JSON only.",
    ].join("\n");

    let raw = await ask(step, userPrompt, screenshot);
    let decision = validateDecision(extractJson(raw));

    if (!decision) {
      // Guard rail: re-ask exactly once with a corrective nudge.
      raw = await ask(
        step,
        `${userPrompt}\n\nYour previous reply was not valid JSON matching the required shape. Reply with ONE valid JSON object only.`,
        screenshot
      );
      decision = validateDecision(extractJson(raw));
    }

    if (!decision) {
      // Still invalid: log as observation, keep the loop alive.
      steps.push({ step, action: "invalid", observation: raw.slice(0, 300) });
      history.push(`Step ${step}: (your last reply was unparseable; continuing)`);
      continue;
    }

    if (decision.action === "done") {
      // CLOSING SWEEP: models routinely analyze a gap in "reasoning" but forget
      // to attach the finding object. Ask for any confirmed-but-unfiled issues
      // (max 2 rounds; the filed list is shown so nothing is double-counted).
      for (let round = 0; round < 2; round++) {
        const filedList = findings.map((f) => f.title).join("; ") || "(none yet)";
        const roleCheck = opts.personaName === "goal-gap-auditor"
          ? "\nRe-read every documented promise in your system context. If the history does not explicitly prove a promised feature worked, treat an absent or unreachable feature as a goal gap and file it now."
          : opts.personaName === "a11y-polish"
            ? "\nReview the focused-element markers from your keyboard pass. If focus repeated or could not leave a component, file the demonstrated keyboard/focus trap now."
            : opts.personaName === "chaos-hunter"
              ? "\nReview what appeared immediately after each empty form submission. If the page became blank, empty, or lost its UI, describe that visible crash explicitly and file it now."
              : "";
        const sweepPrompt =
          `${userPrompt}\n\nCLOSING SWEEP: you are about to finish. Issues you have ALREADY FILED: ${filedList}.` +
          `\nIf you OBSERVED any other issue that you did NOT file yet (a gap you confirmed, a button that did nothing, a crash, a barrier), reply with ONE JSON object: {"action":"done","finding":{...the finding schema...}}.` +
          roleCheck +
          `\nIf everything observed is already filed, reply with {"action":"done"}.`;
        const sweepRaw = await ask(step, sweepPrompt, screenshot);
        const sweepDecision = validateDecision(extractJson(sweepRaw));
        if (!sweepDecision || sweepDecision.action !== "done" || !sweepDecision.finding) break;
        const finding = await recordFinding(step, sweepDecision.finding);
        if (finding) history.push(`Step ${step}: filed closing-sweep finding "${finding.title}"`);
      }
      steps.push({ step, action: "done", reasoning: decision.reasoning });
      opts.onProgress?.(`done at step ${step}`);
      break;
    }

    const result = await runner.act(step, decision.action, decision.params ?? {});

    const record: StepRecord = {
      step,
      action: decision.action,
      params: decision.params,
      reasoning: decision.reasoning,
      ok: result.ok,
      error: result.error,
    };

    if (decision.finding) {
      const finding = await recordFinding(step, decision.finding);
      if (finding) record.finding = finding;
    }

    steps.push(record);
    const focused = result.snapshot.match(/^-.+\[focused\].*$/m)?.[0];
    const pageState = /ELEMENTS \(0\):\s*\n\(none\)/.test(result.snapshot)
      ? " [page now has zero visible interactive elements]"
      : focused
        ? ` [focus now: ${focused.slice(2, 180)}]`
        : "";
    history.push(
      `Step ${step}: ${decision.action} ${JSON.stringify(decision.params ?? {})} → ` +
        (result.ok ? "ok" : `FAILED: ${result.error}`) +
        pageState +
        (decision.reasoning ? ` ("${decision.reasoning.slice(0, 120)}")` : "")
    );
    opts.onProgress?.(`step ${step}/${opts.maxSteps}`);
  }
  } catch (e) {
    // Budget caps end this persona cleanly — findings gathered so far are kept,
    // and the CLI skips the remaining personas.
    if (e instanceof BudgetExceededError) {
      stoppedReason = "budget";
      opts.logger?.event("budget", { persona: opts.personaName, reason: e.message });
      opts.onProgress?.(`stopped: ${e.message}`);
    } else {
      // Unexpected crash (network, rate limit, provider outage): keep whatever
      // this persona had already gathered — never silently lose tester work.
      persist();
      throw e;
    }
  }

  persist();

  return { persona: opts.personaName, steps, findings, stoppedReason };
}
