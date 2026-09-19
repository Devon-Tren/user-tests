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
