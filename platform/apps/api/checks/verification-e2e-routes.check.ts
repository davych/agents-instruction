import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authorVerificationE2eSchema,
  configureE2eWorkspaceSchema,
  reviewVerificationE2eScriptsSchema,
  verificationE2eFlowActionSchema,
} from "../../../packages/contracts/src/index.ts";

test("API registers the complete linked E2E lifecycle with strict contract schemas", async () => {
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  for (const route of [
    "/api/projects/:id/e2e-workspace",
    "/api/projects/:id/e2e-workspace/prepare",
    "/api/runs/:id/verification/e2e-flow",
    "/api/runs/:id/verification/e2e-flow/author",
    "/api/runs/:id/verification/e2e-flow/script-review",
  ]) assert.match(source, new RegExp(route.replaceAll("/", "\\/"), "u"));
  assert.match(source, /configureE2eWorkspaceSchema\.parse/u);
  assert.match(source, /verificationE2eFlowActionSchema\.parse/u);
  assert.match(source, /authorVerificationE2eSchema\.parse/u);
  assert.match(source, /reviewVerificationE2eScriptsSchema\.parse/u);

  assert.equal(configureE2eWorkspaceSchema.parse({
    rootPath: "/tmp/separate-e2e",
    initialize: true,
    baseUrl: "http://127.0.0.1:4173",
    sourceStartScript: "dev",
  }).playwrightVersion, "1.62.1");
  for (const invalid of [
    { rootPath: "relative/e2e", baseUrl: "http://127.0.0.1:4173", sourceStartScript: "dev" },
    { rootPath: "/tmp/e2e", baseUrl: "http://user@127.0.0.1:4173", sourceStartScript: "dev" },
    { rootPath: "/tmp/e2e", baseUrl: "http://127.0.0.1:4173/#fragment", sourceStartScript: "dev" },
    { rootPath: "/tmp/e2e", baseUrl: "http://127.0.0.1:4173", sourceStartScript: "dev.start" },
  ]) assert.throws(() => configureE2eWorkspaceSchema.parse(invalid));
  assert.deepEqual(verificationE2eFlowActionSchema.parse({ action: "preflight" }), {
    action: "preflight",
  });
  assert.throws(() => authorVerificationE2eSchema.parse({ selectedArtifactIds: [] }));
  assert.throws(() => reviewVerificationE2eScriptsSchema.parse({
    decision: "approve",
    expectedPatchHash: "a".repeat(64),
    comment: "",
  }));
});

test("normal phase execution rejects verificationAction before any workspace mutation", async () => {
  const source = await readFile(
    new URL("../src/services/workflow-service.ts", import.meta.url),
    "utf8",
  );
  const mismatch = source.indexOf("VERIFICATION_ACTION_PHASE_MISMATCH");
  const firstWorkspaceMutation = source.indexOf(
    "const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath)",
    source.indexOf("async executePhase"),
  );
  assert.ok(mismatch > source.indexOf("async executePhase"));
  assert.ok(mismatch < firstWorkspaceMutation);
});
