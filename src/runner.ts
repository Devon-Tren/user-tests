/**
 * runner.ts — Playwright session wrapper.
 *
 * Agents may ONLY act through the closed action set exposed here. That keeps
 * behavior auditable, makes the replay log mechanically re-executable by the
 * chair, and prevents personas from reaching for arbitrary page.evaluate.
 *
 * Every action returns { ok, error?, snapshot } and is appended (with a
 * timestamp) to an in-memory action log that is persisted per persona so the
 * chair can replay it later in a fresh browser.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ActionName =
  | "goto"
  | "click"
  | "type"
  | "pressKey"
  | "scroll"
  | "hover"
  | "goBack"
  | "screenshot";

export interface ActionParams {
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down";
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Compact accessibility-tree-style DOM summary — what the LLM "sees" in text. */
  snapshot: string;
  /** Present only after screenshot(): path relative to the run folder. */
  screenshot?: string;
}

export interface ActionLogEntry {
  step: number;
  ts: string;
  action: ActionName;
  params: ActionParams;
  ok: boolean;
  error?: string;
}

const MAX_SNAPSHOT_ELEMENTS = 60; // token budget guard: interactive/visible first
const ACTION_TIMEOUT_MS = 5_000; // dead ends should feel like dead ends, not hangs

/**
 * In-page extractor as a STRING: Playwright evaluates it verbatim in the
 * browser, so no transpiler helpers can leak into page context. It is invoked
 * as an IIFE by snapshot() — page.evaluate("string") alone only evaluates the
 * expression, it does not call it.
 *
 * Walks the DOM, keeps visible + interactive elements, builds stable-ish
 * selectors (id > data-testid > name > nth-of-type path).
 */
const SNAPSHOT_SCRIPT = `(max) => {
  const interactiveSel = 'a, button, input, select, textarea, [role], [onclick], [tabindex], summary, label';
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const selectorFor = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const dt = el.getAttribute('data-testid');
    if (dt) return '[data-testid="' + dt + '"]';
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const same = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const idx = same.indexOf(el) + 1;
    return selectorFor(parent) + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + idx + ')';
  };
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.textContent) return lab.textContent.trim();
    }
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const ph = el.getAttribute('placeholder');
    if (ph) return '(placeholder) ' + ph;
    return (el.innerText || el.textContent || '').trim().slice(0, 60);
  };
  const roleFor = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag === 'input' && ['button','submit'].includes(type))) return 'button';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    return tag;
  };
  const all = Array.from(document.querySelectorAll(interactiveSel)).filter(isVisible);
  const lines = all.slice(0, max).map((el) => {
    const bits = [roleFor(el)];
    const label = labelFor(el);
    if (label) bits.push(JSON.stringify(label));
    bits.push(selectorFor(el));
    if (el.getAttribute('tabindex') === '-1') bits.push('[tabindex=-1]');
    if (el.disabled) bits.push('[disabled]');
    return '- ' + bits.join(' ');
  });
  const truncated = all.length > max ? '\\n… (' + (all.length - max) + ' more elements truncated)' : '';
  const h1 = document.querySelector('h1');
  const head = 'URL: ' + location.href + '\\nTITLE: ' + document.title +
    (h1 && h1.textContent ? '\\nH1: ' + h1.textContent.trim() : '');
  return head + '\\nELEMENTS (' + all.length + '):\\n' + (lines.join('\\n') || '(none)') + truncated;
}`;

export class Runner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  readonly log: ActionLogEntry[] = [];
  private shotCounter = 0;

  constructor(
    private readonly runDir: string,
    private readonly viewport: { width: number; height: number },
    private readonly fullPage: boolean = false
  ) {}

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ viewport: this.viewport });
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Runner not launched. Call launch() first.");
    return this.page;
  }

  async snapshot(): Promise<string> {
    const page = this.requirePage();
    try {
      return (await page.evaluate(`(${SNAPSHOT_SCRIPT})(${MAX_SNAPSHOT_ELEMENTS})`)) as string;
    } catch (e) {
      // Navigation mid-evaluate etc. — a blank snapshot is more useful than a crash.
      return `URL: ${page.url()}\n(snapshot unavailable: ${e instanceof Error ? e.message : e})`;
    }
  }

  private async takeScreenshot(): Promise<string> {
    const page = this.requirePage();
    this.shotCounter += 1;
    const rel = path.join("shots", `${String(this.shotCounter).padStart(3, "0")}.png`);
    mkdirSync(path.join(this.runDir, "shots"), { recursive: true });
    await page.screenshot({ path: path.join(this.runDir, rel), fullPage: this.fullPage });
    return rel;
  }

  /** Screenshot as a Buffer for the LLM's eyes (does not write to disk). */
  async screenshotBuffer(): Promise<Buffer> {
    return this.requirePage().screenshot({ fullPage: this.fullPage });
  }

  /** Persist a screenshot the LLM attaches to a finding, under a stable name. */
  async saveFindingScreenshot(name: string): Promise<string> {
    const page = this.requirePage();
    const safe = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40);
    const rel = path.join("shots", `finding-${safe}.png`);
    mkdirSync(path.join(this.runDir, "shots"), { recursive: true });
    await page.screenshot({ path: path.join(this.runDir, rel), fullPage: this.fullPage });
    return rel;
  }

  /**
   * Execute one action from the closed set. Never throws on action failure —
   * the error is returned and logged so the agent experiences it as feedback,
   * exactly like a user hitting a broken control.
   */
  async act(step: number, action: ActionName, params: ActionParams): Promise<ActionResult> {
    const page = this.requirePage();
    const entry: ActionLogEntry = {
      step,
      ts: new Date().toISOString(),
      action,
      params,
      ok: false,
    };
    let error: string | undefined;
    let screenshot: string | undefined;

    try {
      switch (action) {
        case "goto": {
          if (!params.url) throw new Error('goto requires params.url');
          const url = new URL(params.url, page.url()).toString(); // allow relative nav
          await page.goto(url, { timeout: 10_000, waitUntil: "domcontentloaded" });
          break;
        }
        case "click": {
          const sel = this.requireSelector(params);
          await page.click(sel, { timeout: ACTION_TIMEOUT_MS });
          break;
        }
        case "type": {
          const sel = this.requireSelector(params);
          if (params.text === undefined) throw new Error('type requires params.text');
          await page.fill(sel, params.text, { timeout: ACTION_TIMEOUT_MS });
          break;
        }
        case "pressKey": {
          if (!params.key) throw new Error('pressKey requires params.key (e.g. "Enter", "Tab")');
          await page.keyboard.press(params.key);
          break;
        }
        case "scroll": {
          const dir = params.direction === "up" ? -1 : 1;
          await page.mouse.wheel(0, 600 * dir);
          await page.waitForTimeout(200); // let lazy content settle
          break;
        }
        case "hover": {
          const sel = this.requireSelector(params);
          await page.hover(sel, { timeout: ACTION_TIMEOUT_MS });
          break;
        }
        case "goBack": {
          await page.goBack({ timeout: ACTION_TIMEOUT_MS });
          break;
        }
        case "screenshot": {
          screenshot = await this.takeScreenshot();
          break;
        }
        default: {
          // Exhaustiveness guard: an LLM inventing actions lands here.
          const neverAction: never = action;
          throw new Error(`unknown action "${String(neverAction)}"`);
        }
      }
      entry.ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message.split("\n")[0] ?? String(e) : String(e);
      entry.error = error;
    }

    this.log.push(entry);
    const snapshot = await this.snapshot();
    return { ok: entry.ok, error, snapshot, screenshot };
  }

  private requireSelector(params: ActionParams): string {
    if (!params.selector || params.selector.trim() === "") {
      throw new Error("action requires params.selector (pick one from the ELEMENTS list)");
    }
    return params.selector;
  }

  /** Persist the replay log so the chair can mechanically re-execute it later. */
  saveLog(file: string): void {
    writeFileSync(file, JSON.stringify(this.log, null, 2));
  }

  /** Current page URL (used to scope relative goto targets). */
  currentUrl(): string {
    return this.page?.url() ?? "about:blank";
  }
}

/**
 * Replay a recorded action log in a FRESH browser session (chair repro
 * verification). Mechanical only — no LLM involved. Returns which step failed,
 * if any.
 */
export async function replayLog(
  log: ActionLogEntry[],
  upToStep: number,
  startUrl: string,
  viewport: { width: number; height: number }
): Promise<{ ok: boolean; failedAtStep?: number; error?: string; snapshot?: string }> {
  const REPLAY_WAIT_MS = 10_000; // wait-for-selector budget: tolerate slow/dynamic content
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(startUrl, { timeout: 10_000, waitUntil: "domcontentloaded" });
    for (const entry of log) {
      if (entry.step > upToStep) break;
      try {
        switch (entry.action) {
          case "goto":
            await page.goto(new URL(entry.params.url!, page.url()).toString(), {
              timeout: 10_000,
              waitUntil: "domcontentloaded",
            });
            break;
          case "click":
            await page.waitForSelector(entry.params.selector!, {
              state: "visible",
              timeout: REPLAY_WAIT_MS,
            });
            await page.click(entry.params.selector!, { timeout: ACTION_TIMEOUT_MS });
            // Tolerate click-triggered navigation without fixed sleeps.
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            break;
          case "type":
            await page.waitForSelector(entry.params.selector!, {
              state: "visible",
              timeout: REPLAY_WAIT_MS,
            });
            await page.fill(entry.params.selector!, entry.params.text ?? "", {
              timeout: ACTION_TIMEOUT_MS,
            });
            break;
          case "pressKey":
            await page.keyboard.press(entry.params.key!);
            break;
          case "scroll":
            await page.mouse.wheel(0, entry.params.direction === "up" ? -600 : 600);
            break;
          case "hover":
            await page.waitForSelector(entry.params.selector!, {
              state: "visible",
              timeout: REPLAY_WAIT_MS,
            });
            await page.hover(entry.params.selector!, { timeout: ACTION_TIMEOUT_MS });
            break;
          case "goBack":
            await page.goBack({ timeout: ACTION_TIMEOUT_MS });
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            break;
          case "screenshot":
            break; // observation-only; nothing to replay
        }
      } catch (e) {
        // An action that failed in the ORIGINAL session failing again in replay
        // is consistent app behavior (e.g. a genuine dead end), not evidence
        // against the finding — skip it. Only an originally-successful action
        // that now fails marks the finding unverified.
        if (!entry.ok) continue;
        return {
          ok: false,
          failedAtStep: entry.step,
          error: e instanceof Error ? e.message.split("\n")[0] ?? String(e) : String(e),
        };
      }
    }
    // End-of-replay page state — the chair's false-positive pruning compares
    // each confirmed claim against this. A capture failure never fails replay.
    let snapshot = "";
    try {
      snapshot = (await page.evaluate(`(${SNAPSHOT_SCRIPT})(${MAX_SNAPSHOT_ELEMENTS})`)) as string;
    } catch {
      snapshot = `URL: ${page.url()}\n(snapshot unavailable)`;
    }
    return { ok: true, snapshot };
  } finally {
    await browser.close();
  }
}
