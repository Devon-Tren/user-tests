/**
 * artifacts.ts — the run folder as an addressable set of artifacts.
 *
 * A run folder is what the tool actually produces: REPORT.md, the chair-merged
 * findings, each persona's step log and action trace, the screenshots they
 * captured, the append-only run.log and the cached mapd graph. This module
 * turns that folder into a typed index that both the dashboard (browse,
 * preview, download) and the chat analyst (pull a file it wasn't handed) use.
 *
 * Everything here is read-only and path-safe: ids are relative to the run
 * folder and any id that resolves outside it — symlinks included — is refused.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

/** Per-file read cap. The point is grounding an answer, not dumping a repo. */
export const ARTIFACT_TEXT_CAP = 400_000;

const TEXT_EXT = new Set([".md", ".json", ".log", ".txt", ".jsonl", ".yaml", ".yml", ".csv"]);
export const ARTIFACT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export interface ArtifactMeta {
  /** POSIX path relative to the run folder — the stable id used everywhere. */
  file: string;
  name: string;
  dir: string;
  ext: string;
  /** report | merged | persona | actions | shot | codemap | log | digest | cache | other */
  kind: string;
  /** Display bucket in the dashboard. */
  group: string;
  /** One line describing what this file is, for humans and for the LLM. */
  label: string;
  persona: string | null;
  bytes: number;
  mtime: string;
  text: boolean;
}

/** Classify one artifact from its path. */
function classify(rel: string): Pick<ArtifactMeta, "kind" | "group" | "label" | "persona"> {
  const base = path.basename(rel);
  const inFindings = rel.startsWith("findings/");
  const inShots = rel.startsWith("shots/");
  if (base === "REPORT.md")
    return { kind: "report", group: "Report", label: "The chair's final report — verified findings, severities and repro steps", persona: null };
  if (base === "findings-merged.json")
    return { kind: "merged", group: "Findings", label: "Chair-merged findings: deduped and severity-ranked, with expected vs actual", persona: null };
  if (base === "findings-hashes.json")
    return { kind: "cache", group: "Bookkeeping", label: "Finding fingerprints — how the next run knows what's new", persona: null };
  if (base === "project.json")
    return { kind: "digest", group: "Bookkeeping", label: "Cached project brief rendered on the Project tab", persona: null };
  if (base === "arch.json")
    return { kind: "codemap", group: "Code map", label: "Cached mapd static analysis: files, functions, imports, workflows, test gaps", persona: null };
  if (base === "explains.json")
    return { kind: "cache", group: "Bookkeeping", label: "Cached per-finding explanations from the analyst", persona: null };
  if (base === "run.log")
    return { kind: "log", group: "Logs", label: "Append-only JSONL event log: every phase, LLM call, cost and error", persona: null };
  if (inFindings && base.endsWith(".actions.json")) {
    const persona = base.replace(/\.actions\.json$/, "");
    return { kind: "actions", group: "Action traces", label: `Every browser action ${persona} took, in order`, persona };
  }
  if (inFindings && base.endsWith(".json")) {
    const persona = base.replace(/\.json$/, "");
    return { kind: "persona", group: "Persona step logs", label: `${persona}'s step log: reasoning, results and the findings it filed`, persona };
  }
  if (inShots) {
    const m = base.match(/^finding-([a-z0-9-]+?)-s(\d+)-(.*)\.png$/i);
    if (m) return { kind: "shot", group: "Screenshots", label: `Evidence ${m[1]} captured at step ${m[2]}`, persona: m[1] ?? null };
    if (/^[A-Za-z]-\d+\.(png|jpg|jpeg|webp)$/.test(base))
      return { kind: "shot", group: "Screenshots", label: `Screenshot attached to finding ${base.replace(/\.\w+$/, "")}`, persona: null };
    return { kind: "shot", group: "Screenshots", label: "Session screenshot", persona: null };
  }
  return { kind: "other", group: "Other", label: "Run artifact", persona: null };
}

const KIND_ORDER = ["report", "merged", "persona", "actions", "shot", "codemap", "log", "digest", "cache", "other"];

/** Every file a run wrote, depth-limited and ordered by usefulness. */
export function artifactIndex(runDir: string): ArtifactMeta[] {
  const out: ArtifactMeta[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable subfolder — skip it rather than fail the whole index
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 2) walk(path.join(abs, e.name), childRel, depth + 1);
        continue;
      }
      let bytes = 0;
      let mtime = "";
      try {
        const st = statSync(path.join(abs, e.name));
        bytes = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      out.push({ file: childRel, name: e.name, dir: rel || ".", ext, ...classify(childRel), bytes, mtime, text: TEXT_EXT.has(ext) });
    }
  };
  walk(runDir, "", 0);
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.file.localeCompare(b.file));
}

/**
 * Resolve an artifact id to an absolute path, refusing anything that escapes
 * the run folder. Symlinks are checked via realpath, not just the literal path.
 */
export function resolveArtifact(runDir: string, file: string | null | undefined): string | null {
  if (!file || file.includes("\0") || path.isAbsolute(file)) return null;
  const root = path.resolve(runDir);
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!existsSync(abs)) return null;
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return statSync(real).isFile() ? abs : null;
  } catch {
    return null;
  }
}

export interface ArtifactPayload {
  file: string;
  meta: ArtifactMeta | null;
  bytes: number;
  binary: boolean;
  truncated?: boolean;
  text?: string;
}

/** Read one artifact as text (truncated), or describe it as a binary + raw URL. */
export function readArtifact(runDir: string, file: string, cap = ARTIFACT_TEXT_CAP): ArtifactPayload | null {
  const abs = resolveArtifact(runDir, file);
  if (!abs) return null;
  const id = file.replace(/\\/g, "/");
  const meta = artifactIndex(runDir).find((a) => a.file === id) ?? null;
  const ext = path.extname(abs).toLowerCase();
  const bytes = statSync(abs).size;
  // Binary artifacts (screenshots) are served bytes-first from /artifact-raw;
  // the caller pairs this metadata with the run id to build that URL.
  if (!TEXT_EXT.has(ext)) return { file: id, meta, bytes, binary: true };
  const raw = readFileSync(abs, "utf8");
  const truncated = raw.length > cap;
  return {
    file: id,
    meta,
    bytes,
    binary: false,
    truncated,
    text: truncated ? `${raw.slice(0, cap)}\n… [truncated at ${cap.toLocaleString()} characters]` : raw,
  };
}

/**
 * The catalogue the analyst sees: what exists, what each file is, how big.
 * Screenshots collapse to a count — the LLM can't read them, but it should
 * know they're there so it can point the user at the right one.
 */
export function artifactCatalogue(runDir: string): string {
  const all = artifactIndex(runDir);
  const shots = all.filter((a) => a.kind === "shot");
  const lines = all
    .filter((a) => a.kind !== "shot")
    .map((a) => `- ${a.file} (${a.text ? "text" : "binary"}, ${a.bytes.toLocaleString()} bytes) — ${a.label}`);
  if (shots.length) {
    lines.push(`- shots/ — ${shots.length} PNG screenshots (not readable as text; cite them by filename):`);
    for (const s of shots.slice(0, 40)) lines.push(`    · shots/${s.name}${s.persona ? ` [${s.persona}]` : ""}`);
    if (shots.length > 40) lines.push(`    · …and ${shots.length - 40} more`);
  }
  return lines.join("\n");
}
