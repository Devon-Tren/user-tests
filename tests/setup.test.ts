import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { maskKey, readiness, writeEnvKeys } from "../src/setup.js";
import { redactSecrets } from "../src/logger.js";

test("writeEnvKeys rewrites only the keys it owns", () => {
  const root = mkdtempSync(path.join(tmpdir(), "usertests-env-"));
  const file = path.join(root, ".env");
  // A .env the user hand-wrote: comments, an unrelated var, a key to replace.
  writeFileSync(file, [
    "# my project secrets",
    "DATABASE_URL=postgres://localhost/app",
    "USERTESTS_API_KEY=sk-old-key-value",
    "",
    "# keep this comment",
    "STRIPE_KEY=sk_live_untouched",
  ].join("\n") + "\n");

  writeEnvKeys(root, { USERTESTS_API_KEY: "sk-new-key-value", USERTESTS_PROVIDER: "openai" });
  const after = readFileSync(file, "utf8");

  assert.match(after, /^# my project secrets$/m, "comments survive");
  assert.match(after, /^DATABASE_URL=postgres:\/\/localhost\/app$/m, "unrelated vars survive");
  assert.match(after, /^# keep this comment$/m);
  assert.match(after, /^STRIPE_KEY=sk_live_untouched$/m, "another tool's key is not touched");
  assert.match(after, /^USERTESTS_API_KEY=sk-new-key-value$/m, "owned key is replaced");
  assert.doesNotMatch(after, /sk-old-key-value/, "the old value is gone, not shadowed");
  assert.equal(after.match(/^USERTESTS_API_KEY=/gm)?.length, 1, "replaced in place, not duplicated");
  assert.match(after, /^USERTESTS_PROVIDER=openai$/m, "a new owned key is appended");
  assert.equal(statSync(file).mode & 0o777, 0o600, "credentials file is not world-readable");
});

test("writeEnvKeys creates a 0600 file when none exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "usertests-env-new-"));
  const file = writeEnvKeys(root, { USERTESTS_API_KEY: "sk-fresh" });
  assert.equal(readFileSync(file, "utf8"), "USERTESTS_API_KEY=sk-fresh\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("writeEnvKeys refuses a value that would forge extra env lines", () => {
  const root = mkdtempSync(path.join(tmpdir(), "usertests-env-inj-"));
  assert.throws(
    () => writeEnvKeys(root, { USERTESTS_API_KEY: "sk-x\nUSERTESTS_BASE_URL=http://attacker" }),
    /must not contain newlines/
  );
});

test("maskKey keeps the tail and discards the rest", () => {
  assert.equal(maskKey("sk-ant-api03-abcdefgh4f2a"), "sk-…4f2a");
  assert.equal(maskKey("short"), "…set");
});

test("redactSecrets strips keys from log events by name and by shape", () => {
  const out = redactSecrets({
    persona: "chaos-hunter",
    apiKey: "sk-ant-api03-supersecretvalue",
    nested: { error: "auth failed for sk-ant-api03-anothersecretvalue" },
    headers: { authorization: "Bearer abcdefghijklmnopqrst" },
    steps: 7,
  }) as Record<string, unknown>;

  const serialised = JSON.stringify(out);
  assert.doesNotMatch(serialised, /supersecretvalue/, "a key in a named field is redacted");
  assert.doesNotMatch(serialised, /anothersecretvalue/, "a key inside prose is redacted");
  assert.doesNotMatch(serialised, /abcdefghijklmnopqrst/, "a bearer token is redacted");
  assert.equal(out["persona"], "chaos-hunter", "non-secret fields are untouched");
  assert.equal(out["steps"], 7, "non-strings pass through");
});

test("a missing API key blocks running the council, not using the dashboard", async () => {
  // FREE mode: mapping a codebase is static analysis. It spends nothing, so a
  // keyless user must not be a dead end.
  const root = mkdtempSync(path.join(tmpdir(), "usertests-ready-"));
  const saved = process.env["USERTESTS_API_KEY"];
  delete process.env["USERTESTS_API_KEY"];
  try {
    const r = await readiness(root);
    assert.equal(r.ready, true, "the dashboard is usable without a key");
    assert.equal(r.canRun, false, "but the council cannot run");
    assert.match(r.cannotRunReason ?? "", /API key/);
    assert.equal(r.keyHint, null, "no key, nothing to hint at");

    const key = r.checks.find((c) => c.id === "apiKey");
    assert.equal(key?.ok, false);
    assert.equal(key?.blocking, false, "the key gates spending, not the dashboard");
    assert.match(key?.detail ?? "", /free/i, "the copy has to say the free path still works");

    process.env["USERTESTS_API_KEY"] = "sk-test-abcd1234";
    const withKey = await readiness(root);
    assert.equal(withKey.canRun, true);
    assert.equal(withKey.cannotRunReason, null);
    assert.equal(withKey.keyHint, "sk-…1234", "masked, never the whole key");
  } finally {
    if (saved) process.env["USERTESTS_API_KEY"] = saved; else delete process.env["USERTESTS_API_KEY"];
  }
});
