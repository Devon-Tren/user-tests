import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { budgetStatus, callLLM, configureLLM, estimateCostUsd } from "../src/llm.js";

test("OpenAI-compatible calls retry transient failures and account for attempts", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end('{"error":"try again"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    }));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const previous = {
    provider: process.env.USERTESTS_PROVIDER,
    model: process.env.USERTESTS_MODEL,
    key: process.env.USERTESTS_API_KEY,
    base: process.env.USERTESTS_BASE_URL,
  };
  t.after(() => {
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore("USERTESTS_PROVIDER", previous.provider);
    restore("USERTESTS_MODEL", previous.model);
    restore("USERTESTS_API_KEY", previous.key);
    restore("USERTESTS_BASE_URL", previous.base);
  });
  process.env.USERTESTS_PROVIDER = "openai";
  process.env.USERTESTS_MODEL = "gpt-4.1-mini";
  process.env.USERTESTS_API_KEY = "test-key";
  process.env.USERTESTS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureLLM({ maxCalls: 5, maxCostUsd: 1, timeoutSeconds: 2 });

  const response = await callLLM({ system: "test", user: "test" });
  assert.equal(response.text, "ok");
  assert.equal(requests, 2);
  assert.equal(response.costUsd, estimateCostUsd("gpt-4.1-mini", 1000, 100));
  assert.equal(budgetStatus().callsMade, 2);
});
