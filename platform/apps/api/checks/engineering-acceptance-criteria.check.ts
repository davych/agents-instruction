import assert from "node:assert/strict";
import test from "node:test";

import { resolveEngineeringAcceptanceCriteria } from "../src/domain/engineering-acceptance-criteria.ts";

const approvedStories = {
  artifactKey: "user-stories",
  sourceStatus: "approved" as const,
  content: `## pinyin/US-001-level/story.md

# US-001: Choose a level

## Acceptance criteria

### US-001-AC-01: The learner can choose an unlocked level

### US-001-AC-02：The chosen level opens

## pinyin/US-002-progress/story.md

# US-002: Continue learning

### US-002-AC-01 - Completion unlocks the next level
`,
};

test("AC-CLARITY-006: structured Change Contract criteria remain authoritative", () => {
  assert.deepEqual(resolveEngineeringAcceptanceCriteria({
    changeContractCriteria: ["  AC-CC-001: observable contract  "],
    selectedArtifacts: [approvedStories],
  }), ["AC-CC-001: observable contract"]);
});

test("AC-CLARITY-006: approved selected User Stories supply stable legacy criteria", () => {
  assert.deepEqual(resolveEngineeringAcceptanceCriteria({
    selectedArtifacts: [approvedStories],
  }), [
    "US-001-AC-01: The learner can choose an unlocked level",
    "US-001-AC-02: The chosen level opens",
    "US-002-AC-01: Completion unlocks the next level",
  ]);
});

test("AC-CLARITY-007: unapproved, unselected, or unstable prose cannot become authority", () => {
  assert.deepEqual(resolveEngineeringAcceptanceCriteria({
    selectedArtifacts: [
      { ...approvedStories, sourceStatus: "awaiting_review" as const },
      {
        artifactKey: "implementation-notes",
        sourceStatus: "approved" as const,
        content: "### US-999-AC-01: engineer-authored claim",
      },
      {
        artifactKey: "user-stories",
        sourceStatus: "approved" as const,
        content: `## misc/story.md\n\n# A story without a stable ID\n\n### Acceptance: vague prose`,
      },
    ],
  }), []);
});
