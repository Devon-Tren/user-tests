import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createDashboardServer } from "../src/serve.js";
import { makeDashboardProject, TEST_RUN } from "./fixture.js";

// Readiness is read from the environment. These assertions are about a tool
// that is already set up; the takeover path gets its own test below.
process.env.USERTESTS_API_KEY = "sk-dashboard-test-key";

/** Mark the one-time explainer as already seen — it opens over everything on a
 *  fresh browser profile, which is exactly what it is supposed to do. */
const returningVisitor = (page: import("playwright").Page) =>
  page.addInitScript(() => localStorage.setItem("usertests.welcome.v2", "1"));

test("dashboard renders accurate integrity metrics and accessible navigation", async (t) => {
  const { root } = makeDashboardProject();
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {} });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await returningVisitor(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${port}/?run=${TEST_RUN}&tab=overview`, { waitUntil: "networkidle" });
  // Four graph views used to be four top-level tabs; they live behind Explore now.
  assert.equal(await page.locator('[role="tab"]').count(), 7);
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
    Findings: /Save action crashes/,
    Artifacts: /Run folder/,
  };
  for (const [tab, text] of Object.entries(expectedText)) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await assert.doesNotReject(() => page.locator("main").getByText(text).first().waitFor());
  }

  // The four views are now reached through Explore's switcher, and each is
  // named for what it shows rather than for its data structure.
  await page.getByRole("tab", { name: "Explore", exact: true }).click();
  assert.equal(await page.locator(".explore-pick").count(), 4);
  const views: [RegExp, RegExp][] = [
    [/Where they went/, /Where the testers went/],
    [/What they found/, /Project mind map/],
    [/How your code fits together/, /Graph metrics/],
    [/Your codebase in 3D/, /Your codebase, drawn in 3D/],
  ];
  for (const [pick, text] of views) {
    await page.locator(".explore-pick").filter({ hasText: pick }).click();
    await assert.doesNotReject(() => page.locator("main").getByText(text).first().waitFor());
  }

  await page.locator(".explore-pick").filter({ hasText: /How your code fits together/ }).click();
  await assert.doesNotReject(() => page.getByText("Modules mapped", { exact: true }).waitFor());
  assert.equal(await page.locator(".arch-node").count(), 2);
  await page.locator(".arch-node").first().click();
  assert.match(await page.locator("main").innerText(), /upstream in amber, downstream in green/);

  await page.locator(".explore-pick").filter({ hasText: /Your codebase in 3D/ }).click();
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


  // Anyone holding an old ?tab=architecture link must still land on it.
  await page.goto(`http://127.0.0.1:${port}/?run=${TEST_RUN}&tab=architecture`, { waitUntil: "domcontentloaded" });
  await page.locator(".explore-pick.on").waitFor();
  assert.match(await page.locator(".explore-pick.on").innerText(), /How your code fits together/);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').textContent(), "Explore");
  assert.match(page.url(), /view=architecture/, "the view is reflected in the URL so it can be shared");

  await page.getByRole("tab", { name: "History" }).click();
  assert.match(page.url(), /tab=history/);
  assert.equal(await page.locator("#explore-bar-host").isVisible(), false, "the switcher belongs to Explore only");
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

test("without a key you keep the dashboard, and free mode is the way in", async (t) => {
  const { root } = makeDashboardProject();
  delete process.env.USERTESTS_API_KEY;
  t.after(() => { process.env.USERTESTS_API_KEY = "sk-dashboard-test-key"; });

  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await returningVisitor(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  // A missing key used to take the whole page over. It must not: past runs are
  // readable and mapping a codebase is free, so there is plenty to do here.
  await page.goto(`http://127.0.0.1:${port}/?run=${TEST_RUN}&tab=overview`, { waitUntil: "networkidle" });
  await page.getByText("Run integrity", { exact: true }).waitFor();
  assert.equal(await page.locator(".tabs").isVisible(), true, "a keyless user is not locked out of their own runs");

  // Start offers both paths, and says which one costs money.
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page.getByText("Map it free, or put it to the test").waitFor();
  assert.equal(await page.locator(".mode.free button").isDisabled(), false, "free mode never needs a key");
  assert.match(await page.locator(".mode.free").innerText(), /costs nothing/i);
  assert.equal(await page.locator(".mode.paid button").isDisabled(), true, "the council needs a key");
  assert.match(await page.locator(".mode.paid").innerText(), /\$/, "the paid path names a price");

  const main = await page.locator("main").innerText();
  assert.match(main, /an API key is needed to run the council/);
  assert.match(main, /mode 0600/, "the page says where the key goes before asking for it");
  assert.doesNotMatch(main, /sk-[A-Za-z0-9]{8}/, "no key is ever rendered into the page");
  assert.equal(await page.locator("#su-key").getAttribute("type"), "password");

  assert.deepEqual(errors, []);
});

test("with no key AND no runs, the page is taken over by the mode picker", async (t) => {
  // Nothing to read and nothing set up — the only genuine dead end, and even
  // here the free path is offered rather than a paywall.
  const { root } = makeDashboardProject();
  rmSync(path.join(root, "runs"), { recursive: true, force: true });
  mkdirSync(path.join(root, "runs"), { recursive: true });
  delete process.env.USERTESTS_API_KEY;
  t.after(() => { process.env.USERTESTS_API_KEY = "sk-dashboard-test-key"; });

  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await returningVisitor(page);

  await page.goto(`http://127.0.0.1:${port}/?tab=overview`, { waitUntil: "networkidle" });
  await page.getByText("Map it free, or put it to the test").waitFor();
  assert.equal(await page.locator(".tabs").isVisible(), false, "nothing to browse yet, so the tab bar stays hidden");
  assert.equal(await page.locator(".mode.free button").isDisabled(), false, "the free path is still the way forward");
});

test("a set-up tool with runs shows Start as an ordinary tab", async (t) => {
  const { root } = makeDashboardProject();
  process.env.USERTESTS_API_KEY = "sk-dashboard-test-key";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await returningVisitor(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${port}/?run=${TEST_RUN}&tab=start`, { waitUntil: "networkidle" });
  assert.equal(await page.locator(".tabs").isVisible(), true);
  await page.getByText("New run", { exact: true }).waitFor();

  // The OS dialog leads; the in-page browser is the fallback and starts hidden,
  // so a returning user is not staring at a directory tree they did not ask for.
  await page.getByRole("button", { name: /Choose a folder/ }).waitFor();
  assert.equal(await page.locator(".dirlist").isVisible(), false);

  await page.getByRole("button", { name: "Browse here instead" }).click();
  await page.locator(".dirlist .dir").first().waitFor();
  const dirs = await page.locator(".dirlist .dir").allInnerTexts();
  assert.ok(dirs.some((d) => d.includes("runs")));
  assert.ok(!dirs.some((d) => d.includes("REPORT.md")), "files are never listed");

  // No repo and no target yet, so there is nothing to start.
  const start = page.locator("#main button.btn").filter({ hasText: "Start the run" });
  assert.equal(await start.isDisabled(), true, "you cannot start a run before a cost is shown");
  assert.match(await page.locator("main").innerText(), /Pick a folder and a running app/);

  assert.deepEqual(errors, []);
});

test("a first-time visitor gets the explainer once, and can replay it", async (t) => {
  const { root } = makeDashboardProject();
  process.env.USERTESTS_API_KEY = "sk-dashboard-test-key";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  // No flag set: this is somebody's first ever visit.
  await page.goto(`http://127.0.0.1:${port}/?tab=start`, { waitUntil: "networkidle" });
  const dialog = page.locator("#welcome");
  // The fixture ships no walkthrough, so the deck starts on the written slides.
  await dialog.getByText("Four testers, one report").waitFor();
  assert.equal(await dialog.locator("video").count(), 0, "no video slide without a video");
  assert.equal(await dialog.getAttribute("aria-hidden"), "false");
  assert.equal(await dialog.getAttribute("aria-modal"), "true");

  // It explains the crew, the chair, and — the part people most need up front —
  // that this costs money and needs their app running.
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByText("Chaos hunter").waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByText("Dedupes").waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const caveats = await dialog.innerText();
  assert.match(caveats, /has to be running/);
  assert.match(caveats, /spends real money/);
  assert.match(caveats, /\$0\.50/);

  await page.getByRole("button", { name: "Let's go", exact: true }).click();
  assert.equal(await dialog.getAttribute("aria-hidden"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("usertests.welcome.v2")), "1");

  // Second visit: it stays out of the way.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("New run", { exact: true }).waitFor();
  assert.equal(await dialog.getAttribute("aria-hidden"), "true");

  // ...but it is still reachable, and Esc closes it.
  await page.getByRole("button", { name: /How does this work/ }).click();
  await dialog.getByText("Four testers, one report").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await dialog.getAttribute("aria-hidden"), "true");

  assert.deepEqual(errors, []);
});

test("the selected depth preset is the one the Start button prices", async (t) => {
  const { root } = makeDashboardProject();
  process.env.USERTESTS_API_KEY = "sk-dashboard-test-key";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1150 } });
  await returningVisitor(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${port}/?tab=start`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Browse here instead" }).click();
  await page.locator(".dirlist .dir").first().waitFor();
  await page.getByRole("button", { name: "Use this folder" }).click();
  // No dev server is required to price a run — the estimate never touches the network.
  await page.locator("#lp-target").fill("http://127.0.0.1:9");
  await page.locator("#lp-target").dispatchEvent("change");
  await page.locator(".preset").first().waitFor();
  await page.waitForTimeout(1200);

  const quoted = (card: string) => page.locator(card).locator(".cost").innerText();
  const startLabel = () => page.locator("#main button.btn").filter({ hasText: "Start the run" }).innerText();
  const priceIn = (s: string) => Number(/\$([\d.]+)/.exec(s)?.[1] ?? NaN);

  // The cheap option is preselected — a first-timer must not meet the big number.
  assert.match(await page.locator(".preset.on .nm").innerText(), /Quick pass/);

  // Guard the guard: assert.equal is Object.is, so NaN === NaN would let a
  // completely broken estimate pass this test silently. It did exactly that once.
  assert.ok(Number.isFinite(priceIn(await startLabel())), "the Start button must show a real price");
  assert.ok(Number.isFinite(priceIn(await quoted(".preset.on"))), "the preset card must show a real price");

  // THE bug this guards: the highlighted card and the button once disagreed,
  // so the price shown was not the price that would have been spent.
  assert.equal(priceIn(await startLabel()), priceIn(await quoted(".preset.on")),
    "the Start button must quote the selected preset");

  const quick = priceIn(await startLabel());
  await page.locator(".preset").nth(1).click();
  await page.waitForTimeout(1200);
  const full = priceIn(await startLabel());
  assert.ok(full > quick, `a full run must cost more than a quick pass (${full} vs ${quick})`);
  assert.equal(full, priceIn(await quoted(".preset.on")), "still in agreement after switching");

  // One tester is cheaper than four, and that is the whole point of the picker.
  const testers = await page.locator(".who button").count();
  assert.ok(testers >= 2, "a persona picker with at least 'all' plus one tester");
  await page.locator(".who button").nth(1).click();
  await page.waitForTimeout(1200);
  assert.ok(priceIn(await startLabel()) < full, "a single persona must cost less than the whole council");

  assert.deepEqual(errors, []);
});

test("pressing Start survives the blur it causes", async (t) => {
  // Real bug, found 2026-09-22: clicking Start blurs the target field, which
  // fires a native change, which re-priced the run — tearing down the estimate
  // mid-click. The button moved ~55px and went disabled between mousedown and
  // mouseup, so no click event ever fired and the primary path was dead.
  const { root } = makeDashboardProject();
  process.env.USERTESTS_API_KEY = "sk-dashboard-test-key";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: "tok", browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  await returningVisitor(page);

  // Never let the run actually start — this asserts the click lands, nothing more.
  let started = false;
  await page.route("**/api/run/start", (route) => {
    started = true;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { id: "t", state: "running", target: "x", repoPath: "y", startedAt: new Date().toISOString(), runDir: null, exitCode: null, error: null } }) });
  });

  await page.goto(`http://127.0.0.1:${port}/?tab=start`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Browse here instead" }).click();
  await page.locator(".dirlist .dir").first().waitFor();
  await page.getByRole("button", { name: "Use this folder" }).click();

  // Type into the target and go STRAIGHT to Start, with no click in between —
  // exactly the sequence that used to swallow the click.
  await page.locator("#lp-target").fill("http://127.0.0.1:9");
  await page.locator("#lp-target").dispatchEvent("change");
  const start = page.locator("#main button.btn").filter({ hasText: "Start the run" });
  await start.waitFor();
  await page.waitForTimeout(1500);

  const before = await start.evaluate((n) => n.getBoundingClientRect().y);
  await page.locator("#lp-target").focus();          // put focus back on the field
  await start.click();
  await page.waitForTimeout(1200);
  const after = await start.count() ? await start.evaluate((n) => n.getBoundingClientRect().y) : before;

  assert.equal(started, true, "the click must reach /api/run/start even though it blurs the target field");
  assert.ok(Math.abs(after - before) < 20, `the button must not jump under the press (${before} -> ${after})`);
});
