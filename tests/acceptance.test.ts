import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFixtureAcceptance } from "../src/acceptance.js";

test("acceptance requires semantically specific, reportable findings", () => {
  const results = evaluateFixtureAcceptance([
    {
      code: "M-1",
      section: "main",
      title: "Save Draft does nothing",
      actual: "Clicking Save Draft gives no feedback or response.",
      repro: "confirmed",
    },
    {
      code: "M-2",
      section: "main",
      title: "Email input has no accessible label",
      actual: "The placeholder is the only hint and is not a label.",
      repro: "confirmed",
    },
    {
      code: "G-1",
      section: "goal-gap",
      category: "goal-gap",
      title: "Documented Export feature is missing",
      actual: "Export is not implemented anywhere in the interface.",
      repro: "not-checked",
    },
    {
      code: "M-3",
      section: "main",
      title: "Keyboard focus trap in support banner",
      actual: "The Tab key cycles between two buttons and focus is trapped.",
      repro: "confirmed",
    },
    {
      code: "C-1",
      section: "main",
      title: "Empty signup submission crashes to a blank page",
      steps: ["Submit the form with empty email and password fields."],
      actual: "The application shows a white screen with no UI.",
      repro: "confirmed",
    },
  ]);

  assert.equal(results.filter((result) => result.found).length, 5);
  assert.deepEqual(results.map((result) => result.code), ["M-1", "C-1", "M-2", "G-1", "M-3"]);
});

test("acceptance excludes appendix false positives and unrelated uses of Tab", () => {
  const results = evaluateFixtureAcceptance([
    {
      code: "M-1",
      section: "main",
      title: "Email input is missing an accessible label",
      steps: ["Tab through the page to the email input."],
      actual: "The email input has only a placeholder.",
      repro: "confirmed",
    },
    {
      code: "A-1",
      section: "appendix",
      title: "App displays a completely blank page",
      actual: "The UI crashed.",
      repro: "contradicted",
    },
  ]);

  assert.equal(results.find((result) => result.name === "Unlabeled email input")?.found, true);
  assert.equal(results.find((result) => result.name === "Keyboard focus trap")?.found, false);
  assert.equal(results.find((result) => result.name === "Empty-submit white screen")?.found, false);
});

test("the white-screen matcher accepts how models actually word it", () => {
  // Regression: a real run (2026-09-21) surfaced planted bug #2 correctly and
  // the harness scored it MISSED, because the matcher demanded "white screen"
  // or "blank page" while the model wrote "blank screen" / "no interactive
  // elements". The council was right; the test was wrong. 3/5 vs a true 4/5.
  const asReported = [{
    code: "C-2",
    section: "main",
    severity: "critical",
    title: "Blank screen after attempting sign up",
    repro: "confirmed",
    steps: [
      "1. Go to the homepage.",
      "2. Click on the sign up button with empty fields.",
      "3. Observe the app transitions to a blank screen with no interactive elements.",
    ],
    expected: "Should remain on the sign up page and display validation errors for empty required fields.",
    actual: "App navigates to a blank, unusable screen with no way to recover except browser navigation.",
  }];
  const hit = evaluateFixtureAcceptance(asReported).find((r) => r.name === "Empty-submit white screen");
  assert.equal(hit?.found, true, "a correct detection must not be scored as a miss");
  assert.equal(hit?.code, "C-2");

  // The original phrasing must still match — widening, not replacing.
  const classic = [{
    section: "main",
    code: "C-9",
    repro: "confirmed",
    title: "Signup form white-screens on empty submit",
    steps: ["Submit the form empty"],
    expected: "validation errors",
    actual: "the app white screens",
  }];
  assert.equal(
    evaluateFixtureAcceptance(classic).find((r) => r.name === "Empty-submit white screen")?.found,
    true
  );

  // ...and it must still be possible to MISS it. A form complaint that is not
  // about a wiped DOM should not be credited as the planted crash.
  const unrelated = [{
    section: "main",
    code: "M-9",
    repro: "confirmed",
    title: "Signup form has no inline validation",
    steps: ["Submit the form with an empty email"],
    expected: "an inline error",
    actual: "the button just does nothing at all",
  }];
  assert.equal(
    evaluateFixtureAcceptance(unrelated).find((r) => r.name === "Empty-submit white screen")?.found,
    false,
    "the matcher must still be able to say no"
  );
});
