import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectDevCommand } from "../src/devserver.js";

function project(scripts: Record<string, string>, opts: { lock?: string; installed?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "usertests-dev-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  if (opts.lock) writeFileSync(path.join(dir, opts.lock), "");
  if (opts.installed) mkdirSync(path.join(dir, "node_modules"));
  return dir;
}

test("the start command matches the project's own manager and scripts", () => {
  // Each manager gets its own idiom, not a lowest-common-denominator form.
  assert.equal(detectDevCommand(project({ dev: "vite" }, { installed: true }))?.command, "npm run dev");
  assert.equal(detectDevCommand(project({ start: "node s.js" }, { installed: true }))?.command, "npm start");
  assert.equal(detectDevCommand(project({ dev: "next" }, { lock: "yarn.lock", installed: true }))?.command, "yarn dev");
  assert.equal(detectDevCommand(project({ dev: "vite" }, { lock: "pnpm-lock.yaml", installed: true }))?.command, "pnpm dev");
  assert.equal(detectDevCommand(project({ dev: "x" }, { lock: "bun.lockb", installed: true }))?.command, "bun run dev");
});

test("dev is preferred over other servers, and non-servers are never offered", () => {
  const d = detectDevCommand(project({ build: "tsc", serve: "http-server", dev: "vite", test: "jest" }, { installed: true }));
  assert.equal(d?.script, "dev", "dev wins when several could serve");
  assert.deepEqual(d?.candidates, ["dev", "serve"], "alternatives are offered, build/test are not");

  // A project with nothing that serves must say so rather than guess.
  assert.equal(detectDevCommand(project({ test: "jest", build: "tsc" }, { installed: true })), null);
  assert.equal(detectDevCommand(project({}, { installed: true })), null);
  assert.equal(detectDevCommand(mkdtempSync(path.join(tmpdir(), "usertests-nopkg-"))), null);
});

test("a missing node_modules is reported, because the command would just fail", () => {
  const missing = detectDevCommand(project({ dev: "vite" }, { lock: "pnpm-lock.yaml" }));
  assert.equal(missing?.needsInstall, true);
  assert.equal(missing?.installCommand, "pnpm install");

  const ready = detectDevCommand(project({ dev: "vite" }, { lock: "pnpm-lock.yaml", installed: true }));
  assert.equal(ready?.needsInstall, false);
});

test("a malformed package.json degrades instead of throwing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usertests-bad-"));
  writeFileSync(path.join(dir, "package.json"), "{not json");
  assert.equal(detectDevCommand(dir), null);
});
