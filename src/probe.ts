/**
 * probe.ts — finding and validating the app under test.
 *
 * Shared by the CLI (`usertests run` auto-detect) and the dashboard's launch
 * panel, so both agree on what counts as a dev server and on what "reachable"
 * means. Neither spends an LLM token.
 */

/** Dev servers cluster on these ports; probe them when --target is omitted. */
export const COMMON_PORTS = [3000, 3001, 5173, 4173, 4200, 5000, 5001, 5191, 7000, 7001, 7136, 8000, 8080, 4321, 8787, 9000];

/** Probe common local dev-server ports in parallel. Returns the alive ones.
 *  macOS's AirPlay receiver answers 403 on 5000/7000 — treat non-2xx/3xx
 *  (and anything speaking AirTunes) as "not a dev server". */
export async function probeLocalServers(): Promise<string[]> {
  const results = await Promise.all(
    COMMON_PORTS.map(async (p) => {
      try {
        const res = await fetch(`http://localhost:${p}`, {
          signal: AbortSignal.timeout(600),
        });
        if (res.status >= 400) return null;
        if (/airtunes/i.test(res.headers.get("server") ?? "")) return null;
        return `http://localhost:${p}`;
      } catch {
        return null;
      }
    })
  );
  return results.filter((u): u is string => u !== null);
}

/** One probed server, with enough detail for a human to pick the right one. */
export interface ProbedServer {
  url: string;
  port: number;
  /** <title> of the served page, when it has one — the fastest way to recognise your app. */
  title: string | null;
  /** Framework hint from the response headers / body, e.g. "vite". */
  hint: string | null;
}

/** Like probeLocalServers(), but annotated for a picker UI. Still free and fast. */
export async function probeLocalServersDetailed(): Promise<ProbedServer[]> {
  const results = await Promise.all(
    COMMON_PORTS.map(async (p): Promise<ProbedServer | null> => {
      try {
        const res = await fetch(`http://localhost:${p}`, { signal: AbortSignal.timeout(900) });
        if (res.status >= 400) return null;
        if (/airtunes/i.test(res.headers.get("server") ?? "")) return null;
        // Only the head of the body — enough for <title>, never the whole app.
        const body = (await res.text()).slice(0, 4_000);
        const title = body.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim() ?? null;
        const hint =
          /\/@vite\/client/.test(body) ? "vite"
          : /__next|\/_next\//.test(body) ? "next.js"
          : /ng-version/.test(body) ? "angular"
          : res.headers.get("x-powered-by");
        return { url: `http://localhost:${p}`, port: p, title, hint: hint || null };
      } catch {
        return null;
      }
    })
  );
  return results.filter((s): s is ProbedServer => s !== null);
}

/** Fail loudly and cheaply when the target isn't up — before any token is spent. */
export async function assertReachable(target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(target, { method: "GET", signal: controller.signal });
    if (res.status >= 500) {
      throw new Error(`target responded with HTTP ${res.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Target ${target} is not reachable (${msg}). Start your app first — no LLM tokens were spent.`
    );
  } finally {
    clearTimeout(timer);
  }
}
