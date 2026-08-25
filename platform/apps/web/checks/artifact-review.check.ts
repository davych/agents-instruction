import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactReviewHeadKey,
  artifactRevisionByteLength,
  artifactRevisionContentInvalid,
  currentArtifactHeadIds,
  isArtifactHeadsChangedError,
  isArtifactRevisionRefreshError,
  reviewExitPolicy,
  unviewedCurrentArtifactHeads,
  updateArchitectureSelectionMarker,
} from "../src/lib/artifact-review.ts";
import type { Artifact } from "../src/lib/types.ts";

test("review locking submits every current non-superseded artifact head", () => {
  const artifacts: Artifact[] = [
    { id: "prd-current", reviewStatus: "pending" },
    { id: "stories-old", reviewStatus: "superseded" },
    { id: "stories-current", reviewStatus: "pending" },
    { id: "legacy-old", superseded: true },
    { id: "prd-current", reviewStatus: "pending" },
  ];

  assert.deepEqual(currentArtifactHeadIds(artifacts), ["prd-current", "stories-current"]);
});

test("human review progress is bound to the current artifact id and content hash", () => {
  const artifacts: Artifact[] = [
    { id: "prd-current", contentHash: "sha-prd", reviewStatus: "pending" },
    { id: "stories-current", contentHash: "sha-stories", reviewStatus: "pending" },
    { id: "stories-old", contentHash: "sha-old", reviewStatus: "superseded" },
    { id: "missing-hash", reviewStatus: "pending" },
  ];
  const viewed = new Set([artifactReviewHeadKey(artifacts[0]!)!]);

  assert.equal(artifactReviewHeadKey(artifacts[0]!), "prd-current:sha-prd");
  assert.equal(artifactReviewHeadKey(artifacts[3]!), undefined);
  assert.deepEqual(
    unviewedCurrentArtifactHeads(artifacts, viewed).map(({ id }) => id),
    ["stories-current", "missing-hash"],
  );
  assert.deepEqual(
    unviewedCurrentArtifactHeads(
      [{ ...artifacts[0]!, contentHash: "sha-prd-v2" }],
      viewed,
    ).map(({ id }) => id),
    ["prd-current"],
  );
});

test("architecture option selection replaces only its standalone marker", () => {
  assert.equal(
    updateArchitectureSelectionMarker("风险可接受。\nSelected option: A\n需补监控负责人。", "B"),
    "风险可接受。\nSelected option: B\n需补监控负责人。",
  );
  assert.equal(
    updateArchitectureSelectionMarker("保留这段 Selected option: A 行内说明。", "C"),
    "保留这段 Selected option: A 行内说明。\nSelected option: C",
  );
  assert.equal(updateArchitectureSelectionMarker("", "A"), "Selected option: A");
});

test("review exit blocks pending work and confirms only dirty idle work", () => {
  assert.equal(reviewExitPolicy({ pending: true, dirty: false }), "block");
  assert.equal(reviewExitPolicy({ pending: true, dirty: true }), "block");
  assert.equal(reviewExitPolicy({ pending: false, dirty: true }), "confirm");
  assert.equal(reviewExitPolicy({ pending: false, dirty: false }), "allow");
});

test("only the artifact-head optimistic-lock response triggers conflict refresh", () => {
  assert.equal(
    isArtifactHeadsChangedError({ status: 409, code: "ARTIFACT_HEADS_CHANGED" }),
    true,
  );
  assert.equal(
    isArtifactHeadsChangedError({ status: 409, code: "ARTIFACT_REVISION_CONFLICT" }),
    false,
  );
  assert.equal(
    isArtifactHeadsChangedError({ status: 422, code: "ARTIFACT_HEADS_CHANGED" }),
    false,
  );
});

test("manual revision conflicts refresh only for supported 409 error codes", () => {
  for (const code of ["ARTIFACT_REVISION_CONFLICT", "ARTIFACT_WORKSPACE_DIVERGED"]) {
    assert.equal(isArtifactRevisionRefreshError({ status: 409, code }), true);
  }
  assert.equal(
    isArtifactRevisionRefreshError({ status: 409, code: "ARTIFACT_HEADS_CHANGED" }),
    false,
  );
  assert.equal(
    isArtifactRevisionRefreshError({ status: 422, code: "ARTIFACT_WORKSPACE_DIVERGED" }),
    false,
  );
  assert.equal(isArtifactRevisionRefreshError(new Error("conflict")), false);
});

test("manual revision size validation uses UTF-8 bytes like the API", () => {
  assert.equal(artifactRevisionByteLength("中"), 3);
  assert.equal(artifactRevisionContentInvalid("a".repeat(2_000_000)), false);
  assert.equal(artifactRevisionContentInvalid("a".repeat(2_000_001)), true);
  assert.equal(artifactRevisionContentInvalid("中".repeat(666_666)), false);
  assert.equal(artifactRevisionContentInvalid("中".repeat(666_667)), true);
  assert.equal(artifactRevisionContentInvalid(" \n\t "), true);
});
