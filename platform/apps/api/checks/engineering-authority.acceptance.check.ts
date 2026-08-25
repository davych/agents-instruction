import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import {
  assertImplementationReady,
} from "../src/domain/implementation-readiness.ts";
import { resolveEngineeringAcceptanceCriteria } from "../src/domain/engineering-acceptance-criteria.ts";

// Isolation tier: A — derived from AC-WF-001/002 and public domain functions.

const stableStories = {
  artifactKey: "user-stories",
  sourceStatus: "approved" as const,
  content: [
    "## stories/US-241-checkout/story.md",
    "# US-241: Apply a coupon",
    "### US-241-AC-01: A valid coupon updates the visible order total",
    "### US-241-AC-02: An invalid coupon leaves the prior total unchanged",
  ].join("\n"),
};

test("AC-WF-001/002/Tier A: generic legacy criteria cannot override stable approved Story ACs", () => {
  assert.deepEqual(resolveEngineeringAcceptanceCriteria({
    changeContractCriteria: [
      "The feature works as expected.",
      "Ensure the page is correct.",
      "Support the requested behavior.",
    ],
    selectedArtifacts: [stableStories],
  }), [
    "US-241-AC-01: A valid coupon updates the visible order total",
    "US-241-AC-02: An invalid coupon leaves the prior total unchanged",
  ]);
});

test("AC-WF-001/002/Tier A: implementation is blocked when neither contract nor Stories have executable ACs", () => {
  assert.throws(
    () => assertImplementationReady({
      changeContractCriteria: ["Works as expected", "Handle errors", "Looks correct"],
      selectedArtifacts: [{
        artifactKey: "user-stories",
        sourceStatus: "approved",
        content: "# Legacy story\n\n### Acceptance: meet the requirements\n",
      }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "IMPLEMENTATION_NOT_READY");
      const details = error.details as {
        acceptanceCriteriaCount?: number;
        issues?: Array<{ code?: string }>;
      };
      assert.equal(details.acceptanceCriteriaCount, 0);
      assert.ok(details.issues?.some(({ code }) => code === "ACCEPTANCE_CRITERIA_MISSING"));
      return true;
    },
  );
});
