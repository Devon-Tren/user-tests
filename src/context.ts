/**
 * context.ts — builds the "what is this app supposed to do" briefing from the
 * target repo. Fed in full to goal-gap-auditor; withheld from first-time-user
 * (deliberately — it must judge the UI on its own terms). Missing files are
 * fine; partial context beats a crash.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const CANDIDATE_FILES = ["README.md", "GOALS.md", "docs/goals.md", "PRODUCT.md"];
/** ~3k tokens at a rough 4 chars/token. */
const MAX_CONTEXT_CHARS = 12_000;
const MAX_FILE_CHARS = 8_000;

export function buildRepoContext(repoPath: string): string {
  const parts: string[] = [];

  for (const rel of CANDIDATE_FILES) {
    const file = path.join(repoPath, rel);
    if (!existsSync(file)) continue;
    try {
      let text = readFileSync(file, "utf8");
      if (text.length > MAX_FILE_CHARS) {
        text = text.slice(0, MAX_FILE_CHARS) + "\n… (file truncated)";
      }
      parts.push(`===== ${rel} =====\n${text.trim()}`);
    } catch {
      // unreadable file — skip silently; context is best-effort by design
    }
  }

  try {
    const listing = readdirSync(repoPath)
      .filter((name) => name !== "node_modules" && !name.startsWith(".git"))
      .map((name) => {
        try {
          return statSync(path.join(repoPath, name)).isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      })
      .slice(0, 60)
      .join("\n");
    parts.push(`===== top-level directory listing =====\n${listing}`);
  } catch {
    // repo_path might be a bare folder — fine
  }

  if (parts.length === 0) {
    return "(No repo documentation found. The app has no documented goals to audit against.)";
  }

  let combined = parts.join("\n\n");
  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = combined.slice(0, MAX_CONTEXT_CHARS) + "\n… (context truncated to token budget)";
  }
  return combined;
}
