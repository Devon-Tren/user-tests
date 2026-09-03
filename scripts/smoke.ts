/**
 * smoke.ts — proves the runner works end to end with zero LLM calls:
 * opens a page, takes a screenshot, prints the DOM snapshot.
 *
 *   npm run smoke -- http://localhost:4173
 */
import { Runner } from "../src/runner.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:4173";
const runDir = mkdtempSync(path.join(tmpdir(), "usertests-smoke-"));

const runner = new Runner(runDir, { width: 1440, height: 900 });
await runner.launch();
try {
  const res = await runner.act(0, "goto", { url });
  console.log(`goto ok=${res.ok}${res.error ? ` error=${res.error}` : ""}`);
  const shot = await runner.act(1, "screenshot", {});
  console.log(`screenshot → ${path.join(runDir, shot.screenshot ?? "")}`);
  console.log("\n--- SNAPSHOT ---");
  console.log(res.snapshot);
  console.log(`\naction log entries: ${runner.log.length}`);
} finally {
  await runner.close();
}
