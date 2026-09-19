import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function configFile(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "usertests-config-"));
  const file = path.join(dir, "council.config.yaml");
  writeFileSync(file, body);
  return file;
}

const VALID = `
target: http://localhost:3000
repo_path: .
max_steps_per_agent: 10
viewport: { width: 1280, height: 720 }
council:
  testers:
    - persona: first-time-user
      harshness: 4
  chair:
    verify_repro: true
    min_severity_to_verify: major
    max_findings_per_run: 20
`;

test("config defaults safety rails and resolves the repository", () => {
  const file = configFile(VALID);
  const config = loadConfig(file, { repo: path.dirname(file) });
  assert.equal(config.limits.max_llm_calls, 250);
  assert.equal(config.council.chair.false_positive_pruning, true);
  assert.equal(config.repo_path, path.dirname(file));
});

test("config rejects malformed numeric CLI overrides", () => {
  const file = configFile(VALID);
  assert.throws(() => loadConfig(file, { steps: Number.NaN }), /max_steps_per_agent/);
});
