/**
 * report.ts — writes REPORT.md in EXACTLY the structure the spec fixes, and
 * copies referenced screenshots into shots/ with names matching the report.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { writeFileSync } from "node:fs";
import type { ReportFinding } from "./agents/chair.js";

interface ReportMeta {
  timestamp: string;
  target: string;
  testerCount: number;
  stepsPerAgent: number;
  /** Personas that failed or were skipped — the report is marked PARTIAL. */
  partial?: { persona: string; reason: string }[];
}

/** Rename/copy the finding's screenshot to a report-stable name like shots/c1.png. */
function stabilizeScreenshot(
  runDir: string,
  finding: ReportFinding,
  code: string
): string | undefined {
  if (!finding.screenshot) return undefined;
  const src = path.join(runDir, finding.screenshot);
  if (!existsSync(src)) return undefined;
  const destRel = path.join("shots", `${code}.png`);
  copyFileSync(src, path.join(runDir, destRel));
  return destRel.replace(/\\/g, "/");
}

function renderFinding(
  runDir: string,
  finding: ReportFinding,
  code: string,
  reproLabel: string
): string {
  const shot = stabilizeScreenshot(runDir, finding, code);
  const steps = finding.steps.map((s, i) => `${i + 1}. ${s.replace(/^\d+\.\s*/, "")}`).join(" ");
  const corroboration =
    finding.found_by.length > 1
      ? `✓ ${finding.found_by.length} personas`
      : "⚠ single persona";
  const lines = [
    `### ${code}: ${finding.title}`,
    `- **Found by:** ${finding.found_by.join(", ") || "unknown"} | **Repro:** ${reproLabel} | **Corroboration:** ${corroboration}`,
    `- **Steps:** ${steps || "(no steps recorded)"}`,
    `- **Expected:** ${finding.expected} | **Actual:** ${finding.actual}`,
  ];
  if (shot) lines.push(`- **Screenshot:** ${shot}`);
  return lines.join("\n");
}

function bySeverity(findings: ReportFinding[], sev: "critical" | "major" | "minor") {
  return findings.filter((f) => f.severity === sev);
}

export function writeReport(
  runDir: string,
  meta: ReportMeta,
  main: ReportFinding[],
  appendix: ReportFinding[],
  goalGaps: ReportFinding[]
): string {
  mkdirSync(path.join(runDir, "shots"), { recursive: true });

  const critical = bySeverity(main, "critical");
  const major = bySeverity(main, "major");
  const minor = bySeverity(main, "minor");

  const parts: string[] = [];
  parts.push(`# User-Tests Report — ${meta.timestamp}`);
  const status =
    meta.partial && meta.partial.length > 0
      ? ` | Status: PARTIAL (${meta.partial.map((p) => p.persona).join(", ")} failed/skipped)`
      : "";
  parts.push(
    `Target: ${meta.target} | Mode: full | Testers: ${meta.testerCount} | Steps/agent: ${meta.stepsPerAgent}${status}`
  );
  parts.push("");
  parts.push(`## Summary`);
  parts.push(
    `${main.length} confirmed findings: ${critical.length} critical, ${major.length} major, ${minor.length} minor. ${goalGaps.length} goal gaps.`
  );
  if (meta.partial) {
    for (const p of meta.partial) {
      parts.push(`- **Partial run:** persona "${p.persona}" did not complete — ${p.reason}`);
    }
  }
  parts.push("");

  parts.push(`## Critical`);
  if (critical.length === 0) parts.push("(none)");
  critical.forEach((f, i) =>
    parts.push(renderFinding(runDir, f, `C-${i + 1}`, f.repro === "confirmed" ? "confirmed" : f.repro))
  );
  parts.push("");

  parts.push(`## Major`);
  if (major.length === 0) parts.push("(none)");
  major.forEach((f, i) =>
    parts.push(renderFinding(runDir, f, `M-${i + 1}`, f.repro === "confirmed" ? "confirmed" : f.repro))
  );
  parts.push("");

  parts.push(`## Minor`);
  if (minor.length === 0) parts.push("(none)");
  minor.forEach((f, i) =>
    parts.push(
      renderFinding(runDir, f, `m-${i + 1}`, f.repro === "confirmed" ? "confirmed" : "unverified")
    )
  );
  parts.push("");

  parts.push(`## Goal Gaps`);
  if (goalGaps.length === 0) {
    parts.push("(none)");
  } else {
    for (const g of goalGaps) {
      parts.push(`- **Goal:** "${g.expected}" → **Gap:** ${g.actual}`);
    }
  }
  parts.push("");

  parts.push(`## Appendix: Unverified Findings`);
  if (appendix.length === 0) {
    parts.push("(none)");
  } else {
    for (const f of appendix) {
      parts.push(
        `- **${f.title}** (${f.found_by.join(", ") || "unknown"}): ${f.reproNote ?? "verification failed"}`
      );
    }
  }
  parts.push("");

  const out = path.join(runDir, "REPORT.md");
  writeFileSync(out, parts.join("\n"));

  // Machine-readable twin of the report (dashboard/serve consumes this; REPORT.md
  // stays the human deliverable). Codes match the report's C-n / M-n / m-n labels.
  const merged = [
    ...critical.map((f, i) => ({ code: `C-${i + 1}`, section: "main" as const, ...f })),
    ...major.map((f, i) => ({ code: `M-${i + 1}`, section: "main" as const, ...f })),
    ...minor.map((f, i) => ({ code: `m-${i + 1}`, section: "main" as const, ...f })),
    ...goalGaps.map((f, i) => ({ code: `G-${i + 1}`, section: "goal-gap" as const, ...f })),
    ...appendix.map((f, i) => ({ code: `A-${i + 1}`, section: "appendix" as const, ...f })),
  ];
  writeFileSync(
    path.join(runDir, "findings-merged.json"),
    JSON.stringify(
      {
        timestamp: meta.timestamp,
        target: meta.target,
        partial: meta.partial ?? [],
        findings: merged,
      },
      null,
      2
    )
  );
  return out;
}
