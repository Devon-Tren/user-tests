# Handoff — as of 2026-09-21

Current state of User-Tests, written so a fresh session can act without
re-deriving anything. Earlier versions of this file were a chronological log;
this one is a *state* document. Git history has the old narrative.

---

## 1. What this is, in one paragraph

A CLI that sends a council of LLM personas through a **live, locally-running**
web app in a real browser (Playwright), then has a chair agent dedupe, verify by
replay, rank, and write one `REPORT.md`. `usertests serve` is a dashboard over
past runs — and, as of this session, the front door for starting new ones.

Two facts constrain every design decision:

- **The app under test must already be running at a URL.** No UI removes this.
- **The tool spends real money.** ~$0.21 (one persona, quick pass) to ~$2.82
  (four personas, full run).

---

## 2. Where the code is right now

**Branch `feat/onboarding-front-end`, 3 commits, NOT pushed.**

```
4e17c42 docs: narrated walkthrough, played once inside the onboarding
c229e71 feat: onboarding front end — setup, launch and live progress
d1c52c5 refactor: share the probe and the estimate, redact secrets from run.log
```

Working tree clean. `npm test` green: **22 unit + 6 dashboard, 0 failures.**
Node 22, TypeScript strict, no build step for the dashboard.

### Modules added this session

| File | Role |
|---|---|
| `src/probe.ts` | `COMMON_PORTS`, `probeLocalServers()`, detailed variant reading `<title>`, `assertReachable()` — moved out of `cli.ts` so the server shares them |
| `src/estimate.ts` | `estimateRun()` / `formatEstimate()` — one arithmetic for CLI and UI |
| `src/setup.ts` | readiness checks; the only code that writes credentials |
| `src/browse.ts` | server-side folder listing, realpath containment (the *fallback* picker) |
| `src/pick.ts` | the OS folder dialog — `osascript` / PowerShell / `zenity` |
| `src/launch.ts` | `RunSupervisor` — spawn, tail, cancel |

New tests: `setup.test.ts` (5), `launch.test.ts` (3), `pick.test.ts` (2), plus
additions to `server.test.ts` and `dashboard.test.ts`.

### The Start surface

`dashboard/index.html` gained a **Start** tab with three states chosen from real
readiness, not wizard steps:

- **Setup** — only failing checks, each with its own fix
- **Launch** — pick project -> pick running app -> choose depth -> confirm cost
- **Running** — live feed, phase/personas/findings/spend/elapsed, cancel

It **takes the page over** (tab bar hidden) when the tool is not ready, there are
no runs, or a run is in flight. Otherwise it is the 10th tab.

A **one-time explainer** (`localStorage: usertests.welcome.v2`) opens on first
visit: the 1:41 narrated walkthrough, then four cards (crew / chair / caveats).
Re-openable via "How does this work?".

### New routes

```
GET  /api/setup       readiness + demoVideo flag      free, ungated
POST /api/setup       writes .env at 0600             token
GET  /api/fs/list     directories only, contained     token
POST /api/fs/pick     opens the OS folder dialog      token
GET  /api/probe       live dev-server scan            free
GET  /api/estimate    cost/ETA (&persona=, &steps=)   free, no network
GET  /api/run/status  the run in flight               ungated
POST /api/run/start   spawn (needs confirmCostUsd)    token
POST /api/run/cancel  SIGTERM the process group       token
GET  /api/run/events  SSE: stdout + run.log           ungated
GET  /demo.mp4        walkthrough, range-aware        free
```

---

## 3. Decisions not to re-litigate

**The run is a child process, not an in-process call.** `executeRun` closes over
CLI options and `configureLLM`'s budget is module-global — in-process would share
a budget counter with the viewer and let a Playwright crash take the dashboard
down. Spawning gives isolation, a real kill switch, identical `run.log`, and
required no refactor of the run path. `cwd` = the repo under test so a local
`council.config.yaml` wins. The key rides in `env`, **never argv** (`ps`).

**Progress needs two sources.** The run folder does not exist until config,
reachability and the estimate have passed, so stdout is relayed until it appears,
then the JSONL log is tailed from a byte offset. Events carry gapless `seq` so a
mid-run refresh replays only what it missed (`?since=`).

**The folder-path constraint had a third answer.** The old handoff concluded a
server-side browser was the only option because "a browser cannot hand a server a
folder path." True of the *browser* — but `serve` runs on the same machine, so the
**server** opens Finder and reads the path off it (`src/pick.ts`). The in-page
browser remains the fallback for headless/SSH; `/api/fs/list` reports
`nativePicker` so the UI knows which to offer.

**Containment has two rules.** Nothing may escape `browseRoot` (default `$HOME`,
override `--browse-root`) — *except* a folder chosen in the OS dialog, because the
dialog **is** the consent. The server records picked paths; `/api/run/start`
accepts those and only those from outside the root.

**Security: the server became an actuator.** Mutating routes require all three of
a per-process token substituted into the page, an `Origin` matching the request's
own `Host`, and `content-type: application/json` (forcing a preflight the origin
check then fails). `GET /api/fs/list` is gated too — it discloses filesystem
layout. `redactSecrets()` in `logger.ts` scrubs every event by field name *and*
value shape. **No CSP change was needed** — `EventSource` is covered by
`connect-src 'self'`.

**Depth is an outcome, not a number.** "Steps per persona" meant nothing to a
newcomer and defaulted to ~$1.80. It is now Quick pass vs Full run, each card
quoting its own live price, plus a persona picker (~$0.21 for one tester).

---

## 4. Bugs found and fixed this session

Each one is a trap that could recur.

- **Takeover was never recomputed after setup.** Finish setup and the tab bar
  stayed hidden. Fixed by recomputing in the save handler.
- **The preset and the price disagreed.** "Quick pass" was highlighted while the
  button charged the full-run price, because the default preset was set without
  its step count. Steps now derive from the preset through one `applyPreset()`.
  This is the worst class of bug on a control that spends money.
- **A regression test passed while completely broken.** It compared `NaN` to
  `NaN` and went green — `assert.equal` under `node:assert/strict` is `Object.is`,
  and `Object.is(NaN, NaN)` is `true`. The estimate had been 400ing throughout
  because the fixture lacked a `council.config.yaml`. Both fixed; the test now
  asserts prices are finite *first*.
- **The welcome key was unversioned.** Adding a slide to an explainer everyone
  had dismissed meant nobody would ever see it. `v1 -> v2`. Any future material
  change to the deck needs the same bump.
- **Tab was blocked inside the welcome dialog**, stranding keyboard users on
  whichever control had focus. Now a proper cycling focus trap.
- **`preload="auto"` pulled all 12 MB** of video on every first visit. Now
  `metadata`.

---

## 5. Traps (still true)

**1. `git push` costs ~$1.50 and ~13 minutes.** `.git/hooks/pre-push` runs the
full acceptance council when `src/`, `scripts/`, `personas/`,
`tests/fixture-app/` or `council.config.yaml` change. Bypass when the gate has
already passed:

```bash
USERTESTS_SKIP_ACCEPTANCE=1 git push
```

**2. Opening the dashboard with `?repo=` costs ~$0.02 and produces a WRONG
answer.** The Project tab's `project_digest` fuses *the run's* findings with *the
override repo's* architecture — a hybrid describing two projects at once. Still
unfixed. The Start screen sidesteps it (no LLM call on load) but does not fix it.
To inspect a repo with zero spend:

```bash
curl "http://localhost:7842/api/architecture?dir=<run>&repo=<abs-path>&fresh=1"
```

**3. Tests that touch a page with video need `domcontentloaded`,** not
`networkidle` — a streaming video means the page is never idle.

**4. `npm run acceptance` spends real tokens.** `npm test` is free and
deterministic.

---

## 6. What is NOT verified

Be honest about this with whoever picks it up.

- **Nobody has ever pressed Start on a real run.** Spawn, live feed, cancel and
  redaction are all covered deterministically against a fake `dist/cli.js`, but
  no real money has gone through the button. **This is the single biggest gap.**
- **The post-run handoff has never run live** — "Open the report" -> `selectRun`
  -> takeover reset only ever ran against synthetic events.
- **No clean-checkout install test.** Packing the real tarball and installing
  into an empty dir is the check that caught mapd's `files` omissions. Not done
  here.
- **Dead CSS is unmeasured.** A naive audit said 63% of selectors never match,
  but it skipped the welcome modal and findings states, so that number is junk.
  Needs a real instrumented pass before anyone deletes anything.

---

## 7. Aesthetic findings (measured, nothing acted on)

| | Now | Sane |
|---|---|---|
| `border-radius` values | **26** | 4-5 |
| `box-shadow` values | **68** | 3-4 |
| `font-size` values | **32** | 7-8 |
| Raw colour literals | **207 distinct** | ~0 |
| `var(--token)` uses | 311 | all |

~40% of colour bypasses the token system. `dashboard/index.html` is **318 KB**
(260 KB JS / 55 KB CSS / 3 KB markup), 561 rules, 22 animations, 73 box-shadows,
58 gradients, 11 backdrop-blurs.

**The bigger issue is split personality.** Start is bubbly (24px radii, pills,
emoji, springs); Architecture and Visual are deliberately austere drafting-table
— and that austerity is the *point* ("ELEV is the view to show someone senior").
Clicking between them feels like two products. Three ways out: warm the
analytics, cool the onboarding, or **own the split deliberately** (warm for
newcomers, austere for experts, with an intentional register change at the
boundary). The third is recommended.

**Ten tabs, four of which are graph views** (Journey / Mind Map / Architecture /
Visual). They fit at every width — this is a comprehension problem, not layout.
Candidate: one *Explore* tab with a view switcher, 10 -> 7.

---

## 8. Priority order

| # | Item | Effort | Why here |
|---|---|---|---|
| 1 | **Real run from the UI** | 20 min, ~$0.21 | Everything below assumes this chain works |
| 2 | **Clean-checkout install test** | ~1 hr | Catches `files` omissions |
| 3 | **Copy-able start command** in the empty port-probe state | ~15 min | Also the fallback auto-start needs |
| 4 | **Docs truth pass** | ~30 min | README still says `npm install -g mapd`, which does not exist |
| 5 | **Auto-start their dev server** | ~half day | Removes the last cliff; build on the spawn path *after* 1-3 |
| 6 | **Design token pass** | ~half day | Do before further UI work or you add to the pile |
| 7 | **Tab consolidation** | ~1 day | Real win, highest regression risk |
| 8 | **Trap 2** (`?repo=` hybrid digest) | ? | The only item that makes the tool *lie* |

Items 1-4 are one afternoon and are what stands between "typechecks" and "shipped".

**On #5 — can User-Tests start their app?** Yes, and unlike cloning a GitHub URL
this is defensible: it is *their* repo, *their* declared npm script, on *their*
machine. Read `package.json` -> find `scripts.dev` -> show the literal command ->
explicit click -> spawn in the run's process group -> stream stdout into the same
feed -> poll the port, ~90s timeout -> kill when the run ends. Honest failure
modes: deps not installed, missing env vars, a different port than declared.

---

## 9. Publishing and deployment

**Verified state:** repo `Devon-Tren/user-tests` is **private**. Both npm names
(`user-tests`, `mapd`) are **free**. `npm pack --dry-run` = **192 KB, 34 files**
(the 12 MB video correctly excluded). **Not logged into npm** (`E401`).

### The architectural fact

The council drives a real browser at a live URL and needs an API key. Both are
local-first. That yields three different products:

1. **Distribute it (what exists).** npm + GitHub, BYO key. **Costs $0 forever.**
   Already a complete free product.
2. **Host the UI, BYO key.** Requires the user's app to be *publicly reachable* —
   breaks the premise for the solo-dev audience. Skip.
3. **Managed hosting.** You run headless browsers and pay tokens: **~$0.20-$2.80
   per run** plus compute. Real infrastructure, real per-user cost.

### The free-tier insight

**Half the tool already costs nothing.** Architecture and Visual are pure static
analysis via mapd — zero LLM calls. Only `project_digest` (~$0.02) spends.

> **Free:** see your codebase mapped — blueprint, hotspots, coverage gaps, 3D
> atlas. Zero marginal cost, no API key needed.
> **Paid / BYO-key:** run the council.

That makes mapd strategically important rather than an optional accelerator.

If you do want to give away real runs: **one free single-persona quick pass is
about $0.21**, so 1,000 signups is about $210. That is only affordable *because*
of the preset work — at the old 30-step default it would have been $1,800.

**Recommendation:** ship model 1, build no infrastructure yet. Watch whether the
free static-analysis tier pulls people in before paying for cloud browsers.

---

## 10. Open items

- [ ] **Press Start once for real** (~$0.21) — the biggest unverified path
- [ ] Push `feat/onboarding-front-end` (`USERTESTS_SKIP_ACCEPTANCE=1`, suite is green)
- [ ] Clean-checkout install test
- [ ] `npm publish` mapd — prepped and verified, never run. Burns `0.19.0`.
- [ ] Decide whether User-Tests itself goes on npm (moots half the README)
- [ ] Flip public: `gh repo edit Devon-Tren/user-tests --visibility public`
- [ ] README still promises `npm install -g mapd`
- [ ] Trap 2: `?repo=` still writes a hybrid `project.json`
- [ ] `.env` is mode `644` — `chmod 600 .env`
- [ ] **Rotate `OPENAI_API_KEY`.** It was printed into a session transcript by a
      `sed` over `.env` (assistant error). Never in git — verified across all
      history — but it sits in `~/.claude/projects/.../*.jsonl` in plaintext.

---

## 11. Assets

- `docs/user-tests-walkthrough.mp4` — 1:41, 1920x1080 @ 50fps, 12 MB. Nova
  (OpenAI TTS) narration, synthesised score and click SFX, sidechain-ducked. In
  `docs/`, **not** in `package.json` `files`.
- The film pipeline (shoot script, score generator, TTS wrapper) lived in a
  scratch dir and is **not** committed. Re-derivable from this doc if needed:
  Playwright records 25fps at native 1080p with `body{zoom:1.35}` and overlays
  hosted on `<html>` so cursor coordinates stay true; ffmpeg `minterpolate`
  25->50 (an exact doubling, far cleaner than 25->60); scene marks are measured
  at shoot time and the narration is placed against them.
