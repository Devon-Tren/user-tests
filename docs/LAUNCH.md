# Launch runbook — the focused afternoon

One session, one goal: **User-Tests is public and installable.**

Read `HANDOFF.md` for *what the thing is*. This file is only the path to
publication, in order, with the decisions that need a human marked.

---

## Preflight (verified 2026-09-21)

| | state |
|---|---|
| Branch | `feat/onboarding-front-end`, **9 commits ahead of `main`**, pushed |
| Tests | **35 unit + 6 dashboard, 0 failures** |
| Working tree | clean |
| Package | `npm pack` → 194 KB, 34 files, contents correct |
| Clean install | ✅ CLI runs, dashboard serves, all vendor routes 200 |
| Acceptance gate | 4/5 on 2026-09-21 (threshold is 4 — **zero margin**) |
| npm auth | ❌ **not logged in** (`E401`) |
| Repo | **private** |
| mapd on npm | ❌ not published |
| Real run through the UI | ❌ **never done** |

---

## Step 0 — PARTLY DONE (2026-09-22)

**A real council run completed end to end against mitri-v23-2.**

```
run      runs/2026-09-22T03-29-12.058Z
target   http://localhost:5191 (mitri, vite dev server)
estimate ~$0.20 typical / $0.30 ceiling
ACTUAL   $0.1472 — 18 calls, 14 steps, 4 personas, quick pass
finding  M-1 "Textbox is unresponsive to typing" (major, replay-confirmed)
leak     clean — no key anywhere in the run folder
```

So the spend path is real and verified: spawn -> run.log tailing -> chair ->
report, plus the calibrated estimate landing 1.36x over actual (it was 3.4x
before calibration). mitri renders fine in a plain browser (403 chars, 10
interactive elements, no page errors) but `window.electron` is absent, so that
finding is probably real-in-browser and not real-in-Electron — worth checking
before acting on it.

**What is still NOT verified, and needs one human click:**

The run above was started through `POST /api/run/start`, not by clicking the
button. In headless Chromium a Playwright mouse click on **Start the run**
produces no click event at all — not even on a `document` capture listener —
while `element.click()` on the same node fires the handler correctly and other
buttons on the same page (Re-probe) click fine. Ruled out: the node is topmost
at its own centre (`elementsFromPoint`), position is stable, it is enabled and
in the viewport, `force: true` changes nothing, and disabling every
transform/transition changes nothing.

This is either a headless-harness artifact or a real click-target bug. It
cannot be settled from a script. **Open the dashboard, fill in a project and a
target, and click Start.** If the Running view appears, it is a harness
artifact and Step 0 is fully done. If nothing happens, it is a real bug and it
blocks launch — the primary path would be dead for every user.

---

## Step 0b — the rest of the live checks

Still worth doing once, whichever way the click goes.

It is the only untested path end to end: spawn → live feed → cancel → report
handoff. All of it is covered deterministically against a fake CLI, but no real
money has gone through the button.

```bash
npm run build && node dist/cli.js serve --port 7844
```

Then in the browser: Start → pick this repo → the probe finds nothing, so use
**▶ Start it for me** (or point it at the fixture: `npm run fixture:serve`,
:4173) → choose **one tester** + **Quick pass** → confirm ~$0.15 → Start.

Watch for:
- the live feed filling before the run folder exists (stdout relay)
- **spend so far** climbing
- Cancel leaving no orphaned Chromium (`pgrep -f chromium`)
- **"Open the report"** landing you on the finished run — this hand-off has
  only ever run against synthetic events

Then confirm nothing leaked:
```bash
grep -ril 'sk-' runs/<new-run>/run.log && echo LEAK || echo clean
```

**If this step fails, stop.** Everything below assumes it passed.

---

## Step 1 — Merge to main

```bash
git checkout main && git merge --ff-only feat/onboarding-front-end
USERTESTS_SKIP_ACCEPTANCE=1 git push
```

Skipping the gate is defensible **only** because the acceptance council was
evidenced at 4/5 this session and nothing since has touched `personas/`, the
chair, or the runner. If Step 0 changed any of those, drop the flag and let it
run (~$1.50, ~13 min).

`http.postBuffer` is already set to 500 MB locally — the 12 MB walkthrough
video exceeds git's 1 MB default and pushes fail with `HTTP 400` without it. A
fresh clone elsewhere hits the same wall.

---

## Step 2 — Decide: does User-Tests itself go on npm?

**This is a real decision, not a formality.** Publishing makes
`npm i -g user-tests` true and moots most of the README's install section
(clone → install → build → link). Not publishing keeps it a clone-only tool.

The name is free. `0.1.0` is burned permanently the moment you publish.

If yes:
```bash
npm login
npm publish --dry-run     # read the file list ONE more time
npm publish
```
Then rewrite README "Install" to lead with the one-liner and demote the
from-source flow to a `<details>` block.

---

## Step 3 — mapd: publish it, or stop referencing it

The README points at mapd; `registry.npmjs.org/mapd` **404s**. Two honest
options, pick one:

- **Publish it.** It is prepped and verified (see `HANDOFF.md` §10). Burns
  `0.19.0`.
- **Say it is source-only.** One line in the README. Takes a minute.

Leaving it as-is ships a lie to the first person who tries it. The Setup screen
already calls mapd optional, so nothing breaks either way.

---

## Step 4 — Flip public

```bash
gh repo edit Devon-Tren/user-tests --visibility public
```

**Before you do**, this is effectively irreversible in practice — clones and
forks exist from that moment. Two minutes of diligence:

```bash
git log --all --oneline -- .env                       # expect: nothing
git grep -I -n 'sk-proj\|sk-ant' $(git rev-list --all) -- 2>/dev/null | head
```

Both were clean on 2026-09-21. Re-run them anyway; Step 0 added a new run
folder and `runs/` is gitignored, but confirm.

---

## Known-and-accepted, ship anyway

Say these out loud rather than discovering them post-launch.

- **`?repo=` produces a wrong answer.** The Project digest fuses the run's
  findings with the override repo's architecture — one description of two
  projects. Costs ~$0.02 and is the only thing left that makes the tool *lie*.
  Not a launch blocker; is a credibility blocker if someone hits it.
- **Journey overflows 2.3× on a phone** (897px SVG at 390px). Pre-existing.
  The responsive assertion only ever ran against History.
- **Acceptance sits exactly on its threshold.** 4/5 with zero margin, and the
  unlabeled-input miss was genuine. One unlucky run fails the gate honestly.
  Either nudge the a11y persona or widen the threshold on more than one sample.
- **`.env` is mode 644.** `chmod 600 .env`.
- **Rotate `OPENAI_API_KEY`** — printed into a transcript on 2026-09-21
  (assistant error). Never in git; verified.

---

## Traps that will cost you time

1. **`git push` runs the acceptance council** (~$1.50, ~13 min) when `src/`,
   `scripts/`, `personas/`, `tests/fixture-app/` or `council.config.yaml`
   change. `USERTESTS_SKIP_ACCEPTANCE=1` bypasses it.
2. **A `PreToolUse` hook blocks printing credential files** — see
   `~/.claude/hooks/block-secret-reads.sh`. Metadata (`ls`, `stat`, `wc -l <`)
   and writes (`cat > .env`) still work. Testing anything that mentions a
   credential path needs the path in a shell variable, or the guard blocks the
   test command itself.
3. **Tests touching a page with video need `domcontentloaded`**, not
   `networkidle` — a streaming video means the page is never idle.
4. **`npm test` is free. `npm run acceptance` is not.**

---

## Definition of done

- [ ] A real run completed from the UI, report opened, no key in `run.log`
- [ ] `main` fast-forwarded and pushed
- [ ] npm decision made and acted on (publish, or README says clone-only)
- [ ] mapd decision made and acted on
- [ ] Repo public
- [ ] README's first 20 lines are true for someone who has never seen this
