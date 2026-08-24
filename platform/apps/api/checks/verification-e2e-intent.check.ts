import assert from "node:assert/strict";
import test from "node:test";

import { freezeVerificationE2eIntent } from "../src/domain/verification-e2e-intent.ts";

const approvedStory = {
  id: "00000000-0000-4000-8000-000000000001",
  artifactKey: "user-stories",
  sourceStatus: "approved" as const,
  contentHash: "a".repeat(64),
  content: [
    "## docs/product/stories/example/story.md",
    "# US-001: Example",
    "### US-001-AC-01: visible success",
  ].join("\n"),
};

test("freezes Change Contract acceptance and regression IDs without implementation inputs", () => {
  const intent = freezeVerificationE2eIntent({
    changeContract: {
      workType: "feature",
      summary: "summary",
      currentBehavior: "old",
      expectedBehavior: "new",
      inScope: ["flow"],
      outOfScope: [],
      acceptanceCriteria: ["CC-AC-001: user sees success"],
      regressionScope: ["existing page remains usable"],
      riskFlags: [],
      evidenceRefs: [],
    },
    selectedArtifacts: [
      approvedStory,
      {
        ...approvedStory,
        id: "00000000-0000-4000-8000-000000000002",
        artifactKey: "implementation-notes",
        content: "private implementation transcript",
      },
    ],
  });

  assert.equal(intent.criteriaSource, "change_contract");
  assert.deepEqual(intent.criteria.map(({ id }) => id), ["CC-AC-001", "REG-001"]);
  assert.equal(intent.authoritativeArtifacts.some(({ artifactKey }) => artifactKey === "implementation-notes"), false);
});

test("legacy Runs resolve only stable ACs from approved user stories", () => {
  const intent = freezeVerificationE2eIntent({
    changeContract: null,
    selectedArtifacts: [approvedStory],
  });
  assert.equal(intent.criteriaSource, "approved_user_stories");
  assert.deepEqual(intent.criteria.map(({ id }) => id), ["US-001-AC-01"]);
});

test("legacy objective or unapproved stories cannot invent E2E scope", () => {
  assert.throws(
    () => freezeVerificationE2eIntent({
      changeContract: null,
      selectedArtifacts: [{ ...approvedStory, sourceStatus: "ready" as const }],
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "E2E_AUTHORITATIVE_CRITERIA_MISSING"
    ),
  );
});
