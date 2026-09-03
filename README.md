# User-Tests

A CLI tool that spins up a **council of LLM-driven agent personas** that act as a
user-testing group for a locally running web app. Each agent drives the app
through a real browser (Playwright), behaves according to its persona, and logs
findings. A **chair** agent then dedupes findings, verifies reproducibility by
mechanically replaying recorded steps in a fresh browser session, ranks
severity, and writes a single structured `REPORT.md` — the deliverable a
Product Owner reads before PI planning and sprint breakdown.

The tool targets general-purpose development: usability confusion,
goal-vs-delivery gaps, edge-case bugs, and accessibility/polish issues.

## Quick start

```bash
npm install
npx playwright install chromium   # one-time browser download
npm run build

export USERTESTS_API_KEY=sk-ant-…          # or put it in .env
# optional overrides:
# export USERTESTS_PROVIDER=anthropic      # anthropic (default) | openai
# export USERTESTS_MODEL=claude-sonnet-4-5
# export USERTESTS_BASE_URL=https://…      # any Anthropic- or OpenAI-compatible endpoint

node dist/cli.js run --target http://localhost:3000 --repo ./path/to/project
```

With a sane `council.config.yaml`, zero flags work — everything falls back to
config defaults:

```bash
usertests run                                  # uses config target/repo
usertests run --persona chaos-hunter           # single persona (prompt iteration)
usertests run --steps 5                        # quick sanity pass
usertests run --watch                          # re-run the council on every file change in repo_path
```

Or, after `npm link`, use the `usertests` binary directly:

```bash
usertests run --target http://localhost:3000 --repo ./path/to/project
```

### Try it against the deliberately-broken fixture app

```bash
npm run fixture:serve          # serves tests/fixture-app on http://localhost:4173
node dist/cli.js run --target http://localhost:4173 --repo tests/fixture-app
```

The fixture plants 5 issues (dead button, white-screening form, unlabeled
input, a documented-but-missing Export feature, and a keyboard focus trap).
The council's `REPORT.md` must surface at least 4 of the 5.

## How it works

1. **Validate first, spend later** — the CLI checks the target URL is reachable
   and all persona files exist before a single LLM token is spent.
2. **Council of testers (sequential)** — each persona gets a fresh Playwright
   session and runs an observe → think → act loop (capped by
   `max_steps_per_agent`). Agents may only act through a closed action set
   (`goto, click, type, pressKey, scroll, hover, goBack, screenshot`), so every
   behavior is auditable and replayable.
3. **What agents "see"** — a compact accessibility-tree-style DOM snapshot
   (interactive elements with roles, labels, selectors; token-budget-capped)
   plus a screenshot.
4. **Personas are Markdown, not code** — behavior is tuned by editing files in
   `personas/`, never by touching agent logic. `first-time-user` deliberately
   receives **no** repo context; `goal-gap-auditor` receives the full repo
   briefing (`README.md`, `GOALS.md`, `docs/goals.md`, `PRODUCT.md`).
5. **Chair** — one LLM call dedupes (same root cause = one finding, all finders
   credited) and ranks by severity. Findings at or above
   `min_severity_to_verify` are then **mechanically replayed** from the source
   persona's recorded action log in a fresh browser — no LLM judgment involved.
   Confirmed → main report; failed → appendix as *unverified*. Minor findings
   are never replayed; they land in the appendix as *unverified* with the reason.
6. **Output is files** — `runs/<ISO-timestamp>/` contains per-persona findings
   JSON + action logs, `shots/` screenshots, `run.log` (structured JSONL of
   every LLM call with token usage, duration, and cost), and the final
   `REPORT.md`.

## Reliability rails

- **Pre-run estimate** — expected LLM calls and cost are printed before the
  run starts, with a warning if the estimate exceeds your cost cap.
- **Hard caps** — `limits.max_llm_calls` / `limits.max_cost_usd` stop spending
  mid-run; the affected persona keeps the findings it already gathered.
- **Partial runs** — if a persona crashes, the budget is hit, or the
  wall-clock deadline passes, the chair still runs on whatever findings exist
  and `REPORT.md` is marked `Status: PARTIAL` with the reason per persona.
- **Retries & timeouts** — transient LLM errors (network, 429, 5xx) retry up
  to 3 times with exponential backoff (honoring `Retry-After`); every call has
  a `limits.llm_timeout_seconds` timeout.
- **Error taxonomy** — failures name their category and a fix: config errors
  say which key is wrong, target errors say to start the app, LLM errors say
  auth vs. rate-limit vs. timeout, browser errors say to run
  `npx playwright install chromium`.

## Daily-driver conveniences

- **NEW-since-last-run banner** — each run stores a hash of its findings
  (`findings-hashes.json`); the next run prints
  `N of M findings are NEW since last run`.
- **Progress + ETA** — live step counter per persona; ETA estimated from the
  seconds-per-step of prior runs' `run.log` files.
- **Watch mode** — `--watch` re-runs the council (debounced, serialized) on
  file changes in `repo_path` during active development.
- **Completion notification** — terminal bell + macOS notification when a run
  finishes, so you can walk away.
- **Persona versioning** — every run's `run.log` records the SHA-1 of each
  persona file, so results are attributable to prompt versions.
- **Disk hygiene** — only the newest `limits.keep_runs` run folders are kept.

## Report quality knobs

- **Corroboration** — each finding notes whether it was seen by a single
  persona (⚠) or corroborated by several (✓).
- **False-positive pruning** — after mechanical replay, one batched chair LLM
  call drops confirmed findings whose claim contradicts the end-of-replay page
  snapshot (demoted to the appendix, never deleted). Disable with
  `chair.false_positive_pruning: false`.
- **Full-page screenshots** — set `full_page_screenshots: true` to capture
  entire pages instead of viewport-only shots.
- **Replay hardening** — replays wait for selectors and tolerate navigation,
  no fixed sleeps.

## Regression gate

`npm run acceptance` is the harness: run it before pushing any change to
`src/` or `personas/` — it proves the council still surfaces ≥4 of the 5
planted fixture issues. A pre-push hook (`.git/hooks/pre-push`) runs it
automatically when council code, personas, config, or the fixture change;
bypass a failing gate deliberately with
`USERTESTS_SKIP_ACCEPTANCE=1 git push`.

## Configuration (`council.config.yaml`)

```yaml
target: http://localhost:3000   # overridable by --target
repo_path: .                    # overridable by --repo
max_steps_per_agent: 30         # overridable by --steps
viewport: { width: 1440, height: 900 }
limits:                         # safety rails (all optional, defaults shown)
  max_llm_calls: 150            # hard cap on LLM calls per run
  # max_cost_usd: 2.00          # hard USD budget; omit for no cost cap
  max_run_minutes: 45           # wall-clock limit
  llm_timeout_seconds: 120      # per-LLM-call timeout
  keep_runs: 20                 # prune older runs/ folders after each run
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
```

Add a tester by dropping a new `.md` into `personas/` and adding an entry under
`council.testers` — no code changes required.

## Swapping LLM providers

Only `src/llm.ts` knows about providers. Set env vars to switch backends with
zero code changes:

```bash
USERTESTS_PROVIDER=openai USERTESTS_MODEL=gpt-4o USERTESTS_API_KEY=sk-… usertests run …
# or any OpenAI-compatible endpoint:
USERTESTS_PROVIDER=openai USERTESTS_BASE_URL=https://my-gateway/v1 …
```

## Verifying the chair's repro gate

To prove the chair rejects fabricated findings, seed one: edit a persona's
`findings/<persona>.json` in a completed run folder to add a finding whose
`atStep` points past the end of the action log (or references actions that
can't replay), then re-run the chair stage. It lands in
`## Appendix: Unverified Findings` with the reason.

## Development

```bash
npm run smoke -- http://localhost:4173   # open page, screenshot, print DOM snapshot (no LLM)
npm run acceptance                        # full council run vs. fixture; asserts ≥4/5 planted issues surface
npm run build                            # strict TypeScript compile
```

Dependencies are exactly: `playwright`, `commander`, `yaml`, `dotenv`, and one
provider SDK (`@anthropic-ai/sdk`). Nothing else.

## Roadmap (explicit non-goals for this MVP)

Parallel agents, quick/full run modes, run-to-run diffing, auth/login flows,
mobile viewports, web dashboard, database, API server, npm publishing, Docker.
