/**
 * config.ts — loads and validates council.config.yaml, with CLI flag overrides.
 * Fails fast with human-readable errors; a misconfigured council should never
 * spend a single LLM token.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Severity = "critical" | "major" | "minor";

export interface TesterConfig {
  persona: string;
  harshness: number;
}

export interface ChairConfig {
  verify_repro: boolean;
  min_severity_to_verify: Severity;
  max_findings_per_run: number;
  /** Drop replay-confirmed findings whose claim contradicts the replay snapshot. Default true. */
  false_positive_pruning: boolean;
}

export interface LimitsConfig {
  /** Hard cap on LLM calls per run (counting retries). */
  max_llm_calls: number;
  /** Hard cost budget per run in USD; null = no cost cap. */
  max_cost_usd: number | null;
  /** Total wall-clock limit for the run. */
  max_run_minutes: number;
  /** Timeout for a single LLM call. */
  llm_timeout_seconds: number;
  /** Keep only the newest N run folders; older ones are pruned after a run. */
  keep_runs: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  max_llm_calls: 250, // real apps (30 steps × 4 personas + sweeps/retries) exceed 150
  max_cost_usd: null,
  max_run_minutes: 45,
  llm_timeout_seconds: 120,
  keep_runs: 20,
};

export interface MapdConfig {
  /** Build a coverage briefing (routes/entry points + untested files) via the mapd CLI. */
  enabled: boolean;
  /** mapd executable or absolute path (default: "mapd" on PATH). */
  path: string;
  /** Char budget for the briefing injected into every persona prompt. */
  max_chars: number;
}

export const DEFAULT_MAPD: MapdConfig = { enabled: true, path: "mapd", max_chars: 4_000 };

export interface CouncilConfig {
  target: string;
  repo_path: string;
  max_steps_per_agent: number;
  viewport: { width: number; height: number };
  /** true = full-page screenshots everywhere; false (default) = viewport only. */
  full_page_screenshots: boolean;
  limits: LimitsConfig;
  mapd: MapdConfig;
  council: {
    testers: TesterConfig[];
    chair: ChairConfig;
  };
}

const SEVERITIES: Severity[] = ["critical", "major", "minor"];

function fail(msg: string): never {
  throw new Error(`Config error: ${msg}`);
}

export function loadConfig(
  configPath: string,
  overrides: { target?: string; repo?: string; steps?: number }
): CouncilConfig {
  if (!existsSync(configPath)) {
    fail(`config file not found at "${configPath}". Pass --config <path> or run from the project root.`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    fail(`could not parse ${configPath} as YAML: ${e instanceof Error ? e.message : e}`);
  }
  const c = raw as Record<string, unknown>;

  const target = (overrides.target ?? c["target"]) as string | undefined;
  if (!target || typeof target !== "string") fail('"target" is required (config file or --target).');
  try {
    new URL(target);
  } catch {
    fail(`"target" must be a valid URL, got "${target}".`);
  }

  const repoPath = (overrides.repo ?? c["repo_path"] ?? ".") as string;
  if (!existsSync(path.resolve(repoPath))) {
    fail(`repo_path "${repoPath}" does not exist.`);
  }

  const maxSteps = (overrides.steps ?? c["max_steps_per_agent"]) as number | undefined;
  if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
    fail('"max_steps_per_agent" must be an integer between 1 and 200.');
  }

  const viewport = c["viewport"] as { width?: unknown; height?: unknown } | undefined;
  if (
    !viewport ||
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number" ||
    viewport.width < 320 ||
    viewport.height < 320
  ) {
    fail('"viewport" must be { width: >=320, height: >=320 }.');
  }

  const fullPageShots = c["full_page_screenshots"] ?? false;
  if (typeof fullPageShots !== "boolean") {
    fail('"full_page_screenshots" must be true or false (or omitted).');
  }

  const council = c["council"] as Record<string, unknown> | undefined;
  if (!council) fail('"council" section is missing.');
  const testers = council["testers"] as TesterConfig[] | undefined;
  if (!Array.isArray(testers) || testers.length === 0) {
    fail('"council.testers" must be a non-empty list.');
  }
  for (const t of testers) {
    if (!t || typeof t.persona !== "string" || t.persona.trim() === "") {
      fail("every tester needs a non-empty \"persona\" name (must match a file in personas/).");
    }
    if (typeof t.harshness !== "number" || t.harshness < 1 || t.harshness > 10) {
      fail(`tester "${t.persona}" has invalid harshness (must be 1–10).`);
    }
  }

  const chair = council["chair"] as Partial<ChairConfig> | undefined;
  if (!chair) fail('"council.chair" section is missing.');
  if (typeof chair.verify_repro !== "boolean") fail('"chair.verify_repro" must be true or false.');
  if (!SEVERITIES.includes(chair.min_severity_to_verify as Severity)) {
    fail(`"chair.min_severity_to_verify" must be one of ${SEVERITIES.join(", ")}.`);
  }
  if (
    typeof chair.max_findings_per_run !== "number" ||
    chair.max_findings_per_run < 1
  ) {
    fail('"chair.max_findings_per_run" must be a positive integer.');
  }

  if (
    chair.false_positive_pruning !== undefined &&
    typeof chair.false_positive_pruning !== "boolean"
  ) {
    fail('"chair.false_positive_pruning" must be true or false (or omitted — default true).');
  }

  const limitsRaw = (c["limits"] ?? {}) as Record<string, unknown>;
  const limits: LimitsConfig = { ...DEFAULT_LIMITS };
  if (limitsRaw["max_llm_calls"] !== undefined) {
    const v = limitsRaw["max_llm_calls"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      fail('"limits.max_llm_calls" must be a positive integer.');
    }
    limits.max_llm_calls = v;
  }
  if (limitsRaw["max_cost_usd"] !== undefined && limitsRaw["max_cost_usd"] !== null) {
    const v = limitsRaw["max_cost_usd"];
    if (typeof v !== "number" || v <= 0) {
      fail('"limits.max_cost_usd" must be a positive number (or omitted for no cap).');
    }
    limits.max_cost_usd = v;
  }
  if (limitsRaw["max_run_minutes"] !== undefined) {
    const v = limitsRaw["max_run_minutes"];
    if (typeof v !== "number" || v < 1) {
      fail('"limits.max_run_minutes" must be a positive number.');
    }
    limits.max_run_minutes = v;
  }
  if (limitsRaw["llm_timeout_seconds"] !== undefined) {
    const v = limitsRaw["llm_timeout_seconds"];
    if (typeof v !== "number" || v < 5) {
      fail('"limits.llm_timeout_seconds" must be a number >= 5.');
    }
    limits.llm_timeout_seconds = v;
  }
  if (limitsRaw["keep_runs"] !== undefined) {
    const v = limitsRaw["keep_runs"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      fail('"limits.keep_runs" must be a positive integer.');
    }
    limits.keep_runs = v;
  }

  const mapdRaw = (c["mapd"] ?? {}) as Record<string, unknown>;
  const mapd: MapdConfig = { ...DEFAULT_MAPD };
  if (mapdRaw["enabled"] !== undefined) {
    if (typeof mapdRaw["enabled"] !== "boolean") {
      fail('"mapd.enabled" must be true or false (or omitted — default true).');
    }
    mapd.enabled = mapdRaw["enabled"];
  }
  if (mapdRaw["path"] !== undefined) {
    if (typeof mapdRaw["path"] !== "string" || mapdRaw["path"].trim() === "") {
      fail('"mapd.path" must be a non-empty string (mapd executable or absolute path).');
    }
    mapd.path = mapdRaw["path"];
  }
  if (mapdRaw["max_chars"] !== undefined) {
    const v = mapdRaw["max_chars"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 500) {
      fail('"mapd.max_chars" must be an integer >= 500.');
    }
    mapd.max_chars = v;
  }

  return {
    target,
    repo_path: path.resolve(repoPath),
    max_steps_per_agent: maxSteps,
    viewport: { width: viewport.width as number, height: viewport.height as number },
    full_page_screenshots: fullPageShots,
    limits,
    mapd,
    council: {
      testers,
      chair: {
        verify_repro: chair.verify_repro,
        min_severity_to_verify: chair.min_severity_to_verify as Severity,
        max_findings_per_run: chair.max_findings_per_run,
        false_positive_pruning: chair.false_positive_pruning ?? true,
      },
    },
  };
}

/** Persona markdown files live in <projectRoot>/personas/<name>.md */
export function personaPath(projectRoot: string, persona: string): string {
  if (!/^[a-z0-9-]+$/.test(persona)) {
    fail(`persona name "${persona}" is invalid (lowercase letters, digits, hyphens only).`);
  }
  const p = path.join(projectRoot, "personas", `${persona}.md`);
  if (!existsSync(p)) {
    fail(`persona file not found: ${p}. Create it or remove "${persona}" from council.testers.`);
  }
  return p;
}
