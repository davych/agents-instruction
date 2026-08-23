import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createTaskArtifactNamespace,
  pinExistingTaskArtifactPaths,
  resolveTaskArtifactPaths
} from "../src/domain/task-artifact-paths.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";

const firstRunId = "550e8400-e29b-41d4-a716-446655440000";
const secondRunId = "550e8400-e29b-41d4-a716-446655440001";
const projectRoot = path.resolve("/projects/demo");
const engineeringEvidenceKeys = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
] as const;

test("uses a readable Chinese task title and the full run id for the design spec", () => {
  const definition = sampleDefinition();
  const resolved = resolveTaskArtifactPaths(definition, {
    id: firstRunId,
    title: "用户可以使用邮箱登录"
  });
  const spec = resolved.artifacts.find((artifact) => artifact.id === "design-spec");

  assert.equal(
    createTaskArtifactNamespace({ id: firstRunId, title: "用户可以使用邮箱登录" }),
    `用户可以使用邮箱登录--${firstRunId}`
  );
  assert.equal(
    spec?.relativePath,
    `docs/ai-native/design/用户可以使用邮箱登录--${firstRunId}-design-spec.md`
  );
  assert.equal(
    spec?.absolutePath,
    path.join(projectRoot, "docs", "ai-native", "design", `用户可以使用邮箱登录--${firstRunId}-design-spec.md`)
  );
  assert.equal(
    definition.artifacts.find((artifact) => artifact.id === "design-spec")?.relativePath,
    "docs/ai-native/design/design-spec.md",
    "resolver must not mutate the loaded project definition"
  );
});

test("gives equal task titles different namespaces when their run ids differ", () => {
  const first = createTaskArtifactNamespace({ id: firstRunId, title: "Checkout" });
  const second = createTaskArtifactNamespace({ id: secondRunId, title: "Checkout" });

  assert.equal(first, `checkout--${firstRunId}`);
  assert.equal(second, `checkout--${secondRunId}`);
  assert.notEqual(first, second);
});

test("removes path and control characters from task titles", () => {
  const namespace = createTaskArtifactNamespace({
    id: firstRunId,
    title: " ../支付\\退款 /\r\n：*?<>| .. "
  });
  const fallback = createTaskArtifactNamespace({ id: secondRunId, title: "../\\ 😀" });

  assert.equal(namespace, `支付-退款--${firstRunId}`);
  assert.equal(fallback, `task--${secondRunId}`);
  assert.doesNotMatch(namespace, /[\\/\r\n]/u);
  assert.doesNotMatch(namespace, /(?:^|-)\.\.(?:-|$)/u);
});

test("AC-ENG-004: resolves all seven engineering outputs deterministically inside the Run namespace", () => {
  const definition = sampleDefinition();
  const task = { id: firstRunId.toUpperCase(), title: "  CHECKOUT   FLOW  " };
  const first = resolveTaskArtifactPaths(definition, task);
  const second = resolveTaskArtifactPaths(definition, task);
  const repeated = resolveTaskArtifactPaths(first, task);
  const baseline = definition.artifacts.find((artifact) => artifact.id === "design-baseline");

  assert.deepEqual(first, second);
  assert.deepEqual(first, repeated);
  assert.equal(
    first.artifacts.find((artifact) => artifact.id === "design-spec")?.relativePath,
    `docs/ai-native/design/checkout-flow--${firstRunId}-design-spec.md`
  );
  assert.strictEqual(
    first.artifacts.find((artifact) => artifact.id === "design-baseline"),
    baseline
  );
  for (const artifactKey of engineeringEvidenceKeys) {
    const configured = definition.artifacts.find((artifact) => artifact.id === artifactKey)!;
    const resolved = first.artifacts.find((artifact) => artifact.id === artifactKey)!;
    assert.notEqual(resolved.relativePath, configured.relativePath, artifactKey);
    assert.match(resolved.relativePath, new RegExp(firstRunId, "u"), artifactKey);
    assert.equal(resolved.absolutePath, path.join(projectRoot, resolved.relativePath), artifactKey);
    assert.equal(path.isAbsolute(path.relative(projectRoot, resolved.absolutePath)), false, artifactKey);
    assert.doesNotMatch(path.relative(projectRoot, resolved.absolutePath), /^\.\.(?:\/|$)/u, artifactKey);
  }
  assert.equal(
    new Set(engineeringEvidenceKeys.map((artifactKey) =>
      first.artifacts.find((artifact) => artifact.id === artifactKey)?.relativePath
    )).size,
    engineeringEvidenceKeys.length,
  );
});

test("AC-TESTER-012: gives test-report a stable Run-scoped path", () => {
  const task = { id: firstRunId, title: "Checkout coupon" };
  const configured = sampleDefinition();
  const first = resolveTaskArtifactPaths(configured, task);
  const repeated = resolveTaskArtifactPaths(first, task);
  const report = first.artifacts.find((artifact) => artifact.id === "test-report");
  assert.ok(report);

  assert.equal(
    report.relativePath,
    `docs/ai-native/testing/checkout-coupon--${firstRunId}-test-report.md`,
  );
  assert.equal(report?.absolutePath, path.join(projectRoot, report.relativePath));
  assert.equal(
    configured.artifacts.find((artifact) => artifact.id === "test-report")?.relativePath,
    "docs/ai-native/testing/test-report.md",
    "resolver must not mutate the configured verification path",
  );
  assert.deepEqual(repeated, first, "task-scoping is idempotent");
});

test("AC-TESTER-012: pins a persisted test-report path across config changes", () => {
  const task = { id: firstRunId, title: "Checkout coupon" };
  const legacyPath = "docs/ai-native/testing/test-report.md";
  const changed = sampleDefinition();
  const configuredReport = changed.artifacts.find(
    (artifact) => artifact.id === "test-report",
  )!;
  configuredReport.relativePath = "docs/moved/verification.md";
  configuredReport.absolutePath = path.join(projectRoot, configuredReport.relativePath);

  const resolved = pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(changed, task),
    projectRoot,
    [{ artifactKey: "test-report", filePath: legacyPath }],
  );

  assert.equal(
    resolved.artifacts.find((artifact) => artifact.id === "test-report")?.relativePath,
    legacyPath,
    "an existing legacy report head remains at its persisted default path",
  );
});

test("pins an existing task design spec when the live config path changes", () => {
  const original = resolveTaskArtifactPaths(sampleDefinition(), {
    id: firstRunId,
    title: "Checkout flow",
  });
  const originalPath = original.artifacts.find((artifact) => artifact.id === "design-spec")!.relativePath;
  const changed = sampleDefinition();
  const configuredSpec = changed.artifacts.find((artifact) => artifact.id === "design-spec")!;
  configuredSpec.relativePath = "docs/redesigned/specification.md";
  configuredSpec.absolutePath = path.join(projectRoot, "docs", "redesigned", "specification.md");

  const resolved = pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(changed, { id: firstRunId, title: "Checkout flow" }),
    projectRoot,
    [{ artifactKey: "design-spec", filePath: originalPath }],
  );

  assert.equal(
    resolved.artifacts.find((artifact) => artifact.id === "design-spec")?.relativePath,
    originalPath,
  );
  assert.throws(
    () => pinExistingTaskArtifactPaths(resolved, projectRoot, [{
      artifactKey: "design-spec",
      filePath: "../outside.md",
    }]),
    /路径无效/u,
  );
});

test("AC-ENG-004: reruns retain every originally pinned engineering evidence path", () => {
  const task = { id: firstRunId, title: "Checkout flow" };
  const original = resolveTaskArtifactPaths(sampleDefinition(), task);
  const pinned = engineeringEvidenceKeys.map((artifactKey) => ({
    artifactKey,
    filePath: original.artifacts.find((artifact) => artifact.id === artifactKey)!.relativePath,
  }));
  const changed = sampleDefinition();
  for (const artifactKey of engineeringEvidenceKeys) {
    const artifact = changed.artifacts.find((candidate) => candidate.id === artifactKey)!;
    artifact.relativePath = `docs/moved/${artifactKey}.md`;
    artifact.absolutePath = path.join(projectRoot, artifact.relativePath);
  }

  const resolved = pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(changed, task),
    projectRoot,
    pinned,
  );

  assert.deepEqual(
    engineeringEvidenceKeys.map((artifactKey) =>
      resolved.artifacts.find((artifact) => artifact.id === artifactKey)?.relativePath
    ),
    pinned.map(({ filePath }) => filePath),
  );
});

function sampleDefinition(): LoadedDefinition {
  return {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [],
    phases: [],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(projectRoot, "docs"),
    artifacts: [
      {
        id: "design-baseline",
        owner: "designer",
        relativePath: "docs/ai-native/design/DESIGN_BASELINE.md",
        absolutePath: path.join(projectRoot, "docs", "ai-native", "design", "DESIGN_BASELINE.md")
      },
      {
        id: "design-spec",
        owner: "designer",
        relativePath: "docs/ai-native/design/design-spec.md",
        absolutePath: path.join(projectRoot, "docs", "ai-native", "design", "design-spec.md")
      },
      {
        id: "implementation-notes",
        owner: "software-engineer",
        relativePath: "docs/ai-native/engineering/implementation-notes.md",
        absolutePath: path.join(projectRoot, "docs", "ai-native", "engineering", "implementation-notes.md")
      },
      ...engineeringEvidenceKeys.slice(1).map((id) => ({
        id,
        owner: "software-engineer",
        relativePath: `docs/ai-native/engineering/${id}.md`,
        absolutePath: path.join(projectRoot, "docs", "ai-native", "engineering", `${id}.md`),
      })),
      {
        id: "test-report",
        owner: "tester",
        relativePath: "docs/ai-native/testing/test-report.md",
        absolutePath: path.join(projectRoot, "docs", "ai-native", "testing", "test-report.md"),
      },
    ],
    configPath: path.join(projectRoot, "ai-native.yaml")
  };
}
