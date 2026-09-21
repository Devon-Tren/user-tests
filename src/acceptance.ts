/** Deterministic scoring for the deliberately broken fixture application. */

export interface AcceptanceFinding {
  code?: string;
  section?: string;
  title?: string;
  category?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  repro?: string;
}

export interface AcceptanceResult {
  name: string;
  found: boolean;
  code: string | null;
}

interface PlantedIssue {
  name: string;
  matches: (finding: AcceptanceFinding, text: string) => boolean;
}

const PLANTED_ISSUES: PlantedIssue[] = [
  {
    name: 'Dead "Save Draft" button',
    matches: (_f, text) => /save\s*draft/i.test(text) && /(nothing|no feedback|no response|does not|did not|dead|unresponsive|fail)/i.test(text),
  },
  {
    name: "Empty-submit white screen",
    matches: (_f, text) =>
      /(sign\s*up|submit|form)/i.test(text)
      && /(empty|blank|required|without (?:an )?email|without (?:a )?password)/i.test(text)
      // "blank screen" is how models most often describe a wiped DOM, and the
      // adjective in "no interactive elements" used to break the last branch.
      // Both are the planted white-screen bug; only the wording differs.
      && /(white\s*screen|blank\s*(?:page|screen)|crash|disappear|no [\w\s-]{0,20}?(?:elements|ui|content)\b)/i.test(text),
  },
  {
    name: "Unlabeled email input",
    matches: (_f, text) =>
      /(email|input)/i.test(text) && /(unlabel|missing (?:an? )?(?:accessible )?label|no (?:accessible )?label|aria-label|placeholder.*(?:only|not a label))/i.test(text),
  },
  {
    name: "Missing Export feature (goal gap)",
    matches: (finding, text) =>
      /export/i.test(text)
      && (finding.section === "goal-gap" || finding.category === "goal-gap" || /(missing|unavailable|not (?:present|implemented|found)|cannot)/i.test(text)),
  },
  {
    name: "Keyboard focus trap",
    matches: (_f, text) =>
      /(focus trap|keyboard trap|trapped focus|focus (?:is |gets )?(?:stuck|trapped)|cannot (?:tab|move focus)|tab key.{0,40}(?:stuck|cycle|trap))/i.test(text),
  },
];

function findingText(finding: AcceptanceFinding): string {
  return [
    finding.title,
    ...(finding.steps ?? []),
    finding.expected,
    finding.actual,
  ].filter(Boolean).join("\n");
}

/**
 * Score only reportable findings. Appendix/replay-rejected items are evidence
 * that the product correctly rejected a false positive, not that it found a bug.
 */
export function evaluateFixtureAcceptance(findings: AcceptanceFinding[]): AcceptanceResult[] {
  const eligible = findings.filter((finding) =>
    (finding.section === "main" || finding.section === "goal-gap")
    && finding.repro !== "failed"
    && finding.repro !== "contradicted"
  );
  return PLANTED_ISSUES.map((issue) => {
    const hit = eligible.find((finding) => issue.matches(finding, findingText(finding)));
    return { name: issue.name, found: hit !== undefined, code: hit?.code ?? null };
  });
}

export const FIXTURE_ACCEPTANCE_MINIMUM = 4;
