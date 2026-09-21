/**
 * browse.ts — the server-side folder browser.
 *
 * A browser cannot hand a server a folder path: webkitdirectory uploads file
 * CONTENTS, and showDirectoryPicker() returns a sandboxed handle with no path.
 * For a tool whose whole job is reading a repo in place, uploading it to your
 * own localhost is absurd. So the server lists directories and the UI walks
 * them.
 *
 * That makes path traversal the thing to get right. Containment is enforced by
 * realpath — the same shape as resolveRunDir() in serve.ts — so a symlink
 * pointing outside the root is rejected even though its literal path looks
 * contained. Directory NAMES are all this ever returns; no file is ever read.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Noise that is never the repo you meant to pick. */
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", "Library"]);

export interface DirEntry {
  name: string;
  path: string;
  /** Has .git or package.json — almost always the folder the user wants. */
  isRepo: boolean;
}

export interface DirListing {
  /** Absolute, realpath-resolved. */
  path: string;
  /** Display form with the home directory collapsed to ~. */
  label: string;
  /** Parent, or null at the root — the UI disables "up" on null. */
  parent: string | null;
  root: string;
  isRepo: boolean;
  entries: DirEntry[];
}

export function defaultBrowseRoot(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

function looksLikeRepo(dir: string): boolean {
  return existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "package.json"));
}

function collapseHome(p: string): string {
  const home = defaultBrowseRoot();
  return p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/**
 * Resolve a requested path, or throw. Containment is checked AFTER realpath so
 * symlink escapes are caught; the root itself is always allowed.
 */
export function resolveWithin(root: string, requested: string | null): string {
  const realRoot = realpathSync(root);
  const target = requested && requested.trim() !== "" ? path.resolve(realRoot, requested) : realRoot;
  if (!existsSync(target)) throw new Error("no such folder");
  const real = realpathSync(target);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error("folder is outside the browsable root");
  }
  if (!statSync(real).isDirectory()) throw new Error("not a folder");
  return real;
}

/** List the sub-directories of `requested`. Never returns files or their contents. */
export function listDirs(root: string, requested: string | null, showHidden = false): DirListing {
  const dir = resolveWithin(root, requested);
  const realRoot = realpathSync(root);

  const entries: DirEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // A symlinked directory is still a directory worth offering; resolveWithin
    // re-checks containment when the user actually navigates into it.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (SKIP.has(e.name)) continue;
    if (!showHidden && e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    try {
      if (!statSync(full).isDirectory()) continue; // dangling or file-pointing symlink
      entries.push({ name: e.name, path: full, isRepo: looksLikeRepo(full) });
    } catch {
      continue; // permission denied on a single entry must not fail the listing
    }
  }
  entries.sort((a, b) => (a.isRepo === b.isRepo ? a.name.localeCompare(b.name) : a.isRepo ? -1 : 1));

  return {
    path: dir,
    label: collapseHome(dir),
    parent: dir === realRoot ? null : path.dirname(dir),
    root: realRoot,
    isRepo: looksLikeRepo(dir),
    entries,
  };
}
