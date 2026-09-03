/**
 * llm.ts — the ONE LLM abstraction for the entire tool.
 *
 * Every agent talks to the model through callLLM(). Provider is selected purely
 * via environment variables — swapping backends requires zero code changes:
 *
 *   USERTESTS_PROVIDER  "anthropic" (default) | "openai"
 *   USERTESTS_MODEL     e.g. "claude-sonnet-4-5" or "gpt-4o"
 *   USERTESTS_API_KEY   required
 *   USERTESTS_BASE_URL  optional override (Anthropic-compatible or OpenAI-compatible endpoint)
 *
 * This is the ONLY file allowed to import a provider SDK.
 *
 * Also owns run-wide safety rails:
 *  - token/cost usage is measured on every call (LLMResponse)
 *  - a hard budget (configureLLM) stops spending with BudgetExceededError
 *  - transient failures retry with exponential backoff (3 attempts)
 *  - every attempt has a per-call timeout
 */
import Anthropic from "@anthropic-ai/sdk";

export interface LLMRequest {
  system: string;
  user: string;
  /** PNG/JPEG screenshots the model should look at alongside the text. */
  images?: Buffer[];
}

export interface LLMResponse {
  text: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD cost of this call; null when the model isn't in the price table. */
  costUsd: number | null;
  durationMs: number;
}

/** Thrown when a run-wide budget cap (calls or cost) is hit. NOT retryable. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

type Provider = "anthropic" | "openai";

interface ProviderConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** USD per 1M tokens. Models not listed here get costUsd: null (tracked, unpriced). */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Model/provider that WILL be used, without requiring the API key (for pre-run estimates). */
export function currentModel(): { provider: Provider; model: string } {
  const providerRaw = (process.env.USERTESTS_PROVIDER ?? "anthropic").toLowerCase();
  const provider: Provider = providerRaw === "openai" ? "openai" : "anthropic";
  const model =
    process.env.USERTESTS_MODEL ?? (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o");
  return { provider, model };
}

function loadProviderConfig(): ProviderConfig {
  const providerRaw = (process.env.USERTESTS_PROVIDER ?? "anthropic").toLowerCase();
  if (providerRaw !== "anthropic" && providerRaw !== "openai") {
    throw new Error(
      `Invalid USERTESTS_PROVIDER "${providerRaw}". Expected "anthropic" or "openai".`
    );
  }
  const apiKey = process.env.USERTESTS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "USERTESTS_API_KEY is not set. Export it (or add it to .env) before running the council."
    );
  }
  const { model } = currentModel();
  const baseUrl = process.env.USERTESTS_BASE_URL || undefined;
  return { provider: providerRaw, model, apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// Run-wide budget + timeout configuration (set once by the CLI per run).
// ---------------------------------------------------------------------------

interface RunLimits {
  maxCalls: number;
  maxCostUsd: number | null;
  timeoutSeconds: number;
}

let limits: RunLimits = { maxCalls: 150, maxCostUsd: null, timeoutSeconds: 120 };
let callsMade = 0;
let costAccumulated = 0;

export function configureLLM(opts: Partial<RunLimits>): void {
  limits = { ...limits, ...opts };
  callsMade = 0;
  costAccumulated = 0;
}

export function budgetStatus(): { callsMade: number; maxCalls: number; costUsd: number; maxCostUsd: number | null } {
  return { callsMade, maxCalls: limits.maxCalls, costUsd: costAccumulated, maxCostUsd: limits.maxCostUsd };
}

/** Checked BEFORE every attempt: the last successful call's result is always kept. */
function checkBudget(): void {
  if (callsMade >= limits.maxCalls) {
    throw new BudgetExceededError(
      `LLM call cap reached (${limits.maxCalls} calls this run). Stopping to protect your wallet.`
    );
  }
  if (limits.maxCostUsd !== null && costAccumulated >= limits.maxCostUsd) {
    throw new BudgetExceededError(
      `LLM cost cap reached ($${costAccumulated.toFixed(4)} of $${limits.maxCostUsd.toFixed(2)} this run).`
    );
  }
}

// ---------------------------------------------------------------------------
// Retry policy: 3 attempts, exponential backoff with jitter, Retry-After aware.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

/** Transient = network flakes, timeouts, 429s, 5xx. 4xx auth/validation errors are terminal. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|overloaded|timed?\s*out|abort/i.test(
    msg
  );
}

/** Milliseconds to wait after a 429, if the server told us (Retry-After header). */
function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  let value: string | null = null;
  if (headers && typeof (headers as Headers).get === "function") {
    value = (headers as Headers).get("retry-after");
  } else if (headers && typeof headers === "object") {
    value = (headers as Record<string, string>)["retry-after"] ?? null;
  }
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function backoffMs(attempt: number, err: unknown): number {
  const fromServer = retryAfterMs(err);
  if (fromServer !== null) return Math.min(fromServer, 30_000);
  const base = 1000 * Math.pow(4, attempt - 1); // 1s, 4s
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(100, base + jitter);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface RawLLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callAnthropic(cfg: ProviderConfig, req: LLMRequest): Promise<RawLLMResult> {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: limits.timeoutSeconds * 1000,
    maxRetries: 0, // our retry loop below owns retry policy (and the budget counts every call)
  });
  const content: Anthropic.MessageParam["content"] = [
    ...(req.images ?? []).map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: img.toString("base64"),
      },
    })),
    { type: "text" as const, text: req.user },
  ];
  const res = await client.messages.create({
    model: cfg.model,
    max_tokens: 4096,
    system: req.system,
    messages: [{ role: "user", content }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) throw new Error("LLM returned an empty response.");
  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}

/** OpenAI-compatible path via plain fetch — avoids shipping a second SDK. */
async function callOpenAI(cfg: ProviderConfig, req: LLMRequest): Promise<RawLLMResult> {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const userContent =
    req.images && req.images.length > 0
      ? [
          { type: "text", text: req.user },
          ...req.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${img.toString("base64")}` },
          })),
        ]
      : req.user;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutSeconds * 1000);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: userContent },
        ],
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`LLM request timed out after ${limits.timeoutSeconds}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`OpenAI-compatible API ${res.status}: ${body.slice(0, 300)}`);
    (err as { status?: number }).status = res.status;
    (err as { headers?: Headers }).headers = res.headers;
    throw err;
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM returned an empty response.");
  return {
    text,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Single entry point for all LLM traffic.
// ---------------------------------------------------------------------------

export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  const cfg = loadProviderConfig();
  const invoke = () =>
    cfg.provider === "anthropic" ? callAnthropic(cfg, req) : callOpenAI(cfg, req);

  let lastError: unknown;
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    checkBudget(); // throws BudgetExceededError — never retried
    callsMade += 1;
    const start = Date.now();
    try {
      const raw = await invoke();
      const durationMs = Date.now() - start;
      const costUsd = estimateCostUsd(cfg.model, raw.inputTokens, raw.outputTokens);
      if (costUsd !== null) costAccumulated += costUsd;
      return { ...raw, provider: cfg.provider, model: cfg.model, costUsd, durationMs };
    } catch (e) {
      lastError = e;
      if (!isTransient(e) || attempt === MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, e));
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  const tried = Math.min(attempt, MAX_ATTEMPTS);
  // Error taxonomy: every LLM failure names its category and a suggested fix.
  let hint = "";
  if (/401|authentication|invalid x-api-key|incorrect api key/i.test(msg)) {
    hint = " (LLM auth error — check USERTESTS_API_KEY)";
  } else if (/429|rate.?limit/i.test(msg)) {
    hint = " (LLM rate-limit error — slow down, or lower max_steps_per_agent)";
  } else if (/timed?\s*out|abort/i.test(msg)) {
    hint = " (LLM timeout — raise limits.llm_timeout_seconds or check the endpoint)";
  }
  throw new Error(
    `LLM call failed after ${tried} attempt${tried === 1 ? "" : "s"} (provider=${cfg.provider}, model=${cfg.model}): ${msg}${hint}`
  );
}
