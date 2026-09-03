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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 4173;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;
const MIN_FOUND = 4;

/** One detector per planted issue in tests/fixture-app/index.html. Tolerant
 *  regexes on the whole REPORT.md (main sections + appendix both count as
 *  "surfaced"). Tune here if the council's phrasing drifts. */
const PLANTED_ISSUES: { name: string; detector: RegExp }[] = [
  { name: 'Dead "Save Draft" button', detector: /save.?draft/i },
  { name: "Empty-submit white screen", detector: /white.?screen|blank page|crash/i },
  { name: "Unlabeled email input", detector: /unlabel|no label|missing label|aria-label|placeholder/i },
  { name: "Missing Export feature (goal gap)", detector: /export/i },
  { name: "Keyboard focus trap", detector: /focus trap|keyboard trap|tab/i },
];

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
  const report = readFileSync(reportPath, "utf8");

  // 4. Verdict.
  console.log(`\n[acceptance] report: ${path.relative(PROJECT_ROOT, reportPath)}\n`);
  let found = 0;
  for (const issue of PLANTED_ISSUES) {
    const hit = issue.detector.test(report);
    if (hit) found += 1;
    console.log(`  ${hit ? "FOUND  " : "MISSED "} ${issue.name}`);
  }
  console.log(`\n[acceptance] ${found}/${PLANTED_ISSUES.length} planted issues surfaced (need ≥${MIN_FOUND})`);
  if (found < MIN_FOUND) fail("below acceptance threshold");
  console.log("[acceptance] PASS");
} finally {
  fixtureServer?.kill();
}
