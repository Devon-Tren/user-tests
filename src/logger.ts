/**
 * logger.ts — structured JSONL event log for a run, written to
 * runs/<ts>/run.log. Additive only: console output is unchanged, and a
 * logging failure must never crash a run.
 *
 * Event types used across the app: phase, persona_start, persona_end,
 * llm_call, finding, error, budget.
 *
 * Every event passes through redactSecrets() first. The dashboard can now be
 * handed an API key through a web form, and run.log is the one file that is
 * written on every single event — a key reaching it would be a durable leak in
 * a file users routinely paste into issues.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";

/** Field names whose value is a secret regardless of its shape. */
const SECRET_KEYS = /^(api[_-]?key|apikey|authorization|token|secret|password|usertests_api_key)$/i;

/** Provider key shapes: sk-…, sk-ant-…, and bare 32+ char keys after a known prefix. */
const SECRET_VALUES: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,          // OpenAI / Anthropic
  /\b(Bearer\s+[A-Za-z0-9._~+/-]{16,})/gi,
  /\b(USERTESTS_API_KEY\s*=\s*\S+)/g,
];

const MASK = "[redacted]";

/** Keep the tail so a redacted value is still recognisable as "the key I pasted". */
function maskValue(v: string): string {
  return v.length > 8 ? `${MASK}…${v.slice(-4)}` : MASK;
}

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUES) out = out.replace(re, (m) => maskValue(m));
  return out;
}

/**
 * Deep-scrub an event before it is serialised. Redacts by key name AND by
 * value shape, so a key that arrives in an unexpected field is still caught.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // cycles / absurd nesting — stop rather than hang
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k)
        ? typeof v === "string" ? maskValue(v) : MASK
        : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class RunLogger {
  private readonly file: string;

  constructor(runDir: string) {
    this.file = path.join(runDir, "run.log");
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const safe = redactSecrets(data) as Record<string, unknown>;
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...safe });
    try {
      appendFileSync(this.file, line + "\n");
    } catch {
      // disk full / perms — logging is best-effort by design
    }
  }
}
