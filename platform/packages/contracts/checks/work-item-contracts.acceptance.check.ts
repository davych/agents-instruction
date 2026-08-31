import assert from "node:assert/strict";
import test from "node:test";

import {
  changeContractSchema,
  resolveWorkItemSchema,
  workItemAdapterSummarySchema,
  workItemDraftSchema,
} from "../src/index.ts";

const fingerprint = "a".repeat(64);
const source = {
  kind: "mcp" as const,
  adapterId: "linear-main",
  adapterLabel: "Linear",
  reference: "ENG-142",
  externalId: "ENG-142",
  url: "https://linear.app/example/issue/ENG-142",
  fetchedAt: "2026-08-27T08:00:00.000Z",
  fingerprint,
};

test("Work Item contracts expose only a safe adapter summary and strict resolve input", () => {
  assert.deepEqual(workItemAdapterSummarySchema.parse({
    id: "linear-main",
    label: "Linear",
    kind: "mcp-stdio",
    configured: true,
    message: null,
  }), {
    id: "linear-main",
    label: "Linear",
    kind: "mcp-stdio",
    configured: true,
    message: null,
  });
  assert.equal(resolveWorkItemSchema.safeParse({
    adapterId: "linear-main",
    reference: "ENG-142",
  }).success, true);
  assert.equal(resolveWorkItemSchema.safeParse({
    adapterId: "linear-main",
    reference: "ENG-142",
    command: "/bin/sh",
  }).success, false);
});

test("normalized Work Item provenance can be frozen into a Change Contract", () => {
  const draft = workItemDraftSchema.parse({
    source,
    title: "Add audit export",
    description: "Admins need a filtered audit export.",
    suggestedWorkType: "feature",
    acceptanceCriteria: ["The exported rows match the active filters."],
    labels: ["audit", "backend"],
  });
  const contract = changeContractSchema.parse({
    workType: draft.suggestedWorkType,
    workItem: draft.source,
    summary: draft.title,
    currentBehavior: draft.description,
    expectedBehavior: "Admins can export filtered audit rows.",
    inScope: ["Audit export"],
    outOfScope: [],
    acceptanceCriteria: draft.acceptanceCriteria,
    regressionScope: ["Existing audit filters"],
    riskFlags: [],
    evidenceRefs: ["linear:ENG-142"],
  });
  assert.deepEqual(contract.workItem, source);
  assert.equal(workItemDraftSchema.safeParse({
    ...draft,
    source: { ...source, url: "file:///etc/passwd" },
  }).success, false);
});
