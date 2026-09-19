import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Runner } from "../src/runner.js";

test("runner snapshots expose keyboard focus and accessible control state", async (t) => {
  const runner = new Runner(mkdtempSync(path.join(tmpdir(), "usertests-runner-")), { width: 800, height: 600 });
  await runner.launch();
  t.after(() => runner.close());
  await runner.act(0, "goto", {
    url: "data:text/html,<button aria-expanded='true'>Menu</button><input type='checkbox' checked>",
  });
  const result = await runner.act(1, "pressKey", { key: "Tab" });
  assert.match(result.snapshot ?? "", /button "Menu".*\[focused\].*\[expanded=true\]/);
  assert.match(result.snapshot ?? "", /checkbox.*\[checked\]/);
});
