/**
 * logger.ts — structured JSONL event log for a run, written to
 * runs/<ts>/run.log. Additive only: console output is unchanged, and a
 * logging failure must never crash a run.
 *
 * Event types used across the app: phase, persona_start, persona_end,
 * llm_call, finding, error, budget.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";

export class RunLogger {
  private readonly file: string;

  constructor(runDir: string) {
    this.file = path.join(runDir, "run.log");
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
    try {
      appendFileSync(this.file, line + "\n");
    } catch {
      // disk full / perms — logging is best-effort by design
    }
  }
}
