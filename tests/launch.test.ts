import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunSupervisor, type RunEvent } from "../src/launch.js";

/** A stand-in for `dist/cli.js run` that writes a run folder, then exits. */
function fakeProject(script: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "usertests-launch-"));
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(path.join(root, "runs"), { recursive: true });
  // dist/cli.js is ESM in the real package; say so here too.
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(root, "dist", "cli.js"), script);
  return root;
}

/** Something for assertReachable() to reach. */
async function liveTarget(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const collect = (sup: RunSupervisor, done: (info: Record<string, unknown>) => void) =>
  sup.subscribe((e) => { if (e.type === "launch_end") done(e); });

test("a launched run streams stdout and run.log, then reports the finished run dir", async (t) => {
  const RUN = "2026-09-20T10-00-00.000Z";
  const root = fakeProject(`
    import { mkdirSync, appendFileSync } from "node:fs";
    import path from "node:path";
    const runDir = path.join(process.env.FAKE_RUNS, ${JSON.stringify(RUN)});
    console.log("[usertests] run folder: runs/${RUN}");
    mkdirSync(runDir, { recursive: true });
    const ev = (o) => appendFileSync(path.join(runDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\\n");
    ev({ type: "phase", phase: "start", testers: 2, target: "x" });
    ev({ type: "persona_start", persona: "chaos-hunter" });
    ev({ type: "llm_call", persona: "chaos-hunter", cost_usd: 0.02 });
    ev({ type: "persona_end", persona: "chaos-hunter", steps: 3, findings: 1 });
    ev({ type: "phase", phase: "done", findings: 1 });
    await new Promise((r) => setTimeout(r, 900));
  `);
  process.env.USERTESTS_API_KEY = "sk-test-key-for-launch";
  process.env.FAKE_RUNS = path.join(root, "runs");

  const sup = new RunSupervisor(root, () => {});
  const target = await liveTarget(t);
  const events: RunEvent[] = [];
  sup.subscribe((e) => events.push(e));
  const ended = new Promise<Record<string, unknown>>((resolve) => collect(sup, resolve));

  const status = await sup.start({ target, repoPath: root });
  assert.equal(status.state, "running");
  assert.ok(sup.active);
  // Starting a second run while one is in flight is refused.
  await assert.rejects(() => sup.start({ target, repoPath: root }), /already in flight/);

  const end = await ended;
  assert.equal(end["state"], "done");
  assert.equal(end["runDir"], RUN, "the run folder is discovered and reported back");

  const types = events.map((e) => e.type);
  assert.ok(types.includes("log"), "child stdout is relayed for the pre-run phase");
  assert.ok(types.includes("phase"), "run.log phase events are tailed");
  assert.ok(types.includes("persona_end"));
  assert.ok(types.includes("llm_call"), "cost events reach the feed so spend can be shown live");
  assert.ok(
    events.some((e) => e.type === "log" && String(e["line"]).includes("run folder")),
    "the [usertests] prefix is stripped but the line survives"
  );
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
    "sequence numbers are gapless so a reconnect can resume from one"
  );
  assert.equal(sup.backlog(events.length - 1).length, 1, "backlog replays only what a client missed");
  assert.equal(sup.active, false);
});

test("a run cannot start without a key, a real folder, or a reachable target", async (t) => {
  const root = fakeProject("process.exit(0);");
  const target = await liveTarget(t);
  const sup = new RunSupervisor(root, () => {});

  delete process.env.USERTESTS_API_KEY;
  await assert.rejects(() => sup.start({ target, repoPath: root }), /no API key/);

  process.env.USERTESTS_API_KEY = "sk-test-key-for-launch";
  await assert.rejects(() => sup.start({ target, repoPath: path.join(root, "nope") }), /not a folder/);
  // Unreachable target: the whole point is that this costs nothing.
  await assert.rejects(() => sup.start({ target: "http://127.0.0.1:1", repoPath: root }), /not reachable/);
  assert.equal(sup.active, false);
});

test("cancelling a run stops it and reports it as cancelled", async (t) => {
  const root = fakeProject(`
    console.log("[usertests] working…");
    await new Promise((r) => setTimeout(r, 30_000));
  `);
  process.env.USERTESTS_API_KEY = "sk-test-key-for-launch";
  const sup = new RunSupervisor(root, () => {});
  const target = await liveTarget(t);
  const ended = new Promise<Record<string, unknown>>((resolve) => collect(sup, resolve));

  await sup.start({ target, repoPath: root });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sup.cancel().state, "cancelled");

  const end = await ended;
  assert.equal(end["state"], "cancelled");
  assert.equal(sup.active, false);
});
