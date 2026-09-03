// Tiny static server for the fixture app — no dependencies.
//   node scripts/serve-fixture.js [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 4173);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixture-app");

createServer((req, res) => {
  const file = path.join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url ?? "/"));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(302, { location: "/" });
    res.end();
  }
}).listen(port, () => console.log(`fixture app → http://localhost:${port}`));
