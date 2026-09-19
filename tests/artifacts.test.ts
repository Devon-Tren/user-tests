import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactIndex, readArtifact, resolveArtifact } from "../src/artifacts.js";

test("artifact access remains inside the run, including through symlinks", () => {
  const base = mkdtempSync(path.join(tmpdir(), "usertests-artifacts-"));
  const run = path.join(base, "run");
  mkdirSync(path.join(run, "findings"), { recursive: true });
  writeFileSync(path.join(run, "REPORT.md"), "# report");
  writeFileSync(path.join(run, "findings", "persona.json"), '{"ok":true}');
  const secret = path.join(base, "secret.txt");
  writeFileSync(secret, "not for the run");
  symlinkSync(secret, path.join(run, "secret-link.txt"));

  assert.equal(resolveArtifact(run, "../secret.txt"), null);
  assert.equal(resolveArtifact(run, "secret-link.txt"), null);
  assert.equal(readArtifact(run, "REPORT.md")?.text, "# report");
  assert.deepEqual(artifactIndex(run).map((item) => item.file), ["REPORT.md", "findings/persona.json", "secret-link.txt"]);
});
