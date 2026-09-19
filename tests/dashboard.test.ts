import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { createDashboardServer } from "../src/serve.js";
import { makeDashboardProject, TEST_RUN } from "./fixture.js";

test("dashboard renders accurate integrity metrics and accessible navigation", async (t) => {
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {} });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${port}/?run=${TEST_RUN}&tab=overview`, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[role="tab"]').count(), 9);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').textContent(), "Overview");
  await assert.doesNotReject(() => page.getByText("Run integrity", { exact: true }).waitFor());
  const overview = await page.locator("main").innerText();
  assert.match(overview, /complete run/);
  assert.match(overview, /1 critical, 0 major, and 0 minor/);
  assert.match(overview, /2\/5 attempts/);
  assert.match(overview, /Core artifacts present/);
  assert.doesNotMatch(overview, /partial run/);

  const expectedText: Record<string, RegExp> = {
    Project: /A deterministic dashboard fixture/,
    Journey: /Where the testers went/,
    "Mind Map": /Project mind map/,
    Architecture: /Graph metrics/,
    Findings: /Save action crashes/,
    Artifacts: /Run folder/,
    Visual: /Your codebase, drawn in 3D/,
  };
  for (const [tab, text] of Object.entries(expectedText)) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await assert.doesNotReject(() => page.locator("main").getByText(text).first().waitFor());
  }

  await page.getByRole("tab", { name: "Architecture", exact: true }).click();
  await assert.doesNotReject(() => page.getByText("Modules mapped", { exact: true }).waitFor());
  assert.equal(await page.locator(".arch-node").count(), 2);
  await page.locator(".arch-node").first().click();
  assert.match(await page.locator("main").innerText(), /upstream in amber, downstream in green/);

  await page.getByRole("tab", { name: "Visual", exact: true }).click();
  await assert.doesNotReject(() => page.getByText("Your codebase, drawn in 3D.", { exact: true }).waitFor());
  await page.locator('#visual-canvas[data-renderer="webgl"]').waitFor();
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-semantic-geometry"), "true");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-layout"), "tiered-blueprint");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-directed-particles"), "true");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-post"), "blueprint-grade");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-projection"), "perspective");
  assert.ok(Number(await page.locator("#visual-canvas").getAttribute("data-tier-count")) >= 1);
  assert.ok(Number(await page.locator("#visual-canvas").getAttribute("data-bay-count")) >= 1);
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-node-count"), "2");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-edge-count"), "1");
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-full-orbit"), "true");
  assert.equal(await page.getByLabel("Toggle continuous 360-degree orbit").getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "TOUR", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "TOUR", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "TOUR", exact: true }).click();
  await page.getByRole("button", { name: "PLAN", exact: true }).click();
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-projection"), "orthographic");
  await page.getByRole("button", { name: "ISO", exact: true }).click();
  assert.equal(await page.locator("#visual-canvas").getAttribute("data-projection"), "perspective");
  await page.getByLabel("Jump to a repository module").selectOption("1");
  assert.match(await page.locator("#visual-inspector").innerText(), /src\/lib\.ts/);
  assert.match(await page.locator("#visual-inspector").innerText(), /untested/);
  await page.locator("#visual-canvas").focus();
  await page.keyboard.press("Home");

  await page.getByRole("tab", { name: "History" }).click();
  assert.match(page.url(), /tab=history/);
  assert.match(await page.locator("main").innerText(), /2 \/ 5/);

  await page.locator("#chat-fab").click();
  assert.equal(await page.locator("#chat-fab").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#chat-drawer").getAttribute("aria-hidden"), "false");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#chat-fab").getAttribute("aria-expanded"), "false");

  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.locator("body").evaluate((body) => ({ scroll: body.scrollWidth, client: body.clientWidth }));
  assert.equal(width.scroll, width.client);
  assert.deepEqual(errors, []);
});
