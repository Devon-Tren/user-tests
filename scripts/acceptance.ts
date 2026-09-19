/**
 * acceptance.ts — proves the council surfaces ≥4 of the 5 planted fixture
 * issues. This is the MVP acceptance gate and the seed of the regression
 * harness: run it after any change to src/ or personas/.
 *
 *   npm run acceptance
 *
 * Requires USERTESTS_API_KEY (real council run — this spends tokens).
 * Exits 0 on ≥4/5 found, 1 otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateFixtureAcceptance,
  FIXTURE_ACCEPTANCE_MINIMUM,
  type AcceptanceFinding,
} from "../src/acceptance.js";

loadEnv(); // .env is optional; real env vars always win

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 4173;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;

function fail(msg: string): never {
  console.error(`\n[acceptance] FAIL: ${msg}`);
  process.exit(1);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(url, { signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`fixture app did not come up at ${url} within ${timeoutMs / 1000}s`);
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_ROOT, stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function listRunDirs(): string[] {
  const runsDir = path.join(PROJECT_ROOT, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// 1. Pre-flight — no tokens spent if the setup is broken.
if (!process.env.USERTESTS_API_KEY) {
  fail("USERTESTS_API_KEY is not set. Export it (or add it to .env) first.");
}
if (!existsSync(path.join(PROJECT_ROOT, "dist", "cli.js"))) {
  fail('dist/cli.js not found. Run "npm run build" first (npm run acceptance does this for you).');
}

// 2. Fixture server — reuse one that's already running, else spawn our own.
let fixtureServer: ChildProcess | null = null;
if (await reachable(FIXTURE_URL)) {
  console.log(`[acceptance] fixture app already running at ${FIXTURE_URL}`);
} else {
  console.log(`[acceptance] starting fixture app at ${FIXTURE_URL}…`);
  fixtureServer = spawn("node", [path.join(PROJECT_ROOT, "scripts", "serve-fixture.js"), String(FIXTURE_PORT)], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });
  await waitFor(FIXTURE_URL, 10_000);
}

try {
  // 3. Full council run against the fixture.
  const before = new Set(listRunDirs());
  console.log("[acceptance] running the council (this spends real tokens, ~minutes)…");
  const code = await run("node", [
    path.join(PROJECT_ROOT, "dist", "cli.js"),
    "run",
    "--target",
    FIXTURE_URL,
    "--repo",
    path.join(PROJECT_ROOT, "tests", "fixture-app"),
  ]);
  if (code !== 0) fail(`council run exited with code ${code}`);

  const newDirs = listRunDirs().filter((d) => !before.has(d));
  if (newDirs.length !== 1) fail(`expected exactly 1 new run folder, found ${newDirs.length}`);
  const runDir = path.join(PROJECT_ROOT, "runs", newDirs[0]!);
  const reportPath = path.join(runDir, "REPORT.md");
  if (!existsSync(reportPath)) fail(`REPORT.md missing in ${runDir}`);
  const mergedPath = path.join(runDir, "findings-merged.json");
  if (!existsSync(mergedPath)) fail(`findings-merged.json missing in ${runDir}`);
  let findings: AcceptanceFinding[];
  try {
    const merged = JSON.parse(readFileSync(mergedPath, "utf8")) as { findings?: AcceptanceFinding[] };
    if (!Array.isArray(merged.findings)) fail(`findings array missing in ${mergedPath}`);
    findings = merged.findings;
  } catch (e) {
    fail(`could not parse ${mergedPath}: ${e instanceof Error ? e.message : e}`);
  }

  // 4. Verdict.
  console.log(`\n[acceptance] report: ${path.relative(PROJECT_ROOT, reportPath)}\n`);
  const results = evaluateFixtureAcceptance(findings);
  const found = results.filter((result) => result.found).length;
  for (const result of results) {
    console.log(`  ${result.found ? "FOUND  " : "MISSED "} ${result.name}${result.code ? ` (${result.code})` : ""}`);
  }
  console.log(`\n[acceptance] ${found}/${results.length} planted issues surfaced as real findings (need ≥${FIXTURE_ACCEPTANCE_MINIMUM})`);
  if (found < FIXTURE_ACCEPTANCE_MINIMUM) fail("below acceptance threshold");
  console.log("[acceptance] PASS");
} finally {
  fixtureServer?.kill();
}
