import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReportFinding } from "../src/agents/chair.js";
import { writeReport } from "../src/report.js";

const finding: ReportFinding = {
  title: "Save fails",
  severity: "major",
  category: "bug",
  found_by: ["chaos-hunter"],
  steps: ["1. Click Save"],
  expected: "The item is saved.",
  actual: "Nothing happens.",
  goal_gap: false,
  source_persona: "chaos-hunter",
  atStep: 1,
  repro: "confirmed",
};

test("report output is complete and does not emit empty template fields", () => {
  const run = mkdtempSync(path.join(tmpdir(), "usertests-report-"));
  const reportPath = writeReport(run, {
    timestamp: "2026-09-15T12-00-00.000Z",
    target: "http://localhost:4173",
    testerCount: 1,
    stepsPerAgent: 5,
    partial: [],
  }, [finding], [], []);

  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /1 confirmed finding/);
  assert.doesNotMatch(report, /Suggested fix:\s*$/m);
  assert.doesNotMatch(report, /Status: PARTIAL/);
  const merged = JSON.parse(readFileSync(path.join(run, "findings-merged.json"), "utf8")) as { findings: { code: string }[] };
  assert.equal(merged.findings[0]?.code, "M-1");
});
