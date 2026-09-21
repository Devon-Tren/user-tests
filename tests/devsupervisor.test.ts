import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DevServerSupervisor } from "../src/devserver.js";

/** A project whose dev script is a real server that announces itself like vite. */
function servingProject(announce = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "usertests-devsup-"));
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
  writeFileSync(path.join(dir, "server.js"), `
    const http = require("http");
    const s = http.createServer((q, r) => { r.writeHead(200); r.end("ok"); });
    s.listen(0, "127.0.0.1", () => {
      ${announce ? 'setTimeout(() => console.log("  ->  Local:   http://localhost:" + s.address().port + "/"), 150);' : ""}
    });
  `);
  return dir;
}

const settle = async (sup: DevServerSupervisor, want: string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (sup.current().state === want) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
};

test("a started dev server is reachable at the URL it announced, and dies on stop", async (t) => {
  const sup = new DevServerSupervisor(() => {});
  t.after(() => { if (sup.running) sup.stop(); });

  const started = sup.start(servingProject());
  assert.equal(started.state, "starting");
  assert.equal(started.command, "npm run dev", "runs exactly the command the user was shown");

  assert.ok(await settle(sup, "ready"), "should reach ready once it prints its address");
  const url = sup.current().url;
  assert.ok(url && /^http:\/\/localhost:\d+$/.test(url), `expected a localhost URL, got ${url}`);
  assert.equal((await fetch(url!)).status, 200, "the URL it reported must actually serve");

  // Starting a second one would leak the first.
  assert.throws(() => sup.start(servingProject()), /already running/);

  sup.stop();
  assert.equal(sup.current().state, "stopped");
  assert.equal(sup.running, false);
  await new Promise((r) => setTimeout(r, 700));
  // The group kill must take the grandchild (npm -> node) with it.
  await assert.rejects(() => fetch(url!), "the server should be gone, not orphaned");
});

test("a project with nothing to run says so instead of guessing", () => {
  const sup = new DevServerSupervisor(() => {});
  const bare = mkdtempSync(path.join(tmpdir(), "usertests-bare-"));
  writeFileSync(path.join(bare, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  assert.throws(() => sup.start(bare), /no dev or start script/);

  // Running before installing produces a confusing failure — refuse up front.
  const uninstalled = mkdtempSync(path.join(tmpdir(), "usertests-noinstall-"));
  writeFileSync(path.join(uninstalled, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  assert.throws(() => sup.start(uninstalled), /dependencies are not installed/);

  assert.throws(() => sup.start(servingProject(), "deploy"), /not one of this project's scripts/);
});

test("a dev server that exits on its own is reported as failed", async (t) => {
  const sup = new DevServerSupervisor(() => {});
  t.after(() => { if (sup.running) sup.stop(); });
  const dir = mkdtempSync(path.join(tmpdir(), "usertests-crash-"));
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node -e \"console.log('boom'); process.exit(1)\"" } }));

  sup.start(dir);
  assert.ok(await settle(sup, "failed"), "an early exit is a failure, not a silent hang");
  assert.match(sup.current().error ?? "", /exited early/);
  assert.ok(sup.current().lines.some((l) => l.includes("boom")), "its output is kept so the cause is visible");
});
