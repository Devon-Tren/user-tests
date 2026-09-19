import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(projectRoot, "dist");

if (path.dirname(dist) !== projectRoot || path.basename(dist) !== "dist") {
  throw new Error(`refusing to clean unexpected output path: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
