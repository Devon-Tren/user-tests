import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createDashboardServer, startServer } from "../src/serve.js";
import { makeDashboardProject, TEST_RUN } from "./fixture.js";

test("dashboard API reports trustworthy run status and rejects escaped paths", async (t) => {
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {} });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const three = await fetch(base + "/vendor/three.module.js");
  assert.equal(three.status, 200);
  assert.match(three.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await three.text(), /WebGLRenderer/);
  assert.equal((await fetch(base + "/vendor/three.core.js")).status, 200);
  const addon = await fetch(base + "/vendor/addons/postprocessing/OutputPass.js");
  assert.equal(addon.status, 200);
  assert.match(addon.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await addon.text(), /OutputPass/);
  assert.equal((await fetch(base + "/vendor/addons/postprocessing/DoesNotExist.js")).status, 404);
  const visual = await fetch(base + "/visual-webgl.js");
  assert.equal(visual.status, 200);
  assert.match(await visual.text(), /initVisualWebGL/);

  const runRes = await fetch(`${base}/api/run?dir=${TEST_RUN}`);
  assert.equal(runRes.status, 200);
  const run = await runRes.json() as {
    partial: unknown[];
    partialFlag: boolean;
    stats: { llmCalls: number; llmAttempts: number; retryAttempts: number };
    personas: { name: string; steps: unknown[] }[];
  };
  assert.equal(run.partialFlag, false);
  assert.deepEqual(run.partial, []);
  assert.deepEqual(run.stats, { ...run.stats, llmCalls: 2, llmAttempts: 5, retryAttempts: 3 });
  assert.deepEqual(run.personas.find((persona) => persona.name === "chaos-hunter")?.steps, []);

  const index = await fetch(base + "/api/runs").then((res) => res.json()) as { runs: { llmCalls: number; llmAttempts: number; partial: boolean }[] };
  assert.equal(index.runs[0]?.llmAttempts, 5);
  assert.equal(index.runs[0]?.partial, false);

  assert.equal((await fetch(`${base}/api/run?dir=escaped-run`)).status, 400);
  assert.equal((await fetch(`${base}/api/artifact?dir=${TEST_RUN}&file=../../REPORT.md`)).status, 404);
  assert.equal((await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  })).status, 400);
  assert.equal((await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(513 * 1024) }),
  })).status, 413);
});

test("onboarding routes are guarded and contained", async (t) => {
  const { root, outside } = makeDashboardProject();
  const TOKEN = "test-token-value";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: TOKEN, browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-usertests-token": TOKEN, ...headers },
      body: JSON.stringify(body),
    });

  // Readiness is free and needs no token — the Start screen calls it on load.
  const setup = await fetch(base + "/api/setup");
  assert.equal(setup.status, 200);
  const readiness = await setup.json() as { checks: { id: string }[]; keyHint: string | null; model: string };
  assert.ok(readiness.checks.some((c) => c.id === "apiKey"));
  assert.ok(readiness.model.length > 0, "the model resolves without an API key");
  assert.doesNotMatch(JSON.stringify(readiness), /sk-[A-Za-z0-9]{8,}/, "readiness never carries a real key");

  // The token gates every mutating route, and the disclosing GET.
  assert.equal((await fetch(base + "/api/fs/list")).status, 401);
  assert.equal((await post("/api/setup", {}, { "x-usertests-token": "wrong" })).status, 401);
  assert.equal((await post("/api/run/start", {}, { "x-usertests-token": "" })).status, 401);

  // A page you happen to be visiting must not be able to drive the actuator.
  assert.equal((await post("/api/setup", {}, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post("/api/setup", {}, { origin: "null" })).status, 403);
  // A simple (preflight-free) cross-origin POST cannot set a JSON content-type.
  assert.equal((await post("/api/setup", {}, { "content-type": "text/plain" })).status, 415);

  // Folder browsing: directories only, and containment survives a traversal attempt.
  const listing = await fetch(base + "/api/fs/list", { headers: { "x-usertests-token": TOKEN } });
  assert.equal(listing.status, 200);
  const dirs = await listing.json() as { path: string; parent: string | null; entries: { name: string }[] };
  assert.equal(dirs.path, realpathSync(root));
  assert.equal(dirs.parent, null, "the browse root has no parent to escape into");
  assert.ok(dirs.entries.some((e) => e.name === "runs"));
  assert.ok(!dirs.entries.some((e) => e.name === "REPORT.md"), "files are never listed");
  assert.equal((await fetch(`${base}/api/fs/list?path=${encodeURIComponent(outside)}`, { headers: { "x-usertests-token": TOKEN } })).status, 400);
  assert.equal((await fetch(`${base}/api/fs/list?path=${encodeURIComponent("../../etc")}`, { headers: { "x-usertests-token": TOKEN } })).status, 400);

  // A run cannot start without a cost having been shown to a human first.
  const noConfirm = await post("/api/run/start", { target: "http://127.0.0.1:1", repoPath: root });
  assert.equal(noConfirm.status, 400);
  assert.match((await noConfirm.json() as { error: string }).error, /confirmCostUsd/);
  // ...nor against a repo the folder browser could never have reached.
  const escaped = await post("/api/run/start", { target: "http://127.0.0.1:1", repoPath: outside, confirmCostUsd: 0.5 });
  assert.equal(escaped.status, 400);
  assert.match((await escaped.json() as { error: string }).error, /outside the browsable root/);

  assert.deepEqual(await (await fetch(base + "/api/run/status")).json(), { run: null, active: false });
  assert.equal((await post("/api/run/cancel", {})).status, 409, "cancelling with no run in flight is a conflict");
});

test("three is resolved through node, not by guessing node_modules layout", async (t) => {
  // A clean `npm install` HOISTS three to the top-level node_modules, so the
  // old "../node_modules/three/..." path did not exist and `usertests serve`
  // died at boot with "WebGL runtime not found". Caught only by installing the
  // real tarball into an empty directory — nothing in a dev checkout shows it.
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {} });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The fixture root has no node_modules at all — if resolution were relative
  // to projectRoot rather than to this module, every one of these would 404.
  assert.equal(existsSync(path.join(root, "node_modules")), false, "the fixture must not have its own node_modules");

  for (const asset of [
    "/vendor/three.module.js",
    "/vendor/three.core.js",
    "/vendor/addons/postprocessing/EffectComposer.js",
    "/vendor/addons/postprocessing/UnrealBloomPass.js",
  ]) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, `${asset} must be served wherever three was hoisted to`);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  }

  // Addons still may not escape their root.
  assert.equal((await fetch(base + "/vendor/addons/../../../etc/passwd")).status, 404);
});

test("the walkthrough video is optional and seekable", async (t) => {
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The fixture has no docs/ — a lean install must degrade, not break.
  assert.equal((await fetch(base + "/demo.mp4")).status, 404);
  const lean = await (await fetch(base + "/api/setup")).json() as { demoVideo: boolean };
  assert.equal(lean.demoVideo, false, "the welcome skips its video slide when none is installed");

  // Install one and the route wakes up.
  mkdirSync(path.join(root, "docs"), { recursive: true });
  const bytes = Buffer.alloc(5_000, 7);
  writeFileSync(path.join(root, "docs", "user-tests-walkthrough.mp4"), bytes);
  assert.equal((await (await fetch(base + "/api/setup")).json() as { demoVideo: boolean }).demoVideo, true);

  const whole = await fetch(base + "/demo.mp4");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes", "without this the scrubber is dead");
  assert.equal(whole.headers.get("content-length"), String(bytes.length));

  // Seeking is a range request; a 200 here would break the player's scrubber.
  const part = await fetch(base + "/demo.mp4", { headers: { range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${bytes.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  // Open-ended and out-of-bounds ranges both have defined answers.
  const tail = await fetch(base + "/demo.mp4", { headers: { range: "bytes=4900-" } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 100);
  const over = await fetch(base + "/demo.mp4", { headers: { range: "bytes=99999-" } });
  assert.equal(over.status, 416);
  assert.equal(over.headers.get("content-range"), `bytes */${bytes.length}`);
});

test("the dashboard is served with a substituted token", async (t) => {
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "abc123token" });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
  assert.ok(html.includes('"abc123token"'), "the page receives the token");
  assert.ok(!html.includes("__USERTESTS_TOKEN__"), "no placeholder is left behind");
});

test("server rejects invalid ports before listening", () => {
  assert.throws(
    () => startServer({ projectRoot: "/does/not/matter", port: Number.NaN, log: () => {} }),
    /port must be an integer/
  );
});
