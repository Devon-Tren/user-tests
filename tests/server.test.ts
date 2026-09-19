import assert from "node:assert/strict";
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

test("server rejects invalid ports before listening", () => {
  assert.throws(
    () => startServer({ projectRoot: "/does/not/matter", port: Number.NaN, log: () => {} }),
    /port must be an integer/
  );
});
