import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createDashboardServer } from "../src/serve.js";
import { nativePickerAvailable } from "../src/pick.js";
import { makeDashboardProject } from "./fixture.js";

test("native picker availability reflects the platform and display", () => {
  assert.equal(nativePickerAvailable("darwin", {}), true);
  assert.equal(nativePickerAvailable("win32", {}), true);
  // A Linux box with no display has no dialog to put on screen.
  assert.equal(nativePickerAvailable("linux", {}), false);
  assert.equal(nativePickerAvailable("linux", { DISPLAY: ":0" }), true);
  assert.equal(nativePickerAvailable("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
});

test("the pick route is guarded like every other actuator route", async (t) => {
  const { root } = makeDashboardProject();
  const TOKEN = "pick-token";
  const server = createDashboardServer({ projectRoot: root, port: 0, log: () => {}, token: TOKEN, browseRoot: root });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // No token, wrong origin, and wrong content-type are all refused before any
  // dialog can be put on the user's screen — a stray page must not be able to
  // make Finder pop open.
  assert.equal((await fetch(base + "/api/fs/pick", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(base + "/api/fs/pick", {
    method: "POST",
    headers: { "content-type": "application/json", "x-usertests-token": TOKEN, origin: "http://evil.example" },
    body: "{}",
  })).status, 403);
  assert.equal((await fetch(base + "/api/fs/pick", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-usertests-token": TOKEN },
    body: "{}",
  })).status, 415);

  // The folder listing tells the UI whether to offer the native button at all.
  const listing = await fetch(base + "/api/fs/list", { headers: { "x-usertests-token": TOKEN } });
  const body = await listing.json() as { nativePicker: boolean };
  assert.equal(typeof body.nativePicker, "boolean");
});
