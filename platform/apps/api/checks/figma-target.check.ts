import assert from "node:assert/strict";
import test from "node:test";

import type { FigmaPlanCapabilitiesDto } from "@ai-sdlc/contracts";

import {
  requireFigmaTarget,
  resolveExistingFigmaTarget,
  resolveNewPrivateDraftTarget,
} from "../src/services/workflow-service.ts";

const plans: FigmaPlanCapabilitiesDto = {
  provider: "figma",
  plans: [
    { key: "team::100", name: "Personal", seat: "Full", tier: "starter", writable: true },
    { key: "team::200", name: "Read only", seat: "View", tier: "starter", writable: false },
  ],
};

test("requires an explicit Figma target before an execution can be created", () => {
  assert.throws(
    () => requireFigmaTarget(undefined),
    (error: unknown) => (error as { code?: string }).code === "FIGMA_TARGET_REQUIRED",
  );
});

test("selects an exact fresh writable plan and rejects View seats", () => {
  assert.deepEqual(resolveNewPrivateDraftTarget({
    mode: "new_private_draft",
    planKey: "team::100",
    fileName: "Checkout flow",
  }, plans), {
    mode: "new_private_draft",
    planKey: "team::100",
    fileName: "Checkout flow",
  });
  assert.throws(
    () => resolveNewPrivateDraftTarget({
      mode: "new_private_draft",
      planKey: "team::200",
      fileName: "Cannot write",
    }, plans),
    (error: unknown) => (error as { code?: string }).code === "FIGMA_PLAN_READ_ONLY",
  );
  assert.throws(
    () => resolveNewPrivateDraftTarget({
      mode: "new_private_draft",
      planKey: "team::999",
      fileName: "Stale plan",
    }, plans),
    (error: unknown) => (error as { code?: string }).code === "FIGMA_PLAN_NOT_AVAILABLE",
  );
});

test("canonicalizes official existing design URLs and rejects unsafe variants", () => {
  assert.deepEqual(resolveExistingFigmaTarget({
    mode: "existing_file",
    fileUrl: "https://figma.com/design/AbC_123/Demo?node-id=10-20&t=secret",
  }), {
    mode: "existing_file",
    fileUrl: "https://www.figma.com/design/AbC_123?node-id=10-20",
    fileKey: "AbC_123",
    nodeId: "10:20",
  });
  assert.equal(resolveExistingFigmaTarget({
    mode: "existing_file",
    fileUrl: "https://www.figma.com/file/Legacy123/Old-file",
  }).fileKey, "Legacy123");

  for (const fileUrl of [
    "http://figma.com/design/abc123/Demo",
    "https://evil.figma.com/design/abc123/Demo",
    "https://user:pass@figma.com/design/abc123/Demo",
    "https://figma.com:444/design/abc123/Demo",
    "https://figma.com/design/abc123/branch/branch456/Demo",
    "https://figma.com/design/abc123/%62ranch/branch456/Demo",
    "https://figma.com/design/abc123%2Fother/Demo",
  ]) {
    assert.throws(
      () => resolveExistingFigmaTarget({ mode: "existing_file", fileUrl }),
      (error: unknown) => (error as { code?: string }).code === "FIGMA_FILE_URL_INVALID",
      fileUrl,
    );
  }
});
