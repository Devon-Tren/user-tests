/**
 * setup.ts — first-run readiness, and the one place that writes credentials.
 *
 * The dashboard's Start screen asks this module "can a run happen right now?"
 * and gets back a list of checks, each either passing or carrying the exact
 * fix. Answering costs nothing: currentModel() resolves the provider/model
 * from env alone, and every other check is a filesystem or version test. No
 * LLM call happens unless the user explicitly presses "Test key".
 */
import { accessSync, constants, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { currentModel } from "./llm.js";

const execFileP = promisify(execFile);

/** Env vars this module owns in .env. Anything else in the file is left alone. */
const OWNED_KEYS = ["USERTESTS_API_KEY", "USERTESTS_PROVIDER", "USERTESTS_MODEL", "USERTESTS_BASE_URL"] as const;
export type OwnedKey = (typeof OWNED_KEYS)[number];

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  /** Why it passes, or what is wrong. Shown verbatim. */
  detail: string;
  /** A run cannot start while a blocking check fails. */
  blocking: boolean;
  /** Shell command that fixes it, when a command can. */
  fixCommand?: string;
}

export interface Readiness {
  /** Can the dashboard be used at all? True without an API key — mapping a
   *  codebase is static analysis and costs nothing. */
  ready: boolean;
  /** Can the council actually be RUN? Needs a key and a browser. */
  canRun: boolean;
  /** Why not, in one line, when canRun is false. */
  cannotRunReason: string | null;
  provider: string;
  model: string;
  /** Tail of the configured key, or null. The key itself is never returned. */
  keyHint: string | null;
  checks: Check[];
}

/** `sk-abc…` → `sk-…cd12`. Enough to recognise, useless to steal. */
export function maskKey(key: string): string {
  const tail = key.slice(-4);
  return key.length > 8 ? `sk-…${tail}` : "…set";
}

function nodeVersionCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= 20;
  return {
    id: "node",
    label: "Node ≥ 20",
    ok,
    blocking: true,
    detail: ok ? `Node ${process.versions.node}` : `Node ${process.versions.node} is too old — the council needs 20 or newer.`,
  };
}

function apiKeyCheck(): Check {
  const key = process.env.USERTESTS_API_KEY;
  return {
    id: "apiKey",
    label: "API key",
    ok: Boolean(key),
    // NOT blocking: mapping a codebase is static analysis and costs nothing.
    // A key is only needed to run the council, which is the part that spends.
    blocking: false,
    detail: key
      ? `${maskKey(key)} — writes to .env, never to run.log`
      : "Not set. You can still map any codebase for free — a key is only needed to run the council.",
  };
}

/** Playwright resolves an executable path whether or not the download happened. */
async function chromiumCheck(): Promise<Check> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    const ok = Boolean(exe) && existsSync(exe);
    return {
      id: "chromium",
      label: "Chromium",
      ok,
      blocking: false, // only needed to run the council, not to map a codebase
      detail: ok ? "Installed — the personas drive a real browser." : "Chromium is not downloaded yet (~130 MB, one time).",
      ...(ok ? {} : { fixCommand: "npx playwright install chromium" }),
    };
  } catch (e) {
    return {
      id: "chromium",
      label: "Chromium",
      ok: false,
      blocking: false,
      detail: `Playwright could not resolve a browser: ${e instanceof Error ? e.message : String(e)}`,
      fixCommand: "npx playwright install chromium",
    };
  }
}

function runsWritableCheck(projectRoot: string): Check {
  const dir = path.join(projectRoot, "runs");
  const probe = existsSync(dir) ? dir : projectRoot;
  try {
    accessSync(probe, constants.W_OK);
    return { id: "runs", label: "Run folder", ok: true, blocking: true, detail: `Reports will be written to ${dir}` };
  } catch {
    return {
      id: "runs",
      label: "Run folder",
      ok: false,
      blocking: true,
      detail: `${probe} is not writable — runs have nowhere to go.`,
    };
  }
}

/** mapd is an accelerator, never a blocker — the Architecture/Visual tabs degrade without it. */
async function mapdCheck(mapdPath: string): Promise<Check> {
  try {
    const { stdout } = await execFileP(mapdPath, ["--version"], { timeout: 5_000 });
    return { id: "mapd", label: "mapd (optional)", ok: true, blocking: false, detail: `mapd ${stdout.trim()} — coverage-guided personas enabled.` };
  } catch {
    return {
      id: "mapd",
      label: "mapd (optional)",
      ok: false,
      blocking: false,
      detail: "Not on PATH. Runs work fine; the Architecture and Visual tabs will be empty.",
      fixCommand: "npm install -g mapd",
    };
  }
}

export async function readiness(projectRoot: string, mapdPath = "mapd"): Promise<Readiness> {
  const { provider, model } = currentModel();
  const checks = [
    nodeVersionCheck(),
    apiKeyCheck(),
    await chromiumCheck(),
    runsWritableCheck(projectRoot),
    await mapdCheck(mapdPath),
  ];
  const key = process.env.USERTESTS_API_KEY;
  const failed = (id: string) => !checks.find((c) => c.id === id)?.ok;
  const cannotRunReason =
    failed("node") ? "Node 20 or newer is required"
    : failed("apiKey") ? "an API key is needed to run the council"
    : failed("chromium") ? "Chromium is not installed"
    : failed("runs") ? "the run folder is not writable"
    : null;
  return {
    ready: checks.every((c) => c.ok || !c.blocking),
    canRun: cannotRunReason === null,
    cannotRunReason,
    provider,
    model,
    keyHint: key ? maskKey(key) : null,
    checks,
  };
}

// ---------------------------------------------------------------------------
// .env writing
// ---------------------------------------------------------------------------

/** A value safe to sit on the right-hand side of KEY=… without quoting games. */
function assertCleanValue(key: string, value: string): void {
  if (/[\n\r]/.test(value)) throw new Error(`${key} must not contain newlines`);
  if (value.length > 400) throw new Error(`${key} is implausibly long`);
}

/**
 * Rewrite only the keys we own, preserving every other line — comments,
 * blank lines, unrelated vars, and their original order. A first-run setup
 * form must never clobber a .env the user hand-wrote.
 *
 * Returns the path written. The file is left at mode 0600.
 */
export function writeEnvKeys(projectRoot: string, values: Partial<Record<OwnedKey, string>>): string {
  const file = path.join(projectRoot, ".env");
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) assertCleanValue(k, v);
  }

  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const pending = new Map<string, string>(
    Object.entries(values).filter(([, v]) => v !== undefined) as [string, string][]
  );

  const out = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = m?.[1];
    if (!key || !pending.has(key)) return line; // comments and unrelated vars pass through
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });

  if (pending.size > 0) {
    if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
    for (const [key, value] of pending) out.push(`${key}=${value}`);
  }

  writeFileSync(file, out.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // pre-existing files keep their old mode otherwise
  } catch {
    // Windows and some network mounts don't do POSIX modes — the write still happened.
  }
  return file;
}

/**
 * Persist credentials AND apply them to this process, so the running server
 * picks the key up without a restart. The key is deliberately not returned.
 */
export function applyCredentials(
  projectRoot: string,
  creds: { apiKey?: string; provider?: string; model?: string; baseUrl?: string }
): void {
  const values: Partial<Record<OwnedKey, string>> = {};
  if (creds.apiKey) values.USERTESTS_API_KEY = creds.apiKey.trim();
  if (creds.provider) values.USERTESTS_PROVIDER = creds.provider.trim();
  if (creds.model) values.USERTESTS_MODEL = creds.model.trim();
  if (creds.baseUrl) values.USERTESTS_BASE_URL = creds.baseUrl.trim();
  if (Object.keys(values).length === 0) throw new Error("nothing to save");

  writeEnvKeys(projectRoot, values);
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}
