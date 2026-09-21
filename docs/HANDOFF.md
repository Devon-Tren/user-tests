# Handoff — 2026-09-19/20

Two things in here: what changed in this session, and everything needed to start
the front-end work without re-deriving it.

---

## Part 1 — What we did

### The 3D Visual tab was rewritten

It used to be an orbital layout: radius = dependency depth, angular sectors =
folders, a glowing core at the centre ringed by orbiting packages, energy motes
and a pulsing scan wave. It read as a solar system, which is the wrong register
for an architecture review.

It is now a **stacked building**. Elevation is the dependency tier — the entry
surface is the top plate, each plate below is one import hop deeper, so the
drawing *is* the layered architecture. Plates share one footprint and are tied by
structural columns. Each subdivides into labelled source-folder bays, which
replaced the old per-folder "district" edges entirely: a rectangle already says
"stored together" without inventing a relationship.

Routes are drafted rather than flung — they leave a block vertically, run level
through the plenum between two plates, turn once, then rise into their
dependency. Corridor elevation is what separates the layers: imports in the
plenum, workflow rails on a raised tray above, vendor ties below.

Rendering follows: matte materials with crisp edge outlines instead of emissive
orbs, neutral lighting, `Line2` fat lines for real stroke weights, a survey grid
with registration marks, and true orthographic PLAN and ELEV projections. Bloom
dropped from `.38` to `.14`; film grain became a static paper tooth.

For the reader rather than the renderer: tier tags carry module counts, LOC and a
coverage bar; keystone cards annotate the widest blast radii with their share of
the codebase; a drafting title block signs the sheet.

**Files:** [`dashboard/index.html`](../dashboard/index.html) (`visualWorld()` does
the layout) and [`dashboard/visual-webgl.js`](../dashboard/visual-webgl.js) (the
scene). Commit `4090866`.

Verified at 21, 31 and 297 modules. Layout dimensions derive from the drawing's
own area and annotations scale with the sheet, so it holds across repo sizes.
**ELEV is the view to show someone senior** — it reads as a building section.

### Published to GitHub

| Repo | Visibility | State |
|---|---|---|
| `Devon-Tren/user-tests` | **private** | 12 commits, 47 files |
| `Devon-Tren/mapd` | **public** | 3 commits, 145 files |

mapd was not a git repo at all before this — no `.git`, no `.gitignore`, and a
live `.env` sitting next to it. A plain `git init && git add -A` would have put
real credentials in the first commit of a public repo. The `.gitignore` went in
*before* the first `git add`, which is the only ordering that works.

Both repos were audited across full history for keys, personal paths, and data
from other projects. Clean. `.env`, `runs/`, `dist/`, `.mapd/` are all ignored.

### mapd is prepped for npm but NOT published

`npm publish` has not been run. When it is, `npm install -g mapd` starts working
and User-Tests' README becomes true as written.

Fixed while prepping:

- `main` pointed at an `index.js` that does not exist — `import "mapd"` would
  have thrown. mapd is CLI-only (`bin: mapd → src/cli.js`), so `main` was removed.
- Added `repository` / `bugs` / `homepage` / `keywords`.
- **A failing test that was a bad test, not a bug.** Two `simulateScore` tests
  built a temp fixture then re-scored against `"."`, so the scorer read mapd's own
  git-backed repo instead of the fixture — moving `repoConfidence` by 0.028 with
  *no mutation at all*. The scorer was already correct. Suite is 498/498.
- `SETUP.md` ships inside the npm tarball and told users to `unzip mapd-v0.5.zip`
  — wrong version, nonexistent file. README had no install section at all.

Verified by packing the real tarball, installing into a clean dir, and running
`mapd map .` against a fresh project. That is the check that catches `files`
allowlist omissions.

### Two traps worth remembering

**1. `git push` on User-Tests costs ~$1.50 and takes ~13 minutes.**
`.git/hooks/pre-push` runs the full acceptance council whenever `src/`,
`scripts/`, `personas/`, `tests/fixture-app/` or `council.config.yaml` change.
It is a deliberate quality gate (commit `d3defa0`, documented at README line 270).
Bypass when you know the gate already passed:

```bash
USERTESTS_SKIP_ACCEPTANCE=1 git push
```

Hooks live in `.git/hooks/`, which is never pushed — so nobody cloning the repo
inherits this.

**2. Opening the dashboard with `?repo=` costs ~$0.02.**
The Visual and Architecture tabs are free static analysis, but loading the page
also renders the Project tab, which makes a `project_digest` LLM call and caches
it to `runs/<ts>/project.json`. Worse, that digest fuses *the run's* findings with
*the override repo's* architecture — producing a genuinely incorrect hybrid
describing two projects at once. To inspect a repo with zero spend, curl the API
directly instead of loading the page:

```bash
curl "http://localhost:7842/api/architecture?dir=<run>&repo=<abs-path>&fresh=1"
```

---

## Part 2 — Front-end handoff

### The decision already made

**Publish first, build the front end second.** The reasoning, so it does not get
re-litigated: the people who find this on GitHub in week one are developers, and
they are fine with `usertests run`. An onboarding UI serves a *later, less
technical* audience that does not exist yet. Building it now delays launch for
users who do not need it, and you would be designing against imagined confusion
instead of real confusion.

### The one constraint that kills naive designs

**A browser cannot hand a server a folder path.**

`<input type="file" webkitdirectory>` gives file *contents*, not a location — so
you would be uploading an entire repo to your own localhost server, which is
absurd for a tool whose job is reading a folder in place. `showDirectoryPicker()`
is Chromium-only and returns a sandboxed handle, still no path.

Options, in order of preference for this project:

1. **Server-side folder browser** — the server lists directories, the UI navigates
   them. Works everywhere, no upload, feels native. ~A day of work. **Recommended.**
2. **Electron/Tauri wrapper** — a real OS file dialog. Much bigger scope:
   packaging, signing, updates.
3. **Keep the text path input** — what exists today.

If you build (1), path traversal is the thing to get right. There is precedent in
the codebase already: `resolveRunDir()` in `src/serve.ts:89` does realpath
containment, and the vendor-addon route rejects `..`.

### The real onboarding cliff is not the API key

The key is one paste into one field. **The cliff is "your app has to already be
running on localhost"** — the council drives a real browser against a live URL,
and no UI removes that.

But a UI can make it feel handled, and most of the parts exist:

| Need | Already exists |
|---|---|
| "We found something on :3000 and :5173 — which is your app?" | `probeLocalServers()` + `COMMON_PORTS`, `src/cli.ts:49-57` |
| "~13 min, about $0.90. Start?" | `estimateCostUsd` + `estimateRunSeconds`/`formatEta`, `src/eta.ts` |
| Live progress | `run.log` is JSONL with typed events — `phase`, `persona_start`, `persona_end`, `finding`, `llm_call`, `eta`, `diff`, `error`. Tail it. |
| Everything after the run | The whole existing dashboard |

That is a genuinely different experience from reading a README, and it is mostly
wiring, not invention.

### The security shift to go in clear-eyed about

Today `src/serve.ts` is **read-only**: it reads runs, serves the dashboard,
answers chat. Existing routes:

```
GET /                    GET /api/runs        GET /api/run
GET /api/architecture    GET /api/artifacts   GET /api/artifact
GET /api/project         GET /api/explain     POST /api/chat
GET /artifact-raw        GET /visual-webgl.js GET /vendor/...
```

The moment it can *start a run*, it stops being a viewer and becomes an
**actuator** — something that launches a browser session and spends money in
response to an HTTP request. On `127.0.0.1` that is defensible, but any local
process can reach it, and a malicious page you visit can potentially POST to
localhost. Add an origin check and probably a token in the URL. Decide this
deliberately rather than discovering it later.

Also: an API key typed into a web form gets persisted server-side, and
`RunLogger` writes `run.log` on every event. **Be deliberate that the key never
reaches a log file.** mapd has a `redactSecrets` helper worth copying the shape of.

The dashboard ships a strict CSP (`src/serve.ts`, the `/` route):

```
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none';
frame-ancestors 'none'
```

No CDNs, no external anything. `dashboard/index.html` is a single ~273KB file
with no build step — keep it that way unless there is a strong reason not to.

### Suggested MVP

Reuses almost everything; no Electron, no packaging, no new app.

1. A **"New run"** panel in the existing dashboard
2. **Server-side folder browser** replacing the text path input
3. **Port probe results** as clickable options
4. **Cost estimate + explicit confirm** before any spend
5. **Live progress** tailing `run.log`

### Testing

`npm test` is deterministic and free — 11 tests across config, report, artifact
safety, the server API, and Chromium renders of every dashboard surface at
desktop and mobile widths. `tests/dashboard.test.ts` is where front-end
assertions go. Run it before every push (and remember the hook).

`npm run acceptance` spends real tokens. Do not run it casually.

---

## Open items

- [ ] `npm publish` mapd — prepped, verified, not run. Claims the name and burns
      `0.19.0` permanently.
- [ ] Flip User-Tests public: `gh repo edit Devon-Tren/user-tests --visibility public`
- [ ] Once mapd is on npm, README can link to it properly (the dead
      `https://github.com/` link was stripped, not replaced)
- [ ] Front end, per Part 2
