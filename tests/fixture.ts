import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_RUN = "2026-09-15T12-00-00.000Z";

export function makeDashboardProject(): { root: string; outside: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(here, "..");
  const root = mkdtempSync(path.join(tmpdir(), "usertests-dashboard-"));
  const outside = mkdtempSync(path.join(tmpdir(), "usertests-outside-"));
  mkdirSync(path.join(root, "dashboard"), { recursive: true });
  mkdirSync(path.join(root, "runs", TEST_RUN, "findings"), { recursive: true });
  copyFileSync(path.join(sourceRoot, "dashboard", "index.html"), path.join(root, "dashboard", "index.html"));

  const runDir = path.join(root, "runs", TEST_RUN);
  writeFileSync(path.join(runDir, "REPORT.md"), "# Test report\n\nOne confirmed issue and one goal gap.\n");
  writeFileSync(path.join(runDir, "findings-merged.json"), JSON.stringify({
    timestamp: TEST_RUN,
    target: "http://localhost:4173",
    partial: [],
    findings: [
      {
        code: "C-1",
        section: "main",
        title: "Save action crashes",
        severity: "critical",
        category: "bug",
        found_by: ["chaos-hunter"],
        steps: ["Click Save"],
        expected: "The item is saved.",
        actual: "The page crashes.",
        repro: "confirmed",
      },
      {
        code: "G-1",
        section: "goal-gap",
        title: "Export is missing",
        severity: "major",
        category: "goal-gap",
        found_by: ["goal-gap-auditor"],
        steps: ["Look for Export"],
        expected: "Export is available.",
        actual: "No Export control exists.",
        repro: "not-checked",
      },
    ],
  }));
  writeFileSync(path.join(runDir, "run.log"), [
    { ts: "2026-09-15T12:00:00.000Z", type: "phase", phase: "start", target: "http://localhost:4173", repo_path: root, testers: 2 },
    { ts: "2026-09-15T12:00:01.000Z", type: "persona_start", persona: "chaos-hunter" },
    { ts: "2026-09-15T12:00:02.000Z", type: "llm_call", persona: "chaos-hunter", cost_usd: 0.01, input_tokens: 100, output_tokens: 20, duration_ms: 500 },
    { ts: "2026-09-15T12:00:03.000Z", type: "persona_end", persona: "chaos-hunter", stoppedReason: null },
    { ts: "2026-09-15T12:00:04.000Z", type: "persona_start", persona: "goal-gap-auditor" },
    { ts: "2026-09-15T12:00:05.000Z", type: "llm_call", persona: "goal-gap-auditor", cost_usd: 0.02, input_tokens: 150, output_tokens: 25, duration_ms: 700 },
    { ts: "2026-09-15T12:00:06.000Z", type: "persona_end", persona: "goal-gap-auditor", stoppedReason: null },
    { ts: "2026-09-15T12:00:10.000Z", type: "phase", phase: "done", llm_calls: 5, cost_usd: 0.03, partial: false },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(path.join(runDir, "findings", "chaos-hunter.json"), "{broken json");
  writeFileSync(path.join(runDir, "findings", "chaos-hunter.actions.json"), "[]");
  writeFileSync(path.join(runDir, "findings", "goal-gap-auditor.json"), JSON.stringify({ steps: [] }));
  writeFileSync(path.join(runDir, "findings", "goal-gap-auditor.actions.json"), "[]");
  writeFileSync(path.join(runDir, "arch.json"), JSON.stringify({
    v: 2,
    repo: root,
    generatedAt: TEST_RUN,
    stats: {
      fileCount: 2,
      shown: 2,
      truncated: false,
      totalLoc: 180,
      importResolutionRate: 1,
      callResolutionRate: 0.8,
      totalCalls: 10,
      repoConfidence: 0.95,
    },
    workflows: [{ id: "test-flow", confidence: 0.9, files: 2, fileList: ["src/app.ts", "src/lib.ts"], entry: "src/app.ts", functionCount: 2, exportedSurface: ["run"] }],
    nodes: [
      { path: "src/app.ts", name: "app.ts", dir: "src", loc: 100, lang: "TypeScript", fns: [{ name: "run", loc: 30, params: 0, exported: true, calls: ["helper"] }], imports: ["./lib.js"], exports: ["run"], entry: "script", wfs: [0], test: "tested-real" },
      { path: "src/lib.ts", name: "lib.ts", dir: "src", loc: 80, lang: "TypeScript", fns: [{ name: "helper", loc: 20, params: 1, exported: true, calls: [] }], imports: [], exports: ["helper"], entry: null, wfs: [0], test: "untested" },
    ],
    edges: [[0, 1]],
  }));
  writeFileSync(path.join(runDir, "project.json"), JSON.stringify({
    repo: root,
    digest: {
      tagline: "A deterministic dashboard fixture",
      whatItIs: "A fixture used to verify the User-Tests dashboard.",
      howItWorks: "A small TypeScript entry point imports one helper module.",
      userFlows: ["Review run — inspect findings and evidence"],
      tech: ["TypeScript"],
      risks: ["Save action crashes"],
    },
  }));

  writeFileSync(path.join(outside, "REPORT.md"), "outside");
  symlinkSync(outside, path.join(root, "runs", "escaped-run"));
  return { root, outside };
}
