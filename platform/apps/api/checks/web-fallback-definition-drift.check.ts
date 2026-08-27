import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import YAML from "yaml";

import {
  FALLBACK_PHASES,
  FALLBACK_ROLES,
  LEGACY_FALLBACK_CANONICAL_SOURCE,
  LEGACY_FALLBACK_CANONICAL_SEMANTIC_SHA256,
} from "../../web/src/lib/workflow.ts";

interface CanonicalDefinition {
  roles: Array<{
    id: string;
    name: string;
    mission: string;
    responsibilities: string[];
  }>;
  workflow: {
    phases: Array<{
      id: string;
      owner: string;
      inputs: string[];
      outputs: string[];
      gate: string;
    }>;
  };
}

test("Web legacy fallback structure and canonical semantic fingerprint match the initializer YAML", async () => {
  assert.equal(LEGACY_FALLBACK_CANONICAL_SOURCE, "templates/ai-native.yaml");

  const canonicalPath = new URL("../../../../templates/ai-native.yaml", import.meta.url);
  const canonicalSource = (await readFile(canonicalPath, "utf8"))
    .replace(/\{\{[A-Z_]+\}\}/gu, '"template-placeholder"');
  const canonical = YAML.parse(canonicalSource) as CanonicalDefinition;

  const canonicalSemanticJson = JSON.stringify({
    roles: canonical.roles.map(({ id, name, mission, responsibilities }) => ({
      id,
      name,
      mission,
      responsibilities,
    })),
    phases: canonical.workflow.phases.map(({ id, owner, inputs, outputs, gate }) => ({
      id,
      owner,
      inputs,
      outputs,
      gate,
    })),
  });
  const canonicalSemanticHash = createHash("sha256")
    .update(canonicalSemanticJson, "utf8")
    .digest("hex");
  assert.equal(
    LEGACY_FALLBACK_CANONICAL_SEMANTIC_SHA256,
    canonicalSemanticHash,
    "canonical role or gate semantics changed; review and synchronize the localized Web fallback before updating its SHA-256",
  );

  assert.equal(FALLBACK_ROLES.length, canonical.roles.length, "role count drifted");
  canonical.roles.forEach((role, index) => {
    const fallback = FALLBACK_ROLES[index];
    assert.ok(fallback, `missing Web fallback role ${role.id}`);
    assert.deepEqual(
      { id: fallback.id, name: fallback.name },
      { id: role.id, name: role.name },
      `Web fallback role identity drifted at ${role.id}`,
    );
  });

  const canonicalPhases = canonical.workflow.phases;
  assert.equal(FALLBACK_PHASES.length, canonicalPhases.length, "phase count drifted");
  canonicalPhases.forEach((phase, index) => {
    const fallback = FALLBACK_PHASES[index];
    assert.ok(fallback, `missing Web fallback phase ${phase.id}`);
    assert.deepEqual(
      {
        id: fallback.id,
        owner: fallback.owner,
        inputs: fallback.inputs,
        outputs: fallback.outputs,
      },
      {
        id: phase.id,
        owner: phase.owner,
        inputs: phase.inputs,
        outputs: phase.outputs,
      },
      `Web fallback phase graph drifted at ${phase.id}`,
    );
  });
});
