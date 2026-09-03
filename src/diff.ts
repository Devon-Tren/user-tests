/**
 * diff.ts — "run comparison lite": a NEW-since-last-run banner via simple
 * hash-diff of finding identities. Deliberately not a full diffing feature:
 * a finding's identity is (severity, category, normalized title); anything in
 * this run whose hash wasn't in the previous run is NEW.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HASH_FILE = "findings-hashes.json";

export function hashFinding(f: { severity: string; category: string; title: string }): string {
  const norm = `${f.severity}|${f.category}|${f.title.toLowerCase().trim().replace(/\s+/g, " ")}`;
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

/** Persist this run's finding hashes so the NEXT run can diff against them. */
export function saveHashes(
  runDir: string,
  findings: { severity: string; category: string; title: string }[]
): void {
  writeFileSync(path.join(runDir, HASH_FILE), JSON.stringify(findings.map(hashFinding)));
}

export interface DiffResult {
  newCount: number;
  total: number;
  previousRun: string;
}

/**
 * Compare current hashes against the most recent PRIOR run that recorded
 * hashes. Returns null when there's nothing to diff against (first run).
 */
export function diffSinceLastRun(
  runsDir: string,
  currentRunDir: string,
  currentHashes: string[]
): DiffResult | null {
  if (!existsSync(runsDir)) return null;
  const previous = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && path.join(runsDir, d.name) !== currentRunDir)
    .map((d) => d.name)
    .sort()
    .reverse(); // ISO timestamps sort chronologically
  for (const name of previous) {
    const file = path.join(runsDir, name, HASH_FILE);
    if (!existsSync(file)) continue;
    try {
      const oldHashes = new Set(JSON.parse(readFileSync(file, "utf8")) as string[]);
      const newCount = currentHashes.filter((h) => !oldHashes.has(h)).length;
      return { newCount, total: currentHashes.length, previousRun: name };
    } catch {
      continue; // corrupt hash file — try the next older run
    }
  }
  return null;
}
