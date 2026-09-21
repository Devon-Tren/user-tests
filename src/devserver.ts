/**
 * devserver.ts — work out how THIS project starts its dev server.
 *
 * The council tests a live URL, so "your app has to already be running" is the
 * one cliff no UI removes. What a UI can do is stop making the user work out
 * the command: read their package.json, find the script, and hand it over
 * ready to paste.
 *
 * Detection only — nothing here spawns anything. Starting the server on the
 * user's behalf builds on this, but that is a separate, louder decision.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DevCommand {
  /** The literal line to paste into a terminal. */
  command: string;
  /** The package.json script it maps to. */
  script: string;
  /** npm | yarn | pnpm | bun — inferred from the lockfile. */
  manager: string;
  /** Every script that looks like it serves the app, best first. */
  candidates: string[];
  /** True when node_modules is missing — the command will fail without an install first. */
  needsInstall: boolean;
  /** The install command to run first, when needsInstall. */
  installCommand: string;
}

/** Lockfiles are a far better signal than whatever is on PATH. */
function detectManager(repo: string): string {
  if (existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(repo, "bun.lockb"))) return "bun";
  return "npm";
}

/** Scripts that serve an app, in the order a human would try them. */
const PREFERRED = ["dev", "start", "serve", "dev:server", "start:dev", "develop", "preview"];

export function detectDevCommand(repoPath: string): DevCommand | null {
  const pkgPath = path.join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return null;

  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return null; // malformed package.json is the user's problem, not a crash
  }

  const names = Object.keys(scripts);
  const candidates = [
    ...PREFERRED.filter((p) => names.includes(p)),
    // anything else that smells like serving, minus the obvious non-servers
    ...names.filter(
      (n) => !PREFERRED.includes(n) && /^(dev|start|serve)/i.test(n) && !/test|lint|build|typecheck/i.test(n)
    ),
  ];
  if (candidates.length === 0) return null;

  const script = candidates[0]!;
  const manager = detectManager(repoPath);
  // Each manager has its own idiom; print the one a user of that manager
  // would actually type, not a lowest-common-denominator form.
  const command =
    manager === "npm" ? (script === "start" ? "npm start" : `npm run ${script}`)
    : manager === "bun" ? `bun run ${script}`
    : `${manager} ${script}`; // yarn dev / pnpm dev

  return {
    command,
    script,
    manager,
    candidates,
    needsInstall: !existsSync(path.join(repoPath, "node_modules")),
    installCommand: manager === "npm" ? "npm install" : `${manager} install`,
  };
}


// ---------------------------------------------------------------------------
// Starting it
// ---------------------------------------------------------------------------

export type DevState = "idle" | "starting" | "ready" | "failed" | "stopped";

export interface DevStatus {
  state: DevState;
  /** The command that was run, verbatim. */
  command: string | null;
  repoPath: string | null;
  /** Where the app actually came up, once known. */
  url: string | null;
  /** Tail of the child's output — startup failures are usually explained here. */
  lines: string[];
  error: string | null;
  startedAt: string | null;
}

const READY_TIMEOUT_MS = 90_000;
const MAX_LINES = 200;
/** Strip ANSI colour so the dashboard shows text, not escape codes. */
const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");

/** Dev servers announce themselves; these are the usual phrasings. */
const URL_PATTERNS = [
  /(?:Local|local|ready on|listening on|running at|started server on)[^\n]*?(https?:\/\/[^\s,]+)/i,
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/i,
];

function urlFrom(line: string): string | null {
  for (const re of URL_PATTERNS) {
    const m = re.exec(line);
    if (m?.[1]) {
      // 0.0.0.0 is a bind address, not something to point a browser at.
      return m[1].replace(/\/+$/, "").replace("0.0.0.0", "localhost");
    }
  }
  return null;
}

/**
 * Runs the user's OWN dev script, in their OWN repo, on their OWN machine.
 *
 * That is why this is defensible where cloning and running a stranger's repo
 * would not be: the command is read from their package.json, shown to them in
 * full, and only runs after they click. Nothing is inferred or invented.
 *
 * We started it, so we own it — the process group is killed on stop and on
 * server exit, so a dashboard restart never orphans a dev server.
 */
export class DevServerSupervisor {
  private child: ChildProcess | null = null;
  private status: DevStatus = {
    state: "idle", command: null, repoPath: null, url: null, lines: [], error: null, startedAt: null,
  };
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly log: (msg: string) => void) {}

  current(): DevStatus {
    return { ...this.status, lines: [...this.status.lines] };
  }

  get running(): boolean {
    return this.status.state === "starting" || this.status.state === "ready";
  }

  private push(line: string): void {
    this.status.lines.push(line);
    if (this.status.lines.length > MAX_LINES) this.status.lines.shift();
    if (this.status.url) return;
    const found = urlFrom(line);
    if (found) {
      this.status.url = found;
      this.status.state = "ready";
      this.log(`dev server is up at ${found}`);
    }
  }

  /** Start `script` in `repoPath`. Throws if one is already running. */
  start(repoPath: string, script?: string): DevStatus {
    if (this.running) throw new Error("a dev server is already running from this dashboard");
    const detected = detectDevCommand(repoPath);
    if (!detected) throw new Error("no dev or start script found in that project's package.json");
    if (script && !detected.candidates.includes(script)) {
      throw new Error(`"${script}" is not one of this project's scripts (${detected.candidates.join(", ")})`);
    }
    if (detected.needsInstall) {
      throw new Error(`dependencies are not installed — run \`${detected.installCommand}\` first`);
    }

    const chosen = script ?? detected.script;
    const command =
      detected.manager === "npm" ? (chosen === "start" ? "npm start" : `npm run ${chosen}`)
      : detected.manager === "bun" ? `bun run ${chosen}`
      : `${detected.manager} ${chosen}`;

    this.status = {
      state: "starting", command, repoPath, url: null, lines: [], error: null,
      startedAt: new Date().toISOString(),
    };

    // Through a shell, so what runs is exactly what the user was shown.
    const child = spawn(command, {
      cwd: repoPath,
      shell: true,
      detached: true, // own group, so stopping takes the whole tree down
      env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.log(`starting dev server: ${command} (pid ${child.pid})`);

    const relay = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let carry = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        carry += chunk;
        const parts = carry.split("\n");
        carry = parts.pop() ?? "";
        for (const l of parts) {
          const clean = l.replace(ANSI, "").trimEnd();
          if (clean.trim()) this.push(clean);
        }
      });
    };
    relay(child.stdout);
    relay(child.stderr);

    child.on("error", (e) => {
      this.status.state = "failed";
      this.status.error = e.message;
      this.clearTimer();
    });

    child.on("exit", (code, signal) => {
      this.clearTimer();
      if (this.status.state === "stopped") return; // we asked for this
      // A dev server that exits on its own has failed, whatever the code.
      this.status.state = "failed";
      this.status.error =
        this.status.error ?? `the dev server exited early (${signal ?? `code ${code}`}) — see the output above`;
    });

    this.readyTimer = setTimeout(() => {
      if (this.status.state !== "starting") return;
      this.status.state = "failed";
      this.status.error = `no URL after ${READY_TIMEOUT_MS / 1000}s — it may be slow, or may not print its address`;
    }, READY_TIMEOUT_MS);

    return this.current();
  }

  /** SIGTERM the whole group; a dev server usually has children of its own. */
  stop(): DevStatus {
    this.clearTimer();
    this.status.state = "stopped";
    if (!this.child) return this.current();
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
    this.log("dev server stopped");
    this.child = null;
    return this.current();
  }

  private clearTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
