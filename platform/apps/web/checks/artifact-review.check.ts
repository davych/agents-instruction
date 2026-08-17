import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactRevisionByteLength,
  artifactRevisionContentInvalid,
  currentArtifactHeadIds,
  isArtifactHeadsChangedError,
  isArtifactRevisionRefreshError,
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
