/**
 * serve.ts — `usertests serve`: local dashboard for runs.
 *
 * A zero-dependency node:http server bound to 127.0.0.1 that serves the
 * single-file dashboard (dashboard/index.html) and a small JSON API over the
 * run folders. LLM endpoints (explain, chat) reuse the tool's own .env config —
 * the API key never reaches the browser.
 *
 * Endpoints:
 *   GET  /                    → dashboard HTML
 *   GET  /api/runs            → all runs + headline stats (history view)
 *   GET  /api/run?dir=<name>  → one run: findings, persona steps, cost stats
 *   GET  /shots/<dir>/<file>  → screenshot from a run folder
 *   GET  /api/artifacts?dir=  → every file the run wrote, typed and labelled
 *   GET  /api/artifact?dir=&file= → one artifact as text (truncated) + its metadata
 *   GET  /artifact-raw?dir=&file= → one artifact as bytes (view / download)
 *   POST /api/explain         → {dir, code} → grounded explanation (cached per run)
 *   POST /api/chat            → {dir, message, history[], artifacts[]} → RunChat w/ visuals
 *
 * Onboarding routes (see guard() below) turn this from a viewer into an
 * ACTUATOR — it can write .env and launch a run that spends money. Those
 * routes are gated on a per-process token, a same-origin check, and a JSON
 * content-type requirement; the read-only routes above stay open so nothing
 * that worked before needs a token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { callLLM } from "./llm.js";
import { RunLogger } from "./logger.js";
import { RunChat, type ChatTurn } from "./chat.js";
import { ARTIFACT_MIME, artifactIndex, readArtifact, resolveArtifact } from "./artifacts.js";
import { fetchMapdGraph, fetchMapdGaps } from "./coverage.js";
import { loadConfig } from "./config.js";
import { estimateRun } from "./estimate.js";
import { probeLocalServersDetailed } from "./probe.js";
import { applyCredentials, readiness } from "./setup.js";
import { defaultBrowseRoot, listDirs } from "./browse.js";
import { RunSupervisor } from "./launch.js";
import { nativePickerAvailable, pickFolder, PickCancelled } from "./pick.js";
import { detectDevCommand, DevServerSupervisor } from "./devserver.js";

export interface ServeOptions {
  projectRoot: string;
  initialRun?: string | null;
  port: number;
  log: (msg: string) => void;
  /** Shared secret for the mutating routes. Generated per process when omitted. */
  token?: string;
  /** Root the folder browser may not escape. Defaults to the user's home directory. */
  browseRoot?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Guards for the mutating routes
//
// The threat is not a remote attacker — the server is bound to 127.0.0.1. It
// is (a) any other local process, and (b) a page you happen to be visiting
// that POSTs to localhost in the background. Three overlapping checks:
//
//   1. token       — a local process would have to read the served HTML to get it
//   2. same-origin — a foreign page's Origin header gives it away
//   3. JSON type   — forces a CORS preflight, which check 2 then fails
//
// Any one of these is defeatable in isolation; together they are not.
// ---------------------------------------------------------------------------

/** Placeholder in dashboard/index.html, substituted per response. */
const TOKEN_PLACEHOLDER = "__USERTESTS_TOKEN__";

export function mintToken(): string {
  return randomBytes(24).toString("hex");
}

/** Constant-time compare that never throws on length mismatch. */
function tokenMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Only this machine's own dashboard may drive the actuator routes.
 *  Compared against the request's own Host rather than a configured port, so
 *  this holds when the server was started on port 0 (tests) or a custom port. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch() and curl send none
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
    host = u.host;
  } catch {
    return false; // "null" (sandboxed iframe) and other opaque origins land here
  }
  // Same port as the one we are serving on, whatever that turned out to be.
  const self = req.headers.host;
  if (!self) return false;
  return host.split(":")[1] === self.split(":")[1];
}

/**
 * Throws unless the request may mutate state. `json` requires a JSON
 * content-type too — set it false for gated GETs like the folder browser.
 */
function guard(req: IncomingMessage, opts: { token: string; json?: boolean }): void {
  if (!originAllowed(req)) {
    throw new HttpError(403, "cross-origin requests are not allowed");
  }
  if (opts.json !== false) {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }
  }
  const header = req.headers["x-usertests-token"];
  const received = Array.isArray(header) ? header[0] : header;
  if (!tokenMatches(opts.token, received)) {
    throw new HttpError(401, "missing or invalid x-usertests-token");
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      data += c;
      if (data.length > 512 * 1024) {
        settled = true;
        reject(new HttpError(413, "body too large"));
      }
    });
    req.on("end", () => { if (!settled) resolve(data); });
    req.on("error", reject);
  });

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function runsDir(projectRoot: string): string {
  return path.join(projectRoot, "runs");
}

/** Run names are ISO timestamps — validate strictly so paths can't escape runs/. */
function resolveRunDir(projectRoot: string, dir: string | null): string | null {
  if (!dir || !/^[\w][\w.-]*$/.test(dir)) return null;
  const full = path.join(runsDir(projectRoot), dir);
  if (!existsSync(full)) return null;
  try {
    const root = realpathSync(runsDir(projectRoot));
    const real = realpathSync(full);
    if (!real.startsWith(root + path.sep) || !statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface LogEvent {
  ts: string;
  type: string;
  [k: string]: unknown;
}

/** repo_path recorded in phase:start (runs before this field existed → null). */
function repoPathFromLog(log: LogEvent[]): string | null {
  const start = log.find((e) => e.type === "phase" && e["phase"] === "start");
  const p = start?.["repo_path"];
  return typeof p === "string" && existsSync(p) ? p : null;
}

function readLog(runDir: string): LogEvent[] {
  const p = path.join(runDir, "run.log");
  if (!existsSync(p)) return [];
  const out: LogEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // skip corrupt lines — the log is append-only and must never hard-fail reads
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run payload assembly
// ---------------------------------------------------------------------------

interface MergedFile {
  timestamp?: string;
  target?: string;
  partial?: { persona: string; reason: string }[];
  findings?: unknown[];
}

/** Best-effort finding list for runs predating findings-merged.json. */
function parseReportFallback(report: string): Record<string, unknown>[] {
  const findings: Record<string, unknown>[] = [];
  let section = "";
  for (const line of report.split("\n")) {
    const sec = line.match(/^##\s+(Critical|Major|Minor)/);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const h = line.match(/^###\s+([CMm]-\d+):\s+(.+)$/);
    if (h && section) {
      findings.push({ code: h[1], section: "main", severity: section, title: h[2] });
      continue;
    }
    // "- **Found by:** chaos-hunter | **Repro:** ..." — attribute to the most recent finding
    const fb = line.match(/\*\*Found by:\*\*\s*([a-z0-9-]+)/i);
    if (fb && findings.length) {
      const last = findings[findings.length - 1]!;
      const arr = (last["found_by"] as string[] | undefined) ?? [];
      arr.push(fb[1]!);
      last["found_by"] = arr;
    }
  }
  return findings;
}

function runPayload(
  projectRoot: string,
  runDir: string,
  opts: { includePersonas?: boolean } = {}
): Record<string, unknown> | null {
  if (!existsSync(path.join(runDir, "REPORT.md"))) return null;
  const name = path.basename(runDir);
  const log = readLog(runDir);

  // Stats from run.log llm_call events.
  const perPersona: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number; ms: number }> = {};
  let llmCalls = 0;
  let llmAttempts = 0;
  let costUsd = 0;
  let partialFlag = false;
  let newCount: number | null = null;
  for (const e of log) {
    if (e.type === "llm_call") {
      const p = (e["persona"] as string) ?? "unknown";
      const slot = (perPersona[p] ??= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, ms: 0 });
      slot.calls += 1;
      slot.costUsd += (e["cost_usd"] as number) ?? 0;
      slot.inputTokens += (e["input_tokens"] as number) ?? 0;
      slot.outputTokens += (e["output_tokens"] as number) ?? 0;
      slot.ms += (e["duration_ms"] as number) ?? 0;
      llmCalls += 1;
      costUsd += (e["cost_usd"] as number) ?? 0;
    } else if (e.type === "phase" && e["phase"] === "done") {
      partialFlag = e["partial"] === true;
      const attempts = e["llm_calls"];
      if (typeof attempts === "number" && Number.isFinite(attempts)) llmAttempts = attempts;
    } else if (e.type === "diff") {
      newCount = (e["new_findings"] as number) ?? null;
    }
  }
  const started = log.find((e) => e.type === "phase" && e["phase"] === "start")?.ts;
  const ended = log.find((e) => e.type === "phase" && e["phase"] === "done")?.ts;
  const durationMs =
    started && ended ? Math.max(0, Date.parse(ended) - Date.parse(started)) : null;

  const report = readFileSync(path.join(runDir, "REPORT.md"), "utf8");
  const mergedPath = path.join(runDir, "findings-merged.json");
  const merged = (existsSync(mergedPath) ? readJsonFile<MergedFile>(mergedPath) : null)
    ?? { findings: parseReportFallback(report), partial: [] };
  const partial = Array.isArray(merged.partial) ? merged.partial : [];
  partialFlag = partialFlag || partial.length > 0;
  // Partial runs can reference screenshots that were never captured — null them out.
  for (const f of (merged.findings ?? []) as Record<string, unknown>[]) {
    const shot = f["screenshot"] as string | undefined;
    if (shot && !existsSync(path.join(runDir, shot))) f["screenshot"] = null;
  }

  // Per-persona step logs (skipped for the history index — big files, unneeded).
  const personaNames = [...new Set(log.filter((e) => e.type === "persona_start").map((e) => e["persona"] as string))];
  const personaStops = new Map(
    log
      .filter((e) => e.type === "persona_end" && typeof e["persona"] === "string")
      .map((e) => [e["persona"] as string, typeof e["stoppedReason"] === "string" ? e["stoppedReason"] as string : null])
  );
  const personas =
    opts.includePersonas === false
      ? []
      : personaNames.map((p) => {
          const f = path.join(runDir, "findings", `${p}.json`);
          const a = path.join(runDir, "findings", `${p}.actions.json`);
          const raw = existsSync(f) ? readJsonFile<{ steps?: unknown[]; stoppedReason?: string }>(f) : null;
          const actions = existsSync(a) ? readJsonFile<unknown[]>(a) : null;
          return {
            name: p,
            steps: raw?.steps ?? [],
            actions: actions ?? [],
            stoppedReason: raw?.stoppedReason
              ?? personaStops.get(p)
              ?? partial.find((failure) => failure.persona === p)?.reason
              ?? null,
            stats: perPersona[p] ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, ms: 0 },
          };
        });

  return {
    dir: name,
    timestamp: merged.timestamp ?? (log[0]?.ts ?? name),
    target: merged.target ?? (log[0]?.["target"] as string) ?? "",
    partial,
    partialFlag,
    newCount,
    stats: {
      llmCalls,
      llmAttempts: Math.max(llmAttempts, llmCalls),
      retryAttempts: Math.max(0, llmAttempts - llmCalls),
      costUsd,
      durationMs,
      perPersona,
    },
    findings: merged.findings ?? [],
    personas,
    report,
  };
}

function runsIndex(projectRoot: string): Record<string, unknown>[] {
  const dir = runsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "REPORT.md")))
    .map((d) => {
      const payload = runPayload(projectRoot, path.join(dir, d.name), { includePersonas: false });
      if (!payload) return null;
      const findings = (payload["findings"] as Record<string, unknown>[]) ?? [];
      const count = (sev: string) =>
        findings.filter((f) => f["section"] === "main" && f["severity"] === sev).length;
      return {
        dir: d.name,
        timestamp: payload["timestamp"],
        target: payload["target"],
        total: findings.filter((f) => f["section"] === "main").length,
        critical: count("critical"),
        major: count("major"),
        minor: count("minor"),
        goalGaps: findings.filter((f) => f["section"] === "goal-gap").length,
        appendix: findings.filter((f) => f["section"] === "appendix").length,
        costUsd: (payload["stats"] as { costUsd: number }).costUsd,
        llmCalls: (payload["stats"] as { llmCalls: number }).llmCalls,
        llmAttempts: (payload["stats"] as { llmAttempts: number }).llmAttempts,
        partial: payload["partialFlag"],
        newCount: payload["newCount"],
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// ---------------------------------------------------------------------------
// Architecture (mapd) — technical view of the repo under test
// ---------------------------------------------------------------------------

const ARCH_MAX_FILES = 300;
const ARCH_CACHE_VERSION = 2; // bump when the payload shape changes — invalidates stale arch.json

interface ArchFn {
  name?: string;
  params?: number;
  loc?: number;
  async?: boolean;
  exported?: boolean;
  calls?: string[];
}
interface ArchFile {
  file: string;
  lang?: string;
  moduleType?: string;
  loc?: number;
  functions?: ArchFn[];
  imports?: { source?: string; names?: string[] }[];
  exports?: unknown[];
}
interface ArchImportEdge {
  from?: string;
  to?: string;
}
interface ArchWorkflowFull {
  id?: string;
  confidence?: { score?: number };
  files?: string[];
  entry?: { file?: string; kind?: string; detail?: string };
  functionCount?: number;
  exportedSurface?: string[];
}
interface FullGraph {
  repoConfidence?: number;
  stats?: {
    fileCount?: number;
    totalLoc?: number;
    importResolutionRate?: number;
    callResolutionRate?: number;
    totalCalls?: number;
  };
  files?: ArchFile[];
  importEdges?: ArchImportEdge[];
  entryPoints?: { file?: string; kind?: string; detail?: string }[];
  workflows?: ArchWorkflowFull[];
}

/**
 * @param runDir null in FREE mode — mapping a codebase is static analysis and
 *   needs neither a run nor an API key. The run folder is only used to recover
 *   the repo path and to cache the graph; with an explicit repo, neither
 *   requires a run to have happened.
 */
async function architecturePayload(
  runDir: string | null,
  repoOverride: string | null,
  fresh = false,
  freeCacheDir?: string
): Promise<Record<string, unknown>> {
  const log = runDir ? readLog(runDir) : [];
  let repo = repoOverride ?? repoPathFromLog(log);
  if (!repo) {
    throw new Error("this run didn't record its repo (older run) — retry with ?repo=<absolute path>");
  }
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);

  // Cache per run dir — mapd is fast but not free, and the graph doesn't change mid-review.
  // Without a run, cache by repo path so a second visit is instant too.
  const cachePath = runDir
    ? path.join(runDir, "arch.json")
    : path.join(freeCacheDir!, createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16) + ".json");
  if (!fresh && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { repo?: string; v?: number };
      if (cached.repo === repo && cached.v === ARCH_CACHE_VERSION) return cached as Record<string, unknown>;
    } catch {
      // corrupt cache — rebuild
    }
  }

  const graph = (await fetchMapdGraph(repo, { path: "mapd" })) as unknown as FullGraph;
  type GapsShape = {
    gaps?: { file?: string; status?: string }[];
    files?: { file?: string; status?: string }[];
  };
  const gaps: GapsShape = await fetchMapdGaps(repo, { path: "mapd" }).catch(() => ({}) as GapsShape);
  // Prefer the full per-file list: it distinguishes "tested" from "not
  // assessed". Fall back to the gaps-only list for older mapd builds, where
  // silence genuinely means unknown rather than covered.
  const testStatus = new Map<string, string>(
    (gaps.files ?? []).filter((f) => f.file).map((f) => [f.file as string, f.status ?? "unknown"])
  );
  for (const g of gaps.gaps ?? []) if (g.file && !testStatus.has(g.file)) testStatus.set(g.file, g.status ?? "unknown");

  const allFiles = graph.files ?? [];
  const entryKinds = new Map((graph.entryPoints ?? []).map((e) => [e.file, e.kind ?? "entry"]));
  const wfOf = new Map<string, number[]>();
  (graph.workflows ?? []).forEach((w, i) => {
    for (const f of w.files ?? []) {
      const arr = wfOf.get(f) ?? [];
      arr.push(i);
      wfOf.set(f, arr);
    }
  });
  // Rank: workflow files first (entries on top), then by size — cap keeps big repos sane.
  const scored = allFiles.map((f, i) => ({
    i,
    score: (wfOf.has(f.file) ? 1e9 : 0) + (entryKinds.has(f.file) ? 1e8 : 0) + (f.loc ?? 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const kept = scored.slice(0, ARCH_MAX_FILES).map((s) => s.i).sort((a, b) => a - b);

  const workflows = (graph.workflows ?? []).map((w) => ({
    id: String(w.id).split(":").pop() ?? String(w.id), // wf:npm-script:scripts/x.mjs → x.mjs
    confidence: w.confidence?.score ?? 0,
    files: (w.files ?? []).length,
    fileList: (w.files ?? []).slice(0, 8),
    entry: w.entry ? `${w.entry.file}${w.entry.detail ? ` (${w.entry.detail})` : ""}` : null,
    functionCount: w.functionCount ?? 0,
    exportedSurface: (w.exportedSurface ?? []).slice(0, 8),
  }));
  const isCheckScript = (file: string) => /^(check|smoke|test|verify)[_.-]/i.test(path.basename(file));
  const checkPaths = new Set(allFiles.filter((f) => isCheckScript(f.file)).map((f) => f.file));
  const groupChecks = checkPaths.size >= 3;
  const nodes = kept
    .map((fileIdx) => {
      const f = allFiles[fileIdx]!;
      if (groupChecks && checkPaths.has(f.file)) return null; // merged into the grouped node below
      const fns = [...(f.functions ?? [])]
        .sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0))
        .slice(0, 12)
        .map((fn) => ({
          name: fn.name,
          params: fn.params ?? 0,
          loc: fn.loc ?? 0,
          async: fn.async ?? false,
          exported: fn.exported ?? false,
          calls: (fn.calls ?? []).slice(0, 6),
        }));
      return {
        path: f.file,
        name: path.basename(f.file),
        dir: path.dirname(f.file),
        loc: f.loc ?? 0,
        lang: f.lang ?? null,
        moduleType: f.moduleType ?? null,
        fns,
        imports: (f.imports ?? []).slice(0, 10).map((i) => i.source ?? String(i)),
        exports: (f.exports ?? []).slice(0, 12).map((e) => (typeof e === "string" ? e : String((e as { name?: string }).name ?? e))),
        entry: entryKinds.get(f.file) ?? null,
        wfs: wfOf.get(f.file) ?? [],
        // NOT "tested-real". mapd's gap report only lists files it found a gap
        // in; silence means "not assessed", not "covered". Defaulting to
        // tested-real turned 2 reported gaps into a claim that 42 of 44 files
        // had real tests, when 10 of them have no test importing them at all.
        test: testStatus.get(f.file) ?? "unknown",
      };
    })
    .filter((n) => n !== null);
  if (groupChecks) {
    nodes.push({
      path: "(check-scripts)",
      name: `${checkPaths.size} check/smoke scripts`,
      dir: "scripts",
      loc: allFiles.filter((f) => checkPaths.has(f.file)).reduce((a, f) => a + (f.loc ?? 0), 0),
      fns: [],
      exports: [],
      entry: "npm-script",
      wfs: [],
      test: "tested-nameonly",
      grouped: true,
      members: [...checkPaths].sort(),
    } as unknown as (typeof nodes)[number]);
  }
  const indexOf2 = new Map(nodes.map((n, seq) => [n.path, seq]));
  const edges = (graph.importEdges ?? [])
    .filter((e) => e.from !== undefined && e.to !== undefined && !checkPaths.has(e.from!) && !checkPaths.has(e.to!))
    .map((e) => [indexOf2.get(e.from!)!, indexOf2.get(e.to!)!])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);

  const payload = {
    v: ARCH_CACHE_VERSION,
    repo,
    generatedAt: new Date().toISOString(),
    stats: {
      fileCount: allFiles.length,
      shown: nodes.length,
      truncated: allFiles.length > nodes.length,
      totalLoc: graph.stats?.totalLoc ?? 0,
      importResolutionRate: graph.stats?.importResolutionRate ?? null,
      callResolutionRate: graph.stats?.callResolutionRate ?? null,
      totalCalls: graph.stats?.totalCalls ?? 0,
      repoConfidence: graph.repoConfidence ?? null,
    },
    workflows,
    nodes,
    edges,
  };
  try {
    writeFileSync(cachePath, JSON.stringify(payload));
  } catch {
    // cache is optional
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Chat grounding — compact code map so the analyst can answer architecture /
// coverage questions, not just findings questions
// ---------------------------------------------------------------------------

const CODE_MAP_MAX_CHARS = 14000;

/**
 * Turn the (cached) mapd payload into a compact text section for RunChat.
 * Fails open: no repo recorded, mapd missing, huge repo → null section.
 * As a side effect this pre-warms arch.json for the Architecture tab.
 */
async function chatCodeContext(runDir: string): Promise<string | null> {
  try {
    const arch = (await architecturePayload(runDir, null, false)) as {
      repo?: string;
      stats?: Record<string, unknown>;
      workflows?: { id?: string; files?: number; confidence?: number; entry?: string | null; functionCount?: number }[];
      nodes?: {
        path: string; loc?: number; entry?: string | null; test?: string;
        lang?: string | null; moduleType?: string | null;
        imports?: string[]; exports?: string[];
        fns?: { name?: string; params?: number; loc?: number; async?: boolean; exported?: boolean; calls?: string[] }[];
      }[];
    };
    const st = arch.stats ?? {};
    const pct = (x: unknown) => (typeof x === "number" ? Math.round(x * 100) + "%" : "n/a");
    const lines: string[] = [
      `repo: ${arch.repo}`,
      `stats: ${st["shown"]}/${st["fileCount"]} files mapped, ${st["totalLoc"]} LOC, ` +
        `import resolution ${pct(st["importResolutionRate"])}, call resolution ${pct(st["callResolutionRate"])}, ` +
        `${st["totalCalls"] ?? 0} function calls traced`,
    ];

    const nodes = arch.nodes ?? [];
    const entries = nodes.filter((n) => n.entry);
    if (entries.length) {
      lines.push("", "entry points:");
      for (const n of entries.slice(0, 10)) lines.push(`- ${n.path} (${n.entry})`);
    }

    const wfs = arch.workflows ?? [];
    if (wfs.length) {
      lines.push("", "workflows (chains of files used together, from static analysis):");
      for (const w of wfs.slice(0, 12)) {
        lines.push(
          `- ${w.id}: ${w.files ?? 0} files, confidence ${(w.confidence ?? 0).toFixed(2)}, ` +
            `${w.functionCount ?? 0} functions${w.entry ? `, entry ${w.entry}` : ""}`
        );
      }
    }

    const weak = nodes.filter((n) => n.test && n.test !== "tested-real");
    if (weak.length) {
      lines.push("", `files with NO real automated tests (${weak.length} shown):`);
      for (const n of weak.slice(0, 25)) lines.push(`- ${n.path} [${n.test}]`);
    }

    lines.push("", "file-by-file detail (top functions, what they call, imports):");
    // entries and weakly-tested files first — they're what QA questions ask about
    const ranked = [...nodes].sort((a, b) => {
      const rank = (x: { entry?: string | null; test?: string; loc?: number }): number =>
        x.entry ? 0 : x.test && x.test !== "tested-real" ? 1 : 2;
      return rank(a) - rank(b) || (b.loc ?? 0) - (a.loc ?? 0);
    });
    for (const n of ranked) {
      const head = `## ${n.path} — ${n.loc ?? 0} loc, lang ${n.lang ?? "?"}${n.moduleType ? `, ${n.moduleType}` : ""}, tests: ${n.test ?? "unknown"}${n.entry ? `, ENTRY (${n.entry})` : ""}`;
      const body: string[] = [];
      if (n.imports?.length) body.push(`  imports: ${n.imports.join(", ")}`);
      if (n.exports?.length) body.push(`  exports: ${n.exports.join(", ")}`);
      for (const fn of (n.fns ?? []).slice(0, 8)) {
        const flags = `${fn.async ? "async " : ""}${fn.exported ? "exported " : ""}`.trim();
        const calls = fn.calls?.length ? ` → calls: ${fn.calls.join(", ")}` : "";
        body.push(`  fn ${fn.name ?? "(anon)"}(${fn.params ?? 0} params, ${fn.loc ?? 0} loc${flags ? ", " + flags : ""})${calls}`);
      }
      const block = [head, ...body].join("\n");
      if (lines.join("\n").length + block.length > CODE_MAP_MAX_CHARS) {
        lines.push("… (code map truncated — Architecture tab has the full graph)");
        break;
      }
      lines.push(block);
    }
    return lines.join("\n");
  } catch {
    return null; // no repo recorded / mapd unavailable — chat works without it
  }
}

// ---------------------------------------------------------------------------
// LLM endpoints
// ---------------------------------------------------------------------------

const EXPLAIN_SYSTEM = `You are a senior engineer explaining a user-testing finding to the developer whose app was tested.

Rules:
- Explain the finding in plain English: what the user was trying to do, what broke, why it matters.
- Give the most likely root cause given the evidence — mark speculation clearly.
- Suggest a concrete fix direction (file/area to look at, what to check first).
- Ground everything in the provided finding + step logs. Be concise; markdown is fine.`;

const PROJECT_SYSTEM = `You are a technical analyst writing a concise "project brief" for an app that was just user-tested by AI personas. Ground EVERYTHING in the provided material — never invent features, files, or flows. Plain language, no jargon walls. Output STRICT JSON only (no fences, no prose around it):
{"tagline": string — max 12 words, what the product does for a user,
 "whatItIs": string — 2-3 sentences a new teammate could read to understand the product,
 "howItWorks": string — 2-3 sentences on the architecture/tech, referencing real entry points and modules,
 "userFlows": string[] — 3-5 key user flows as "Name — one line", derived from workflows/findings/repro steps,
 "tech": string[] — 3-6 short labels (e.g. "Node.js", "WebRTC", "vanilla JS"),
 "risks": string[] — 2-4 most important current risks, drawn from the highest-severity findings}`;

export type ProjectDigest = {
  tagline?: string;
  whatItIs?: string;
  howItWorks?: string;
  userFlows?: string[];
  tech?: string[];
  risks?: string[];
};

/** One LLM call that turns the run's artifacts into a human project brief. Cached per run+repo; null on any failure. */
async function projectDigest(projectRoot: string, runDir: string, repoOverride: string | null, fresh = false): Promise<ProjectDigest | null> {
  try {
    let repo: string | null = repoOverride;
    const cachePath = path.join(runDir, "project.json");
    if (!fresh && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { repo?: string; digest?: ProjectDigest };
        if (cached.digest && (!cached.repo || !repo || cached.repo === repo)) return cached.digest;
      } catch { /* corrupt cache — rebuild */ }
    }
    if (!repo) repo = repoPathFromLog(readLog(runDir));

    const payload = runPayload(projectRoot, runDir);
    if (!payload) return null;
    const findings = ((payload["findings"] as Record<string, unknown>[]) ?? [])
      .slice(0, 25)
      .map((f) => ({ code: f["code"], severity: f["severity"], title: f["title"], category: f["category"] }));
    const reportHead = String(payload["report"] ?? "").slice(0, 2600);

    let archSummary: Record<string, unknown> | null = null;
    if (repo && existsSync(repo)) {
      try {
        const arch = (await architecturePayload(runDir, repoOverride, false)) as {
          stats?: Record<string, unknown>;
          nodes?: { path: string; entry: string | null; loc: number }[];
          workflows?: { id: string; files: number; confidence: number }[];
        };
        archSummary = {
          stats: arch.stats,
          entryPoints: (arch.nodes ?? []).filter((n) => n.entry && n.path !== "(check-scripts)").slice(0, 10),
          workflows: (arch.workflows ?? []).slice(0, 8),
        };
      } catch { archSummary = null; }
    }

    const resp = await callLLM({
      system: PROJECT_SYSTEM,
      user: [
        `=== REPORT (head) ===\n${reportHead}`,
        `=== FINDINGS (up to 25) ===\n${JSON.stringify(findings, null, 1)}`,
        archSummary ? `=== STATIC ARCHITECTURE (mapd) ===\n${JSON.stringify(archSummary, null, 1)}` : "=== STATIC ARCHITECTURE ===\n(not available)",
      ].join("\n\n"),
    });
    const raw = resp.text.replace(/^```(json)?\s*|\s*```$/g, "").trim();
    const digest = JSON.parse(raw) as ProjectDigest;
    if (!digest || typeof digest !== "object" || (!digest.whatItIs && !digest.tagline)) return null;
    try {
      writeFileSync(cachePath, JSON.stringify({ repo, digest }, null, 2));
    } catch { /* cache optional */ }
    new RunLogger(runDir).event("project_digest", { cost_usd: resp.costUsd, model: resp.model });
    return digest;
  } catch {
    return null;
  }
}

async function explainFinding(projectRoot: string, runDir: string, code: string): Promise<string> {
  const cachePath = path.join(runDir, "explains.json");
  const cache: Record<string, { text: string; ts: string }> = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { text: string; ts: string }>)
    : {};
  const hit = cache[code];
  if (hit) return hit.text;

  const payload = runPayload(projectRoot, runDir);
  if (!payload) throw new Error("run has no report");
  const finding = ((payload["findings"] as Record<string, unknown>[]) ?? []).find((f) => f["code"] === code);
  if (!finding) throw new Error(`finding ${code} not in this run`);
  const personas = payload["personas"] as { name: string; steps: { step?: number; reasoning?: string; finding?: { title?: string } }[] }[];
  const foundBy = (finding["found_by"] as string[]) ?? [];
  const evidence = personas
    .filter((p) => foundBy.includes(p.name))
    .map((p) => `=== ${p.name} step log (truncated) ===\n` +
      p.steps
        .filter((s) => typeof s.reasoning === "string")
        .map((s) => `step ${s.step}: ${s.reasoning!.slice(0, 400)}`)
        .join("\n"));

  const resp = await callLLM({
    system: EXPLAIN_SYSTEM,
    user: [
      `=== FINDING ${code} ===\n${JSON.stringify(finding, null, 2)}`,
      ...evidence,
    ].join("\n\n"),
  });
  cache[code] = { text: resp.text, ts: new Date().toISOString() };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  new RunLogger(runDir).event("explain", { code, cost_usd: resp.costUsd });
  return resp.text;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createDashboardServer(opts: ServeOptions): Server {
  const { projectRoot, log } = opts;
  const token = opts.token ?? mintToken();
  const dashboardPath = path.join(projectRoot, "dashboard", "index.html");
  // Resolve three through Node, not by guessing the directory layout.
  // "../node_modules/three/..." only exists in a dev checkout: npm HOISTS
  // dependencies to the top-level node_modules, so from an installed package
  // that path is absent and the dashboard refused to boot at all.
  const req = createRequire(import.meta.url);
  // three's "exports" map refuses both `three/package.json` and the raw build
  // files, so neither can be resolved directly. The bare specifier does
  // resolve — walk up from it to the package root and join from there.
  const threeRoot = (() => {
    let dir = path.dirname(req.resolve("three"));
    for (let up = 0; up < 5; up++) {
      if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "build"))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error("could not locate the three package root");
  })();
  const threeModulePath = path.join(threeRoot, "build", "three.module.js");
  const threeCorePath = path.join(threeRoot, "build", "three.core.js");
  const threeAddonsRoot = path.join(threeRoot, "examples", "jsm");
  const visualModulePath = fileURLToPath(new URL("../dashboard/visual-webgl.js", import.meta.url));
  if (!existsSync(dashboardPath)) throw new Error(`dashboard not found at ${dashboardPath}`);
  if (!existsSync(threeModulePath)) throw new Error(`WebGL runtime not found at ${threeModulePath}`);
  if (!existsSync(threeCorePath)) throw new Error(`WebGL core not found at ${threeCorePath}`);
  if (!existsSync(visualModulePath)) throw new Error(`WebGL scene not found at ${visualModulePath}`);

  // One chat session per run dir — bound lazily so a serve restart is cheap.
  const chats = new Map<string, RunChat>();

  // At most one live run. A council run drives a real browser and spends real
  // money; concurrency here would be a footgun, not a feature.
  const supervisor = new RunSupervisor(projectRoot, log);
  const browseRoot = opts.browseRoot ?? defaultBrowseRoot();

  // Folders the user chose in the OS dialog. The native picker IS the consent
  // step — a human physically selected that folder — so these are allowed to
  // sit outside browseRoot, which nothing else may do.
  // The onboarding tour. Optional by design: it lives in docs/ rather than in
  // the npm `files` list, so installs stay small and a missing file simply
  // means the welcome skips its video slide.
  const demoVideo = path.join(projectRoot, "docs", "user-tests-walkthrough.mp4");
  const hasDemo = (): boolean => existsSync(demoVideo);

  // At most one dashboard-started dev server. We spawned it, so we own its
  // lifetime: it dies with this process rather than lingering as an orphan.
  const devServer = new DevServerSupervisor(log);
  const reapDev = () => { if (devServer.running) devServer.stop(); };
  process.once("exit", reapDev);
  process.once("SIGINT", () => { reapDev(); process.exit(0); });
  process.once("SIGTERM", () => { reapDev(); process.exit(0); });

  // Graphs mapped without a run live here, keyed by repo path.
  const freeCacheDir = path.join(projectRoot, ".cache", "arch");

  const pickedPaths = new Set<string>();
  const repoAllowed = (p: string): boolean => {
    if (pickedPaths.has(path.resolve(p))) return true;
    try {
      listDirs(browseRoot, p);
      return true;
    } catch {
      return false;
    }
  };

  /** Config the CLI would pick for this repo: project-local wins over the package default. */
  const configFor = (repoPath: string): string => {
    const local = path.join(repoPath, "council.config.yaml");
    return existsSync(local) ? local : path.join(projectRoot, "council.config.yaml");
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = url.pathname;

      if (route === "/" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        });
        // The token is handed to the page here rather than via an endpoint:
        // anything that can read it could already read the page.
        res.end(readFileSync(dashboardPath, "utf8").split(TOKEN_PLACEHOLDER).join(token));
        return;
      }

      if (route === "/vendor/three.module.js" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        res.end(readFileSync(threeModulePath));
        return;
      }

      if (route === "/vendor/three.core.js" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        res.end(readFileSync(threeCorePath));
        return;
      }

      // Post-processing addons (EffectComposer / UnrealBloomPass / …) are
      // served from three/examples/jsm behind an import-map prefix.
      const addon = route.match(/^\/vendor\/addons\/(.+\.js)$/);
      if (addon && req.method === "GET") {
        const rel = addon[1] ?? "";
        if (rel.includes("..")) return json(res, 404, { error: "not found" });
        const file = path.join(threeAddonsRoot, rel);
        if (!file.startsWith(threeAddonsRoot + path.sep) || !existsSync(file)) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        res.end(readFileSync(file));
        return;
      }

      if (route === "/visual-webgl.js" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(readFileSync(visualModulePath));
        return;
      }

      if (route === "/api/runs" && req.method === "GET") {
        json(res, 200, { runs: runsIndex(projectRoot), initialRun: opts.initialRun ?? null });
        return;
      }

      if (route === "/api/run" && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, url.searchParams.get("dir"));
        if (!runDir) return json(res, 400, { error: "unknown run dir" });
        const payload = runPayload(projectRoot, runDir);
        return payload ? json(res, 200, payload) : json(res, 404, { error: "run has no report yet" });
      }

      if (route === "/api/architecture" && req.method === "GET") {
        const repoOverride = url.searchParams.get("repo");
        const dirParam = url.searchParams.get("dir");
        const runDir = resolveRunDir(projectRoot, dirParam);
        // FREE mode: ?repo= alone, with no run and no API key. Everything here
        // is mapd static analysis — it costs nothing and spends no tokens.
        if (!runDir && !repoOverride) return json(res, 400, { error: "unknown run dir" });
        if (!runDir && repoOverride && !repoAllowed(repoOverride)) {
          return json(res, 400, { error: "repo is outside the browsable root" });
        }
        const fresh = url.searchParams.get("fresh") === "1";
        try {
          if (!runDir) mkdirSync(freeCacheDir, { recursive: true });
          return json(res, 200, await architecturePayload(runDir, repoOverride, fresh, freeCacheDir));
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      const shot = route.match(/^\/shots\/([\w][\w.-]*)\/([\w.-]+\.(?:png|jpg|jpeg|webp))$/);
      if (shot && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, shot[1] ?? null);
        const file = runDir ? path.join(runDir, "shots", shot[2]!) : null;
        if (!file || !existsSync(file)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }

      if (route === "/api/artifacts" && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, url.searchParams.get("dir"));
        if (!runDir) return json(res, 400, { error: "unknown run dir" });
        const artifacts = artifactIndex(runDir);
        return json(res, 200, {
          dir: path.basename(runDir),
          artifacts,
          totalBytes: artifacts.reduce((a, x) => a + x.bytes, 0),
        });
      }

      if (route === "/api/artifact" && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, url.searchParams.get("dir"));
        if (!runDir) return json(res, 400, { error: "unknown run dir" });
        const file = url.searchParams.get("file");
        const payload = file ? readArtifact(runDir, file) : null;
        return payload ? json(res, 200, payload) : json(res, 404, { error: `no such artifact: ${file ?? "(none)"}` });
      }

      if (route === "/artifact-raw" && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, url.searchParams.get("dir"));
        const abs = runDir ? resolveArtifact(runDir, url.searchParams.get("file")) : null;
        if (!abs) return json(res, 404, { error: "not found" });
        const type = ARTIFACT_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
        const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
        if (url.searchParams.get("download") === "1") {
          headers["content-disposition"] = `attachment; filename="${path.basename(abs).replace(/"/g, "")}"`;
        }
        res.writeHead(200, headers);
        res.end(readFileSync(abs));
        return;
      }

      if (route === "/api/explain" && req.method === "POST") {
        const body = await readJsonBody<{ dir?: string; code?: string }>(req);
        const runDir = resolveRunDir(projectRoot, body.dir ?? null);
        if (!runDir || !body.code) return json(res, 400, { error: "dir and code required" });
        const text = await explainFinding(projectRoot, runDir, body.code);
        return json(res, 200, { text });
      }

      if (route === "/api/project" && req.method === "GET") {
        const runDir = resolveRunDir(projectRoot, url.searchParams.get("dir"));
        if (!runDir) return json(res, 400, { error: "dir required" });
        const digest = await projectDigest(projectRoot, runDir, url.searchParams.get("repo"), url.searchParams.get("fresh") === "1");
        return json(res, 200, { digest });
      }

      if (route === "/api/chat" && req.method === "POST") {
        const body = await readJsonBody<{
          dir?: string;
          message?: string;
          history?: ChatTurn[];
          context?: string;
          artifacts?: string[];
        }>(req);
        const runDir = resolveRunDir(projectRoot, body.dir ?? null);
        if (!runDir || !body.message) return json(res, 400, { error: "dir and message required" });
        let chat = chats.get(runDir);
        if (!chat) {
          // Ground the session in the static code map too (pre-warms arch.json).
          const codeMap = await chatCodeContext(runDir);
          chat = new RunChat(runDir, new RunLogger(runDir), { allowVisuals: true, codeMap });
          chats.set(runDir, chat);
        }
        const { answer, costUsd, pulled } = await chat.ask(
          body.message,
          body.history ?? [],
          body.context,
          Array.isArray(body.artifacts) ? body.artifacts.slice(0, 4).map(String) : undefined
        );
        return json(res, 200, { answer, costUsd, pulled });
      }

      // ---------------------------------------------------------------
      // Onboarding: readiness, setup, folder browser, launch, live progress.
      // Everything here is free EXCEPT /api/run/start. Page load must never
      // spend a token — that is the whole point of currentModel() and of
      // estimateRun() taking no network path.
      // ---------------------------------------------------------------

      if (route === "/api/setup" && req.method === "GET") {
        return json(res, 200, { ...(await readiness(projectRoot)), demoVideo: hasDemo() });
      }

      // Range-aware so the player can seek; a plain 200 makes the scrubber dead.
      if (route === "/demo.mp4" && (req.method === "GET" || req.method === "HEAD")) {
        if (!hasDemo()) return json(res, 404, { error: "no walkthrough video installed" });
        const total = statSync(demoVideo).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        const base = {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        };
        if (!range) {
          res.writeHead(200, { ...base, "content-length": String(total) });
          if (req.method === "HEAD") return res.end();
          return void createReadStream(demoVideo).pipe(res);
        }
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        if (!Number.isFinite(start) || start > end || start >= total) {
          res.writeHead(416, { ...base, "content-range": `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          ...base,
          "content-range": `bytes ${start}-${end}/${total}`,
          "content-length": String(end - start + 1),
        });
        if (req.method === "HEAD") return res.end();
        return void createReadStream(demoVideo, { start, end }).pipe(res);
      }

      if (route === "/api/setup" && req.method === "POST") {
        guard(req, { token });
        const body = await readJsonBody<{ apiKey?: string; provider?: string; model?: string; baseUrl?: string }>(req);
        try {
          applyCredentials(projectRoot, body);
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        // Re-read rather than echo: the response must never carry the key back.
        log("credentials saved to .env (mode 0600)");
        return json(res, 200, { ...(await readiness(projectRoot)), demoVideo: hasDemo() });
      }

      if (route === "/api/fs/list" && req.method === "GET") {
        // Gated despite being a GET: it discloses the filesystem layout.
        guard(req, { token, json: false });
        try {
          return json(res, 200, {
            ...listDirs(browseRoot, url.searchParams.get("path"), url.searchParams.get("hidden") === "1"),
            nativePicker: nativePickerAvailable(),
          });
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/fs/pick" && req.method === "POST") {
        guard(req, { token });
        if (!nativePickerAvailable()) {
          return json(res, 501, { error: "no native folder dialog on this machine — use the in-page browser" });
        }
        try {
          const picked = await pickFolder("Choose the project you want User-Tests to test");
          pickedPaths.add(path.resolve(picked));
          log(`folder chosen in the native dialog: ${picked}`);
          return json(res, 200, { path: picked, label: picked.replace(process.env["HOME"] ?? "~", "~") });
        } catch (e) {
          if (e instanceof PickCancelled) return json(res, 200, { cancelled: true });
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/dev-command" && req.method === "GET") {
        // Gated: it reads the user's package.json and reports their scripts.
        guard(req, { token, json: false });
        const repo = url.searchParams.get("repo");
        if (!repo || !repoAllowed(repo)) return json(res, 400, { error: "unknown repo" });
        return json(res, 200, { dev: detectDevCommand(repo) });
      }

      if (route === "/api/dev/status" && req.method === "GET") {
        return json(res, 200, { dev: devServer.current() });
      }

      if (route === "/api/dev/start" && req.method === "POST") {
        guard(req, { token });
        const body = await readJsonBody<{ repoPath?: string; script?: string }>(req);
        if (!body.repoPath || !repoAllowed(body.repoPath)) return json(res, 400, { error: "unknown repo" });
        try {
          return json(res, 200, { dev: devServer.start(body.repoPath, body.script) });
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/dev/stop" && req.method === "POST") {
        guard(req, { token });
        return json(res, 200, { dev: devServer.stop() });
      }

      if (route === "/api/probe" && req.method === "GET") {
        return json(res, 200, { servers: await probeLocalServersDetailed() });
      }

      if (route === "/api/estimate" && req.method === "GET") {
        const repo = url.searchParams.get("repo");
        const target = url.searchParams.get("target") ?? "http://localhost:0";
        const stepsRaw = url.searchParams.get("steps");
        try {
          const config = loadConfig(configFor(repo ?? projectRoot), {
            target,
            repo: repo ?? undefined,
            steps: stepsRaw ? Number(stepsRaw) : undefined,
          });
          // A single-persona run is the cheapest way to try the tool at all,
          // so the estimate has to be able to price one.
          const persona = url.searchParams.get("persona");
          const all = config.council.testers.map((t) => t.persona);
          if (persona && !all.includes(persona)) {
            return json(res, 400, { error: `unknown persona "${persona}" (have: ${all.join(", ")})` });
          }
          const testers = persona ? 1 : all.length;
          return json(res, 200, {
            ...estimateRun(config, testers, runsDir(projectRoot)),
            testers: persona ? [persona] : all,
            allTesters: all,
            stepsPerAgent: config.max_steps_per_agent,
            defaultSteps: config.max_steps_per_agent,
          });
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/run/status" && req.method === "GET") {
        return json(res, 200, { run: supervisor.current(), active: supervisor.active });
      }

      if (route === "/api/run/start" && req.method === "POST") {
        guard(req, { token });
        const body = await readJsonBody<{ target?: string; repoPath?: string; steps?: number; persona?: string; confirmCostUsd?: number }>(req);
        if (!body.target || !body.repoPath) return json(res, 400, { error: "target and repoPath are required" });
        if (typeof body.confirmCostUsd !== "number" || !Number.isFinite(body.confirmCostUsd)) {
          // A run cannot start unless a cost was put in front of a human first.
          return json(res, 400, { error: "confirmCostUsd is required — the UI must show an estimate before starting a run" });
        }
        if (supervisor.active) {
          return json(res, 409, { error: "a run is already in flight", run: supervisor.current() });
        }
        // Either inside the browsable root, or a folder the user picked in the
        // OS dialog themselves. Anything else is not something a page may aim at.
        if (!repoAllowed(body.repoPath)) {
          return json(res, 400, { error: "repoPath is outside the browsable root" });
        }
        try {
          const status = await supervisor.start({
            target: body.target,
            repoPath: body.repoPath,
            steps: body.steps,
            persona: body.persona,
          });
          return json(res, 200, { run: status });
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/run/cancel" && req.method === "POST") {
        guard(req, { token });
        try {
          return json(res, 200, { run: supervisor.cancel() });
        } catch (e) {
          return json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (route === "/api/run/events" && req.method === "GET") {
        // SSE. EventSource is covered by the existing connect-src 'self' —
        // no CSP change is needed for the live feed.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        });
        const since = Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0) || 0;
        const send = (e: { seq: number; type: string }) => {
          res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        res.write(`event: status\ndata: ${JSON.stringify({ run: supervisor.current(), active: supervisor.active })}\n\n`);
        for (const e of supervisor.backlog(since)) send(e); // a refresh mid-run re-attaches
        const unsubscribe = supervisor.subscribe(send);
        // Proxies and some browsers drop an idle stream; a comment frame is not an event.
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        const stop = () => {
          clearInterval(keepAlive);
          unsubscribe();
        };
        req.on("close", stop);
        res.on("close", stop);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      json(res, e instanceof HttpError ? e.status : 500, { error: message });
    }
  });

  return server;
}

export function startServer(opts: ServeOptions): Server {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${String(opts.port)}`);
  }
  const server = createDashboardServer(opts);
  server.listen(opts.port, "127.0.0.1", () => {
    opts.log(`dashboard → http://localhost:${opts.port}  (127.0.0.1 only; Ctrl+C to stop)`);
  });
  return server;
}
