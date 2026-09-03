#!/usr/bin/env node
/**
 * cli.ts — Commander-based entry point.
 *
 *   usertests run --target <url> [--repo <path>] [--config <path>] [--steps <n>]
 *
 * Validates the target is reachable BEFORE spending a single LLM token.
 * A persona crash, budget cap, or wall-clock deadline never loses the run:
 * the chair still runs on partial results and the report is marked PARTIAL.
 */
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, readdirSync, rmSync, watch, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, personaPath, type CouncilConfig } from "./config.js";
import { buildRepoContext } from "./context.js";
import { Runner } from "./runner.js";
import { runTester } from "./agents/tester.js";
import { runChair } from "./agents/chair.js";
import { writeReport } from "./report.js";
import { RunLogger } from "./logger.js";
import { notifyDone } from "./notify.js";
import { diffSinceLastRun, hashFinding, saveHashes } from "./diff.js";
import { estimateRunSeconds, formatEta } from "./eta.js";
import {
  budgetStatus,
  configureLLM,
  currentModel,
  estimateCostUsd,
} from "./llm.js";

loadEnv(); // .env in YOUR project dir, if present, always wins

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(PROJECT_ROOT, ".env") }); // the tool's own .env is the fallback (dotenv never overrides)
const CWD = process.cwd();

/** Project-local config wins over the package default — run from YOUR repo. */
const DEFAULT_CONFIG = existsSync(path.join(CWD, "council.config.yaml"))
  ? path.join(CWD, "council.config.yaml")
  : path.join(PROJECT_ROOT, "council.config.yaml");

/** Dev servers cluster on these ports; probe them when --target is omitted. */
const COMMON_PORTS = [3000, 3001, 5173, 4173, 4200, 5000, 5001, 5191, 7000, 7001, 7136, 8000, 8080, 4321, 8787, 9000];

/** Probe common local dev-server ports in parallel. Returns the alive ones.
 *  macOS's AirPlay receiver answers 403 on 5000/7000 — treat non-2xx/3xx
 *  (and anything speaking AirTunes) as "not a dev server". */
async function probeLocalServers(): Promise<string[]> {
  const results = await Promise.all(
    COMMON_PORTS.map(async (p) => {
      try {
        const res = await fetch(`http://localhost:${p}`, {
          signal: AbortSignal.timeout(600),
        });
        if (res.status >= 400) return null;
        if (/airtunes/i.test(res.headers.get("server") ?? "")) return null;
        return `http://localhost:${p}`;
      } catch {
        return null;
      }
    })
  );
  return results.filter((u): u is string => u !== null);
}

/** Rough per-call token assumptions for the pre-run estimate (screenshot included). */
const EST_STEP_TOKENS = { input: 5_000, output: 300 };
const EST_CHAIR_TOKENS = { input: 20_000, output: 4_000 };

async function assertReachable(target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(target, { method: "GET", signal: controller.signal });
    if (res.status >= 500) {
      throw new Error(`target responded with HTTP ${res.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Target ${target} is not reachable (${msg}). Start your app first — no LLM tokens were spent.`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Pre-run token/cost estimate — printed before any LLM call happens. */
function printEstimate(config: CouncilConfig, testerCount: number, log: (msg: string) => void): void {
  const { model } = currentModel();
  const testerCalls = testerCount * config.max_steps_per_agent;
  const estCalls = testerCalls + 1; // + chair
  const stepCost = estimateCostUsd(model, EST_STEP_TOKENS.input, EST_STEP_TOKENS.output) ?? 0;
  const chairCost = estimateCostUsd(model, EST_CHAIR_TOKENS.input, EST_CHAIR_TOKENS.output) ?? 0;
  const estCost = testerCalls * stepCost + chairCost;
  log(
    `estimate: ~${estCalls} LLM calls, ~$${estCost.toFixed(2)} on ${model} ` +
      `(caps: ${config.limits.max_llm_calls} calls` +
      (config.limits.max_cost_usd !== null ? `, $${config.limits.max_cost_usd.toFixed(2)}` : ", no cost cap") +
      `, ${config.limits.max_run_minutes}min wall-clock)`
  );
  if (config.limits.max_cost_usd !== null && estCost > config.limits.max_cost_usd) {
    log(
      `WARNING: estimate (~$${estCost.toFixed(2)}) exceeds limits.max_cost_usd ` +
        `($${config.limits.max_cost_usd.toFixed(2)}) — the run will stop early when the cap is hit.`
    );
  }
}

/** Short hash of a persona file — results stay attributable to prompt versions. */
function fileHash(file: string): string {
  return createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 10);
}

/** Keep the newest `keep` run folders; prune older ones (screenshots eat disk). */
function pruneRuns(runsDir: string, currentRunDir: string, keep: number, log: (m: string) => void): void {
  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse(); // ISO timestamps sort chronologically — newest first
  const toDelete = dirs.slice(keep).filter((name) => path.join(runsDir, name) !== currentRunDir);
  for (const name of toDelete) {
    try {
      rmSync(path.join(runsDir, name), { recursive: true, force: true });
    } catch {
      // pruning is housekeeping — never fail a completed run over it
    }
  }
  if (toDelete.length > 0) log(`pruned ${toDelete.length} old run folder(s) (keeping last ${keep}).`);
}

const program = new Command();
program
  .name("usertests")
  .description("Spin up a council of LLM agent personas to user-test a locally running web app.")
  .version("0.1.0");

program
  .command("run")
  .option("--target <url>", "URL of the running app to test (default: auto-detect, then config)")
  .option("--repo <path>", "path to the app's repo — default: current directory")
  .option("--config <path>", "path to council.config.yaml (default: ./council.config.yaml if present)", DEFAULT_CONFIG)
  .option("--steps <n>", "max steps per agent (overrides config)", (v) => Number(v))
  .option("--persona <name>", "run a single persona (for iterating on prompts)")
  .option("--watch", "re-run the council whenever a file in repo_path changes")
  .action(async (opts: { target?: string; repo?: string; config: string; steps?: number; persona?: string; watch?: boolean }) => {
    const log = (msg: string) => console.log(`[usertests] ${msg}`);

    /** One full council run. Called once normally, repeatedly in --watch mode. */
    const executeRun = async () => {

    // 1. Config + target validation before anything expensive happens.
    //    With no --target and no project-local config, auto-detect the dev server.
    let target = opts.target;
    if (!target && !existsSync(path.join(CWD, "council.config.yaml"))) {
      const alive = await probeLocalServers();
      if (alive.length === 1) {
        target = alive[0]!;
        log(`no --target given — auto-detected your app at ${target}`);
      } else if (alive.length > 1) {
        throw new Error(
          `Multiple local servers are running (${alive.join(", ")}). ` +
            `Pass --target http://localhost:<port> so I test the right one.`
        );
      }
    }
    const config = loadConfig(opts.config, {
      target,
      repo: opts.repo, // undefined → config's repo_path ("." resolves to YOUR cwd)
      steps: opts.steps,
    });
    await assertReachable(config.target);

    // 2. Persona files must exist before we burn tokens on the first agent.
    for (const t of config.council.testers) {
      personaPath(PROJECT_ROOT, t.persona);
    }
    const chairFile = personaPath(PROJECT_ROOT, "chair");

    // 2b. --persona narrows the council to one tester (prompt iteration).
    let activeTesters = config.council.testers;
    if (opts.persona) {
      if (!activeTesters.some((t) => t.persona === opts.persona)) {
        throw new Error(
          `--persona "${opts.persona}" is not in council.testers ` +
            `(${activeTesters.map((t) => t.persona).join(", ")}).`
        );
      }
      activeTesters = activeTesters.filter((t) => t.persona === opts.persona);
      log(`single-persona mode: ${opts.persona}`);
    }

    // 3. Safety rails + pre-run estimate.
    configureLLM({
      maxCalls: config.limits.max_llm_calls,
      maxCostUsd: config.limits.max_cost_usd,
      timeoutSeconds: config.limits.llm_timeout_seconds,
    });
    printEstimate(config, activeTesters.length, log);
    const runsDir = path.join(PROJECT_ROOT, "runs");
    const etaSeconds = estimateRunSeconds(runsDir, activeTesters.length, config.max_steps_per_agent);
    const runStart = Date.now();
    log(etaSeconds !== null ? `ETA: ${formatEta(etaSeconds)} (from prior runs)` : "ETA: no history yet — this run will teach it");
    const deadlineAt = Date.now() + config.limits.max_run_minutes * 60_000;

    // 4. Run folder: runs/<ISO-timestamp>/ + structured log.
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const runDir = path.join(PROJECT_ROOT, "runs", timestamp);
    mkdirSync(path.join(runDir, "findings"), { recursive: true });
    mkdirSync(path.join(runDir, "shots"), { recursive: true });
    const logger = new RunLogger(runDir);
    const personaHashes = Object.fromEntries(
      [...activeTesters.map((t) => t.persona), "chair"].map((p) => [
        p,
        fileHash(personaPath(PROJECT_ROOT, p)),
      ])
    );
    logger.event("phase", {
      phase: "start",
      target: config.target,
      testers: activeTesters.length,
      persona_hashes: personaHashes,
    });
    logger.event("eta", { estimate_seconds: etaSeconds });
    log(`run folder: ${path.relative(PROJECT_ROOT, runDir)}`);

    // 5. Repo context — goal-gap-auditor gets it; everyone else judges the UI alone.
    const repoContext = buildRepoContext(config.repo_path);

    // 6. Testers run sequentially (MVP constraint). Each gets a fresh browser.
    //    A crash/budget/deadline never sinks the run — failures are recorded,
    //    remaining personas continue, and the chair runs on partial results.
    const failed: { persona: string; reason: string }[] = [];
    let budgetExhausted = false;
    for (const tester of activeTesters) {
      if (budgetExhausted) {
        failed.push({ persona: tester.persona, reason: "skipped: LLM budget exhausted" });
        continue;
      }
      if (Date.now() > deadlineAt) {
        failed.push({ persona: tester.persona, reason: "skipped: wall-clock deadline reached" });
        continue;
      }
      const elapsed = Math.round((Date.now() - runStart) / 1000);
      log(
        `tester "${tester.persona}" starting (harshness ${tester.harshness})… ` +
          `[elapsed ${formatEta(elapsed).replace("~", "")}${etaSeconds !== null ? ` / ETA ${formatEta(etaSeconds)}` : ""}]`
      );
      logger.event("persona_start", { persona: tester.persona, harshness: tester.harshness });
      const runner = new Runner(runDir, config.viewport);
      try {
        await runner.launch();
        const withContext = tester.persona === "goal-gap-auditor";
        const result = await runTester({
          personaName: tester.persona,
          personaFile: personaPath(PROJECT_ROOT, tester.persona),
          harshness: tester.harshness,
          repoContext: withContext ? repoContext : null,
          target: config.target,
          maxSteps: config.max_steps_per_agent,
          runDir,
          runner,
          logger,
          deadlineAt,
          onProgress: (m) => log(`  [${tester.persona}] ${m}`),
        });
        if (result.stoppedReason === "budget") {
          budgetExhausted = true;
          failed.push({ persona: tester.persona, reason: "stopped early: LLM budget cap reached" });
        } else if (result.stoppedReason === "deadline") {
          failed.push({ persona: tester.persona, reason: "stopped early: wall-clock deadline reached" });
        }
        logger.event("persona_end", {
          persona: tester.persona,
          steps: result.steps.length,
          findings: result.findings.length,
          stoppedReason: result.stoppedReason ?? null,
        });
      } catch (e) {
        let reason = e instanceof Error ? e.message.split("\n")[0] ?? String(e) : String(e);
        if (/Executable doesn't exist|browserType\.launch/i.test(reason)) {
          reason += " (browser error — run: npx playwright install chromium)";
        }
        failed.push({ persona: tester.persona, reason });
        logger.event("error", { persona: tester.persona, error: reason });
        log(`tester "${tester.persona}" FAILED: ${reason} — continuing with remaining personas`);
      } finally {
        await runner.close();
      }
      log(`tester "${tester.persona}" finished.`);
    }

    // 7. Chair: dedupe → rank → mechanical repro verification (works on partial input).
    log("chair is deduping, ranking, and verifying reproductions…");
    logger.event("phase", { phase: "chair", failed_personas: failed.length });
    const chair = await runChair({
      runDir,
      personas: activeTesters.map((t) => t.persona),
      chairPersonaFile: chairFile,
      chairConfig: config.council.chair,
      target: config.target,
      viewport: config.viewport,
      logger,
      onProgress: (m) => log(`  [chair] ${m}`),
    });

    // 8. The deliverable.
    const reportPath = writeReport(
      runDir,
      {
        timestamp,
        target: config.target,
        testerCount: activeTesters.length,
        stepsPerAgent: config.max_steps_per_agent,
        partial: failed.length > 0 ? failed : undefined,
      },
      chair.main,
      chair.appendix,
      chair.goalGaps
    );

    const budget = budgetStatus();
    logger.event("phase", {
      phase: "done",
      llm_calls: budget.callsMade,
      cost_usd: budget.costUsd,
      findings: chair.main.length,
      unverified: chair.appendix.length,
      partial: failed.length > 0,
    });
    log(`done. ${chair.main.length} findings confirmed/reported, ${chair.appendix.length} unverified.`);

    // 9. Run comparison lite: NEW-since-last-run banner (simple hash-diff).
    const mainHashes = chair.main.map(hashFinding);
    const diff = diffSinceLastRun(path.join(PROJECT_ROOT, "runs"), runDir, mainHashes);
    saveHashes(runDir, chair.main);
    if (diff) {
      log(`${diff.newCount} of ${diff.total} findings are NEW since last run (${diff.previousRun}).`);
      logger.event("diff", { new_findings: diff.newCount, total: diff.total, previous_run: diff.previousRun });
    }

    notifyDone(
      "User-Tests",
      `${chair.main.length} findings${failed.length > 0 ? " (partial run)" : ""} — report ready`
    );
    log(
      `LLM usage: ${budget.callsMade}/${budget.maxCalls} calls, ` +
        `$${budget.costUsd.toFixed(4)} spent${budget.maxCostUsd !== null ? ` of $${budget.maxCostUsd.toFixed(2)} cap` : ""}.`
    );
    if (failed.length > 0) {
      log(`PARTIAL run — ${failed.map((f) => f.persona).join(", ")} did not complete (see REPORT.md).`);
    }
    log(`report → ${path.relative(PROJECT_ROOT, reportPath)}`);
    pruneRuns(runsDir, runDir, config.limits.keep_runs, log);
    }; // end executeRun

    await executeRun();

    if (opts.watch) {
      const watchRoot = loadConfig(opts.config, { repo: opts.repo }).repo_path;
      log(`watching ${watchRoot} for changes — Ctrl+C to stop.`);
      const IGNORE = /(^|[/\\])(node_modules|\.git|dist|runs)([/\\]|$)/;
      let running = false;
      let pending = false;
      let timer: NodeJS.Timeout | null = null;
      watch(watchRoot, { recursive: true }, (_event, filename) => {
        if (!filename || IGNORE.test(filename)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void (async () => {
            if (running) {
              pending = true; // coalesce to exactly one follow-up run
              return;
            }
            do {
              pending = false;
              running = true;
              log("change detected — re-running the council…");
              try {
                await executeRun();
              } catch (e) {
                console.error(`\nError: ${e instanceof Error ? e.message : e}`);
              }
              running = false;
            } while (pending);
          })();
        }, 3_000); // debounce: editors save in bursts
      });
      // The FSWatcher keeps the event loop (and this process) alive.
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`\nError: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
