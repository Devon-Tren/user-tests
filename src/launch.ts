/**
 * launch.ts — supervises a council run started from the dashboard.
 *
 * The run is a CHILD PROCESS (`node dist/cli.js run …`), not an in-process
 * call. executeRun is a closure over CLI options, configureLLM's budget state
 * is module-global, and Playwright crashes hard — running it inside the server
 * would mean a failed run can take the dashboard down with it and share a
 * budget counter with the viewer. A child gives isolation, a real kill switch,
 * and byte-identical run.log output, with no refactor of the run path.
 *
 * Progress comes from two sources, because neither alone is enough:
 *   - the child's stdout, which covers config/reachability/estimate — all of
 *     which happen BEFORE the run folder exists
 *   - runs/<ts>/run.log, tailed from a byte offset once that folder appears
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { assertReachable } from "./probe.js";

export interface StartRequest {
  target: string;
  repoPath: string;
  steps?: number;
  persona?: string;
}

/** One line of the live feed. `type` mirrors run.log's event types, plus "log". */
export interface RunEvent {
  seq: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

export interface RunStatus {
  id: string;
  state: "starting" | "running" | "done" | "failed" | "cancelled";
  target: string;
  repoPath: string;
  startedAt: string;
  /** runs/<ts> folder name — null until the child creates it. */
  runDir: string | null;
  exitCode: number | null;
  error: string | null;
}

const POLL_MS = 400;

/**
 * A single live run. The server holds at most one: a council run drives a real
 * browser and spends real money, so concurrency here is a footgun, not a feature.
 */
export class RunSupervisor {
  private child: ChildProcess | null = null;
  private status: RunStatus | null = null;
  private events: RunEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: RunEvent) => void>();
  private tailTimer: NodeJS.Timeout | null = null;
  private tailOffset = 0;
  private tailCarry = "";
  private knownRuns = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    private readonly log: (msg: string) => void
  ) {}

  get active(): boolean {
    return this.status !== null && (this.status.state === "starting" || this.status.state === "running");
  }

  current(): RunStatus | null {
    return this.status;
  }

  /** Backlog for a client that connected late or refreshed mid-run. */
  backlog(since = 0): RunEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: string, data: Record<string, unknown> = {}): void {
    const event: RunEvent = { seq: ++this.seq, ts: new Date().toISOString(), type, ...data };
    this.events.push(event);
    if (this.events.length > 5_000) this.events.splice(0, this.events.length - 5_000);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // one broken SSE connection must not stall the others
      }
    }
  }

  private runsDir(): string {
    return path.join(this.projectRoot, "runs");
  }

  private snapshotRuns(): Set<string> {
    try {
      return new Set(
        readdirSync(this.runsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Validate, then spawn. Everything that can fail cheaply fails here, before
   * a single token is spent — an unreachable target is the single most common
   * first-run mistake and it must cost nothing.
   */
  async start(req: StartRequest): Promise<RunStatus> {
    if (this.active) throw new Error(`a run is already in flight (${this.status?.runDir ?? this.status?.id})`);
    if (!process.env.USERTESTS_API_KEY) throw new Error("no API key configured — finish setup first");
    if (!existsSync(req.repoPath) || !statSync(req.repoPath).isDirectory()) {
      throw new Error(`repo path is not a folder: ${req.repoPath}`);
    }
    await assertReachable(req.target);

    this.events = [];
    this.seq = 0;
    this.tailOffset = 0;
    this.tailCarry = "";
    this.knownRuns = this.snapshotRuns();

    const id = `launch-${Date.now()}`;
    this.status = {
      id,
      state: "starting",
      target: req.target,
      repoPath: req.repoPath,
      startedAt: new Date().toISOString(),
      runDir: null,
      exitCode: null,
      error: null,
    };

    const args = [path.join(this.projectRoot, "dist", "cli.js"), "run", "--target", req.target, "--repo", req.repoPath];
    if (req.steps !== undefined) args.push("--steps", String(req.steps));
    if (req.persona) args.push("--persona", req.persona);

    // cwd = the repo under test, so a project-local council.config.yaml wins,
    // exactly as it would if the user had typed this in their own terminal.
    // The API key rides in env — NEVER argv, which is world-readable via ps.
    const child = spawn(process.execPath, args, {
      cwd: req.repoPath,
      env: { ...process.env },
      detached: true, // own process group, so cancel takes Chromium down too
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.status.state = "running";
    this.log(`run started from the dashboard (pid ${child.pid}) → ${req.target}`);
    this.emit("launch", { target: req.target, repoPath: req.repoPath, steps: req.steps ?? null });

    const relay = (stream: NodeJS.ReadableStream | null, level: "info" | "error") => {
      if (!stream) return;
      let carry = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) this.emit("log", { level, line: line.replace(/^\[usertests\]\s*/, "") });
        }
      });
      stream.on("end", () => {
        if (carry.trim()) this.emit("log", { level, line: carry.trim() });
      });
    };
    relay(child.stdout, "info");
    relay(child.stderr, "error");

    child.on("error", (e) => {
      if (!this.status) return;
      this.status.state = "failed";
      this.status.error = e.message;
      this.emit("launch_end", { state: "failed", error: e.message });
      this.stopTail();
    });

    child.on("exit", (code, signal) => {
      if (!this.status) return;
      const cancelled = this.status.state === "cancelled" || signal === "SIGTERM";
      this.status.exitCode = code;
      this.status.state = cancelled ? "cancelled" : code === 0 ? "done" : "failed";
      if (!cancelled && code !== 0) this.status.error = `run exited with code ${code}`;
      // One last drain: the final run.log lines often land after the exit event.
      void this.tailOnce().finally(() => {
        this.emit("launch_end", {
          state: this.status?.state,
          runDir: this.status?.runDir ?? null,
          exitCode: code,
          error: this.status?.error ?? null,
        });
        this.stopTail();
      });
    });

    this.startTail();
    return this.status;
  }

  /** SIGTERM the whole process group — Playwright's Chromium is a grandchild. */
  cancel(): RunStatus {
    if (!this.child || !this.active || !this.status) throw new Error("no run is in flight");
    this.status.state = "cancelled";
    this.emit("log", { level: "info", line: "cancelling — stopping the browser and the council…" });
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {
      this.child.kill("SIGTERM"); // group gone already; the direct kill is the fallback
    }
    return this.status;
  }

  // -- run.log tailing ------------------------------------------------------

  private startTail(): void {
    this.stopTail();
    this.tailTimer = setInterval(() => void this.tailOnce(), POLL_MS);
  }

  private stopTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
  }

  /** The run folder is created several seconds in — discover it, then tail it. */
  private discoverRunDir(): void {
    if (!this.status || this.status.runDir) return;
    for (const name of this.snapshotRuns()) {
      if (this.knownRuns.has(name)) continue;
      this.status.runDir = name;
      this.emit("run_dir", { runDir: name });
      return;
    }
  }

  private async tailOnce(): Promise<void> {
    if (!this.status) return;
    this.discoverRunDir();
    if (!this.status.runDir) return;
    const file = path.join(this.runsDir(), this.status.runDir, "run.log");
    if (!existsSync(file)) return;
    try {
      const size = statSync(file).size;
      if (size <= this.tailOffset) return;
      const handle = await open(file, "r");
      try {
        const buf = Buffer.alloc(size - this.tailOffset);
        await handle.read(buf, 0, buf.length, this.tailOffset);
        this.tailOffset = size;
        this.tailCarry += buf.toString("utf8");
      } finally {
        await handle.close();
      }
      const lines = this.tailCarry.split("\n");
      this.tailCarry = lines.pop() ?? ""; // a partial trailing line waits for the next poll
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          this.emit(String(e["type"] ?? "event"), e);
        } catch {
          // append-only log; a torn line must never stall the feed
        }
      }
    } catch {
      // the folder can be pruned mid-read — nothing here is worth failing over
    }
  }
}
