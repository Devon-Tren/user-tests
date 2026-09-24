# User-Tests

A CLI tool that spins up a **council of LLM-driven agent personas** to user-test
a locally running web app. Each agent drives the app through a real browser
(Playwright), behaves according to its persona, and logs findings. A **chair**
agent then dedupes them, verifies reproducibility by mechanically replaying the
recorded steps in a fresh browser, ranks severity, and writes one structured
`REPORT.md` — the deliverable a Product Owner reads before sprint planning.

It looks for usability confusion, goal-vs-delivery gaps, edge-case bugs, and
accessibility/polish issues. A full run typically takes ~5–15 minutes and costs
about **$0.50–$1.25**, depending on the model, retries, and app complexity.

[Install](#install) · [First run](#your-first-run) · [What you get](#what-you-get) · [Dashboard](#the-dashboard) · [Reference](#reference) · [Troubleshooting](#troubleshooting) · [How it works](#how-it-works) · [Development](#development)

## Install

To **run the council** you need **Node ≥ 20**, an **app running on localhost**,
and an **API key** for Anthropic or OpenAI. Chromium is installed below.

To **map a codebase** you need none of those — only `mapd` on your PATH. That
mode reads your source and answers questions about it for free, offline, without
ever calling a model. See [Free mode](#free-mode--no-key-no-run). `mapd` also
adds coverage-guided personas and the Architecture tab to paid runs.

```bash
git clone https://github.com/Devon-Tren/user-tests.git && cd user-tests

npm install                       # runtime + TypeScript development tooling
npx playwright install chromium   # one-time browser download (~130 MB)
npm run build                     # strict TypeScript compile → dist/
npm link                          # puts `usertests` on your PATH

cat > .env <<'EOF'
USERTESTS_API_KEY=sk-…
USERTESTS_PROVIDER=anthropic        # or: openai
# USERTESTS_MODEL=claude-sonnet-4-5 # provider defaults are sane
# USERTESTS_BASE_URL=https://…      # any Anthropic- or OpenAI-compatible endpoint
EOF
```

> **Or skip the `.env` entirely.** Run `usertests serve` and the **Start** tab
> walks you through it: it tells you what is missing, takes your key in a form
> and writes that file for you, finds your running app, and launches the run.
> See [The dashboard](#the-dashboard).

Check it works without spending a token:

```bash
usertests --version
npm run fixture:serve &                    # test app on :4173
npm run smoke -- http://localhost:4173     # opens it, screenshots, prints the DOM snapshot
```

<details>
<summary>Prefer not to <code>npm link</code>?</summary>

Every command below works unlinked — substitute one of:

```bash
node dist/cli.js run …      # after npm run build
npx tsx src/cli.ts run …    # straight from source, no build step
npm start -- run …          # via the package script
```
</details>

## Your first run

The repo ships a deliberately-broken fixture app: a dead button, a
white-screening form, an unlabeled input, a documented-but-missing Export
feature, and a keyboard focus trap. The council is expected to surface at least
four of the five.

```bash
npm run fixture:serve                                                    # terminal 1 → :4173
usertests run --target http://localhost:4173 --repo tests/fixture-app    # terminal 2
usertests serve                                                          # terminal 3 → :7842
```

### On your own project

The only requirement is that **your app is running** — the council browses a
live URL with a real browser. It reads your repo for context, but it tests the
UI.

```bash
cd /path/to/your/project
npm run dev                                    # leave it running

usertests run                                  # auto-detects the dev server, uses this folder as repo context
usertests run --target http://localhost:5191   # or name the server explicitly
usertests run --steps 5                        # quick sanity pass first (~2 min, ~$0.20)
```

Three things worth knowing:

- **Auto-detect** probes common dev-server ports in parallel. If several answer,
  the CLI lists them and asks for `--target` — it never guesses wrong.
- **Your current folder is the repo under test.** `goal-gap-auditor` reads its
  `README.md` / `GOALS.md` / `docs/goals.md` / `PRODUCT.md` to audit
  promise-vs-delivery, and a `council.config.yaml` there overrides the tool's
  own config — so settings can live per project.
- **Cost is bounded.** The estimate prints before any token is spent, and hard
  caps live under `limits:` in the config.

If `mapd` is on your PATH, every persona also gets a
**coverage briefing** first: the app's real routes/entry points and the source
files with no automated tests (static analysis — deterministic, no API key,
~1s). Personas use it to aim their limited steps at untested flows instead of
wandering. Fully optional and fail-open. Adds ~1k input tokens per step
(~+$0.10/run); tune or disable via `mapd:` in the config.

## What you get

Everything lands in `runs/<ISO-timestamp>/`. Nothing hides in a database — the
run folder *is* the output, and the dashboard's Artifacts tab browses it.

| File | What it is |
|---|---|
| `REPORT.md` | the chair's report: verified findings, severities, repro steps — the deliverable |
| `findings-merged.json` | the same findings as data: deduped, ranked, expected vs actual |
| `findings/<persona>.json` | that persona's full step log — reasoning, results, findings it filed |
| `findings/<persona>.actions.json` | the raw browser actions it took, in order, with selectors and errors |
| `shots/*.png` | screenshots, including one per finding as evidence |
| `run.log` | append-only JSONL: every phase, LLM call, token count, duration, cost, error |
| `arch.json` | cached mapd code map (written when you first open Architecture or Visual) |
| `project.json`, `explains.json` | cached project brief and per-finding explanations |
| `findings-hashes.json` | fingerprints, so the next run can say what's NEW |

Read it however you like:

```bash
cat runs/<ts>/REPORT.md   # or open it in your editor
usertests chat            # ask a grounded analyst about it
usertests serve           # or read it all visually
```

`chat` is read-only and grounded strictly in that run's artifacts. Answers cite
finding codes and `[persona step N]`; when no tester covered something it says
so — a coverage answer, not a guess. The digest loads once per session and the
conversation rides along, so follow-ups work naturally. A failed turn doesn't
end the session. ~$0.02 per turn, total printed when you leave.

```bash
usertests chat                             # REPL over the latest run
usertests chat what were the top issues    # opening question — quoting optional
chat> did anyone test the settings page    # follow-ups keep full context
chat> why is C-1 critical
chat> end                                  # leave (also: exit, quit, Ctrl+D)
```

## The dashboard

```bash
usertests serve          # → http://localhost:7842 (127.0.0.1 only)
```

A zero-dependency local dashboard over all your runs. Switch runs from the
picker in the header; `⌘/Ctrl+K` opens the chat drawer anywhere, `Esc` closes it.

| Tab | What it shows |
|---|---|
| **Start** | set up your API key, pick a repo and a running app, see the cost, launch a run and watch it live |
| **Project** | what this app *is* — brief, tech stack, main flows, top risks |
| **Overview** | severity, cost and duration, response/retry integrity, persona completion, artifact health, and the rendered report |
| **Journey** | the page-flow graph of where personas actually went, then each run retold as a story: chapters per screen, every action in plain words, a 🚩 at the exact step a problem was filed |
| **Mind Map** | the app itself — screens visited → what was done there → problems pinned where they were found, plus the code surfaces underneath |
| **Architecture** | the technical view of the source, via mapd |
| **Findings** | every finding as a card: repro steps, expected vs actual, screenshot, one-click **LLM explanation** (cached per run) |
| **Artifacts** | the run folder itself, browsable |
| **History** | cross-run trends with NEW-findings badges and successful-response/API-attempt reliability |
| **Visual** | an interactive 3D repository blueprint: orbit, pan, zoom, hover and pin the complete technical map |

**Start** is the front door. On a machine that is not set up yet — no API key,
no Chromium, no runs — it takes the whole page over instead of dropping you on
an empty dashboard; once the tool works and a run exists, it demotes to an
ordinary tab. It checks readiness (all free — no LLM call happens on page
load), writes your key to `.env` at mode `0600`, browses your filesystem
server-side to pick the repo, probes the usual dev-server ports so you can click
your app rather than type its URL, shows **cost and ETA before anything is
spent**, and then streams the run live: phase, persona, findings, spend so far,
with Cancel. When it finishes it hands you straight to the report.

**Picking a project** goes through your OS's own folder dialog. A *browser*
cannot hand a server a folder path — `webkitdirectory` uploads file contents
and `showDirectoryPicker()` returns a sandboxed handle — but `usertests serve`
runs on your machine, so the server opens Finder (or the Windows/zenity
equivalent) and reads the path off it. The browser never touches a file.

Where no dialog exists — a headless box, an SSH session — the in-page browser
takes over: directory names only, never file contents, and it cannot escape
your home directory. `--browse-root <path>` moves that boundary if your repos
live elsewhere. A folder you chose in the OS dialog is allowed to sit outside
it, because picking it *is* the consent.

**Choosing depth** is a choice between outcomes, not a number of steps: a
**Quick pass** or a **Full run**, each quoting its own live price, plus a
per-persona option so a single tester can be run for a fraction of the cost.

**First run** plays a short narrated walkthrough, once. It ships in `docs/`
rather than inside the npm package, so installs stay small; when it is absent
the onboarding simply shows its written cards instead.

Because the dashboard can now spend money, the routes that do so are gated: a
per-process token substituted into the page, a same-origin check, and a
JSON-content-type requirement that forces a preflight on any cross-origin
attempt. Your API key is never returned by any endpoint, never placed on a
command line, and is stripped from `run.log` by `redactSecrets`.

**Architecture** renders a layered dependency graph: entry points on the left,
one column per import hop, workflow colouring, untested files dashed, red
back-edges for cycle candidates. Toggle layers⇄folders, zoom, filter, or click a
module to pin it — everything upstream lights amber, downstream green, and the
inspector opens its functions, exports and internal call graph. Underneath:
graph metrics, a risk-scored hotspot table, a blast-radius × size risk map, a
directory coupling heatmap and LOC treemap, cycle (SCC) detection, the workflow
catalogue, external-dependency ranking and the function-size distribution. Older
runs can enter their repo path manually; new runs record it automatically.

**Visual** turns that same static-analysis graph into a true WebGL code atlas
(with the original canvas renderer retained as a compatibility fallback).
It uses a deterministic architectural site plan: the repository sits on a
surveyed base at the center, each concentric guide ring is a shortest-hop
dependency layer, source folders own angular sectors, and translucent module
blocks (massing-model style, with bright survey linework) are sized by lines of
code. Entry points raise a survey pin, foundation rings encode test status, and
risk beacons remain independent from the active colour mode. Exact imports
become solid animated routes whose particles travel from importer to dependency;
inferred shared workflows are dashed rails, directory affinity stays on the
ground plane, and only actually imported packages enter the outer belt.
Search or jump to a module, filter to runtime code, test
gaps or high-risk files, recolour by workflow/risk/tests/folder, switch
route layers, or jump between top, isometric and front cameras.
Import routes thicken with the number of modules that depend on their target,
broad arcs bridge districts into cross-directory trade routes scaled by import
volume, and hovering (not just selecting) a module isolates its neighborhood.
The WebGL world runs through a bloom + vignette/grain post chain for a
cinematic, living-system look. Hover previews an element; clicking
pins it and lights its upstream blast radius amber and downstream dependencies
green. Drag freely through a full 360° orbit, Shift-drag to pan, use the wheel
to zoom, or use the keyboard controls shown in the view. Module roles get
distinct geometry, packages orbit the repository boundary, labels declutter in
screen space, clicking flies the camera to a module, and **TOUR** walks through
entry points, high-risk files and blast-radius hotspots automatically.

**Artifacts** makes the run folder readable in place: `REPORT.md` rendered, JSON
pretty-printed and syntax-coloured with a shape summary, `run.log` as a
filterable event stream, screenshots inline — with open-raw, download and
copy-id on each. Artifact references inside the report (`shots/C-1.png`) are
clickable everywhere they appear, and every other tab shows which files it was
rendered from.

### Free mode — no key, no run

Mapping a codebase costs nothing and needs no API key, no running app and no
run — it is `mapd` static analysis end to end. Choose **🗺️ Map a codebase** on the
front door and any project on your disk opens in the Architecture graph, the
Mind Map's code surfaces and the 3D Visual blueprint.

The chat drawer works there too, and answers from the map instead of a model.
No tokens, no network, instant once the repo is mapped:

| Ask | You get |
|---|---|
| `overview` | files, lines, languages, entry points, workflows, coverage, cycles |
| `entry points` | where execution starts, and how much of the repo each one reaches |
| `what's untested` | files no test imports, largest first, with dependent counts |
| `where should I start` | structural risk — size, how much depends on it, whether tests reach it |
| `workflows` | the feature-like file chains mapd inferred |
| `biggest files` · `orphans` · `cycles` | size outliers, disconnected files, import loops |
| `what depends on src/chat.ts` | direct importers, plus the transitive count |
| `what does src/serve.ts import` | the same question the other way round |
| `tell me about src/cli.ts` | size, functions, imports, test status, risk score |

Every number is computed from the model the Architecture and Visual tabs draw,
so the answers and the pictures never disagree.

It will not pretend to know more than the map holds. Ask whether a button works
and it tells you plainly: static analysis describes **structure**, not
behaviour, and only a run finds defects.

### The analyst pulls artifacts on demand

The chat analyst gets a catalogue of every file the run wrote. When a question
needs more than the digest carries — the exact selector in an action trace, a
specific `run.log` event — it requests the file and answers from its contents on
the next round-trip, telling you which ones it opened. You can force the matter:
**📎 pin** any artifact in the UI (or `/pin findings/chaos-hunter.actions.json`)
and the next answer quotes that file verbatim. A pull costs one extra LLM
round-trip, capped at two rounds and ~90 KB per turn.

Slash commands in the dashboard chat are free — no tokens:

| Command | Does |
|---|---|
| `/help` | list these |
| `/severity`, `/cost` | findings donut · LLM spend per persona |
| `/flow C-2` | repro path for a finding |
| `/timeline chaos-hunter` | that persona's step/finding timeline |
| `/artifacts` | list every file this run wrote |
| `/artifact REPORT.md` | open one in the viewer |
| `/pin findings/chaos-hunter.actions.json` | ground the next answer in that file |
| `/project` | full project brief from the analyst (this one does spend) |

## Reference

### CLI

**`usertests run`** — run the council against a live app.

| Flag | Meaning |
|---|---|
| `--target <url>` | URL of the running app (default: auto-detect, then config) |
| `--repo <path>` | the app's repo — default: current directory |
| `--config <path>` | `council.config.yaml` to use (default: `./council.config.yaml` if present) |
| `--steps <n>` | max steps per agent, overriding config |
| `--persona <name>` | run a single persona — for iterating on prompts |
| `--watch` | re-run whenever a file in `repo_path` changes (debounced, serialized) |

**`usertests chat [question…]`** — `--run <path>` picks a run folder (default:
the latest in `runs/`).

**`usertests serve`** — `--run <name>` opens a specific run, `--port <n>`
changes the port (default `7842`), `--browse-root <path>` sets the folder the
Start tab's repo browser may not escape (default: your home directory). Bound to
`127.0.0.1` only. Deep links: `?run=<folder>&tab=<tab>&repo=<abs-path>`.

### npm scripts

```bash
npm run build          # strict TypeScript compile
npm test               # deterministic unit, API, security, UI, and Playwright checks
npm run smoke -- <url> # open a page, screenshot, print the DOM snapshot (no LLM)
npm run acceptance     # live model-quality run; requires ≥4/5 real planted findings
npm run fixture:serve  # serve tests/fixture-app on :4173
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `USERTESTS_API_KEY` | — | **required** |
| `USERTESTS_PROVIDER` | `anthropic` | `anthropic` \| `openai` |
| `USERTESTS_MODEL` | provider default | e.g. `claude-sonnet-4-5`, `gpt-4.1` |
| `USERTESTS_BASE_URL` | — | any compatible endpoint (gateways, proxies) |
| `USERTESTS_SKIP_ACCEPTANCE` | — | set to `1` to bypass the pre-push gate deliberately |

Only `src/llm.ts` knows about providers, so switching backends is env-only:

```bash
USERTESTS_PROVIDER=openai USERTESTS_MODEL=gpt-4o USERTESTS_API_KEY=sk-… usertests run …
USERTESTS_PROVIDER=openai USERTESTS_BASE_URL=https://my-gateway/v1 …   # any OpenAI-compatible endpoint
```

### `council.config.yaml`

```yaml
target: http://localhost:3000   # overridable by --target
repo_path: .                    # overridable by --repo
max_steps_per_agent: 30         # overridable by --steps
viewport: { width: 1440, height: 900 }
# full_page_screenshots: true   # default false = viewport-only shots
limits:                         # safety rails (all optional, defaults shown)
  max_llm_calls: 250            # hard cap on API attempts per run
  # max_cost_usd: 2.00          # hard USD budget; omit for no cost cap
  max_run_minutes: 45           # wall-clock limit
  llm_timeout_seconds: 120      # per-LLM-call timeout
  keep_runs: 20                 # prune older runs/ folders after each run
# mapd:                         # coverage briefing; on by default when mapd is on PATH
#   enabled: true
#   path: mapd
#   max_chars: 4000
council:
  testers:
    - persona: first-time-user   # harshness 4
    - persona: goal-gap-auditor  # harshness 5
    - persona: chaos-hunter      # harshness 8 — actively tries to break it
    - persona: a11y-polish       # harshness 3
  chair:
    verify_repro: true
    min_severity_to_verify: major
    max_findings_per_run: 25
    # false_positive_pruning: true
```

Add a tester by dropping a new `.md` into `personas/` and adding an entry under
`council.testers` — no code changes required.

### HTTP API

The dashboard is a thin client over a small JSON API, useful for scripting:

```
GET  /api/runs                      all runs + headline stats
GET  /api/run?dir=<name>            one run: findings, persona steps, cost stats
GET  /api/architecture?dir=<name>   the mapd code map (&repo=, &fresh=1)
GET  /api/artifacts?dir=<name>      every file the run wrote, typed and labelled
GET  /api/artifact?dir=&file=       one artifact as text + metadata
GET  /artifact-raw?dir=&file=       one artifact as bytes (&download=1)
POST /api/explain                   {dir, code} → grounded explanation
POST /api/chat                      {dir, message, history[], artifacts[]}
```

Onboarding routes. Everything here is free except `POST /api/run/start`; the
ones marked **token** require the `x-usertests-token` header that the dashboard
is served with, plus a same-origin `Origin`:

```
GET  /api/setup                     readiness: key, Chromium, Node, mapd
POST /api/setup                     {apiKey, provider} → writes .env    token
GET  /api/fs/list?path=             directories only, contained         token
POST /api/fs/pick                   open the OS folder dialog           token
GET  /api/probe                     live dev-server scan, with titles
GET  /api/estimate?repo=&target=    cost, ETA, call count — no spend
GET  /api/run/status                the run in flight, if any
POST /api/run/start                 {target, repoPath, confirmCostUsd}  token
POST /api/run/cancel                SIGTERM the run's process group     token
GET  /api/run/events                SSE: stdout + run.log, live
GET  /demo.mp4                      the walkthrough, if one is installed
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `USERTESTS_API_KEY is not set` | add it to `.env` in the repo root, or export it |
| LLM auth error | wrong key for the chosen `USERTESTS_PROVIDER` — they are not interchangeable |
| `Multiple local servers are running` | pass `--target http://localhost:<port>` |
| Target unreachable | start your dev server first; the CLI validates before spending anything |
| Browser errors on launch | `npx playwright install chromium` |
| Architecture tab says *no code graph* | mapd isn't on npm yet — build it from source, or paste the repo's absolute path into the box (older runs didn't record it) |
| `usertests: command not found` | `npm link`, or call `node dist/cli.js` / `npx tsx src/cli.ts` |
| Run stopped early | a cap in `limits:` was hit — the chair still reports what was gathered and marks the run `PARTIAL` |
| Port 7842 in use | `usertests serve --port 7900` |

## How it works

1. **Validate first, spend later** — the CLI checks the target URL is reachable
   and all persona files exist before a single LLM token is spent.
2. **Council of testers (sequential)** — each persona gets a fresh Playwright
   session and runs an observe → think → act loop, capped by
   `max_steps_per_agent`. Agents may only act through a closed action set
   (`goto, click, type, pressKey, scroll, hover, goBack, screenshot`), so every
   behavior is auditable and replayable.
3. **What agents "see"** — a compact accessibility-tree-style DOM snapshot
   (interactive elements with roles, labels, selectors; token-budget-capped)
   plus a screenshot.
4. **Personas are Markdown, not code** — behavior is tuned by editing files in
   `personas/`, never by touching agent logic. `first-time-user` deliberately
   receives **no** repo context; `goal-gap-auditor` receives the full briefing.
5. **Chair** — one LLM call dedupes (same root cause = one finding, all finders
   credited) and ranks by severity. Findings at or above
   `min_severity_to_verify` are then **mechanically replayed** from the source
   persona's recorded action log in a fresh browser — no LLM judgment involved.
   Confirmed → main report; failed → appendix as *unverified*. Minor findings
   are never replayed; they land in the appendix with the reason.
6. **Output is files** — everything in `runs/<ISO-timestamp>/`, as above.

### What it handles for you

**Spending and failure.** A pre-run estimate prints expected LLM calls and cost,
warning if it exceeds your cap. `limits.max_llm_calls` / `limits.max_cost_usd`
stop spending mid-run, and the affected persona keeps what it already gathered.
If a persona crashes, the budget is hit, or the wall-clock deadline passes, the
chair still runs and `REPORT.md` is marked `Status: PARTIAL` with a per-persona
reason. Transient LLM errors (network, 429, 5xx) retry up to 3 times with
exponential backoff honoring `Retry-After`, under a per-call timeout. Failures
name their category and a fix — config errors say which key is wrong, target
errors say to start the app, browser errors say to run `playwright install`.

**Day to day.** Each run hashes its findings, so the next one prints `N of M
findings are NEW since last run`. A live step counter shows progress with an ETA
derived from prior runs' `run.log` files. `--watch` re-runs on file changes. A
terminal bell and macOS notification fire on completion, so you can walk away.
Every `run.log` records the SHA-1 of each persona file, making results
attributable to prompt versions. Only the newest `limits.keep_runs` folders are
kept.

**Report quality.** Each finding notes whether one persona saw it (⚠) or several
corroborated it (✓). After replay, one batched chair call drops confirmed
findings whose claim contradicts the end-of-replay page snapshot — demoted to
the appendix, never deleted (`chair.false_positive_pruning: false` to disable).
Replays wait for selectors and tolerate navigation, with no fixed sleeps. Set
`full_page_screenshots: true` for entire pages instead of viewport-only shots.

## Development

Work straight from source with `npx tsx src/cli.ts …` — no build step needed
while iterating. Dependencies are exactly `playwright`, `commander`, `yaml`,
`dotenv`, and one provider SDK (`@anthropic-ai/sdk`). Nothing else. The
dashboard is a single static `dashboard/index.html` with no build pipeline and
no CDN calls.

**Regression gates.** `npm test` is deterministic and free: it compiles strict
TypeScript, tests configuration/report/artifact safety, exercises the dashboard
API, and renders every dashboard surface in Chromium at desktop and mobile
widths. Run it before every push.

`npm run acceptance` is the live model-quality gate. It runs the full council
against the fixture and requires at least four of five planted issues to appear
as structured main/goal-gap findings. Appendix items and replay-rejected false
positives do not count. This spends real tokens, so it is intentionally separate
from the default suite.

<details>
<summary>Verifying the chair's repro gate yourself</summary>

To prove the chair rejects fabricated findings, seed one: edit a persona's
`findings/<persona>.json` in a completed run folder to add a finding whose
`atStep` points past the end of the action log (or references actions that can't
replay), then re-run the chair stage. It lands in
`## Appendix: Unverified Findings` with the reason.
</details>

**Deliberate product boundaries:** testers run sequentially; authenticated flows
and multiple device profiles require project-specific setup; results remain
local files rather than a hosted database. The package is prepared for local
linking or an npm tarball, but publishing it to a registry is a release-owner
decision.
