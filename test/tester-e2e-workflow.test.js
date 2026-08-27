import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../bin/cli.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPhaseOwners = [
  ["discovery", "pm-ba"],
  ["design", "designer"],
  ["architecture", "architect"],
  ["implementation", "software-engineer"],
  ["verification", "tester"],
  ["release", "devops"],
];
const expectedArtifactIds = [
  "change-contract",
  "prd",
  "user-stories",
  "design-baseline",
  "design-spec",
  "design-prototype",
  "figma-handoff",
  "architecture",
  "architecture-discovery-context",
  "architecture-options",
  "architecture-c4-context",
  "architecture-c4-containers",
  "architecture-adrs",
  "architecture-patterns",
  "architecture-nfrs",
  "architecture-adversarial",
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
  "test-report",
  "release-runbook",
];
const engineeringEvidenceIds = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
];

let initializedProject;

test.before(async () => {
  initializedProject = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-tester-contract-"));
  const prompt = answers([
    "Tester contract fixture",
    "Independent acceptance fixture for the Tester E2E workflow",
    "1",
    "",
    "",
  ]);
  assert.equal(await run(["init", initializedProject], { prompt, output: () => {} }), 0);
});

test.after(async () => {
  if (initializedProject) await rm(initializedProject, { recursive: true, force: true });
});

test("AC-TESTER-001: root guidance explains how one generated engineering evidence pack is reviewed", async () => {
  const readme = await source("README.md");

  assert.match(readme, /one reviewable engineering evidence pack/iu);
  assert.match(readme, /Tester independently verifies the accepted contract/iu);
});

test("AC-TESTER-003: initializer installs one ordinary Tester role pack without a duplicate Skill or Agent", async () => {
  const canonicalWorkflow = await source("templates/shared/.ai-sdlc/roles/tester/workflow.md");
  const canonicalReference = await source("templates/shared/.ai-sdlc/roles/tester/references/e2e-playwright.md");
  const installedWorkflowPath = path.join(initializedProject, ".ai-sdlc/roles/tester/workflow.md");
  const installedReferencePath = path.join(initializedProject, ".ai-sdlc/roles/tester/references/e2e-playwright.md");
  const installedAgent = await readFile(path.join(initializedProject, ".github/agents/tester.agent.md"), "utf8");

  assert.equal(await readFile(installedWorkflowPath, "utf8"), canonicalWorkflow);
  assert.equal(await readFile(installedReferencePath, "utf8"), canonicalReference);
  assert.match(installedAgent, /\.ai-sdlc\/roles\/tester\/workflow\.md/u);
  assert.deepEqual(
    [...installedAgent.matchAll(/^## (.+)$/gmu)].map((match) => match[1]),
    ["Mission", "Authority", "Non-negotiable boundaries", "Start", "Handoff"],
  );
  assert.doesNotMatch(installedAgent, /^## (?:Procedure|E2E Stage|Path|Output contract)/gmu);
  assert.equal(existsSync(path.join(initializedProject, ".ai-sdlc/roles/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".github/skills/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".claude/skills/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".codex/skills/tester/SKILL.md")), false);
  assert.doesNotMatch(canonicalWorkflow, /^---/u);
  assert.doesNotMatch(canonicalReference, /^---/u);
});

test("AC-TESTER-004: Playwright MCP exploration is optional diagnostic work and never gate evidence by itself", async () => {
  const workflow = await testerWorkflow();
  const exploration = markdownSection(workflow, /^## E2E Stage 1: optional exploration$/mu);

  assert.match(exploration, /Playwright MCP/u);
  assert.match(exploration, /(?:optional|when applicable|if useful|diagnostic|可选|按需|诊断)/iu);
  assert.match(exploration, /diagnostic/iu);
  assert.match(exploration, /does not prove/u);
  assert.match(exploration, /(?:repeatable acceptance|acceptance evidence|CI evidence|可重复验收|验收证据|CI 证据)/iu);
});

test("AC-TESTER-005: crystallization freezes AC intent in a fresh Tier A or B spec-only session", async () => {
  const workflow = await testerWorkflow();
  const crystallization = markdownSection(workflow, /^## E2E Stage 2: staged independent authoring$/mu);

  assert.match(crystallization, /fresh Tier A or Tier B spec-only Test Author/iu);
  assert.match(crystallization, /Tier A(?:\s*\/\s*|\s+or\s+(?:Tier\s+)?|\s+或\s+(?:Tier\s+)?)B/iu);
  assert.match(crystallization, /Freeze each selected scenario/u);
  assert.match(crystallization, /approved behavior contract/u);
  for (const excludedInput of [
    /implementation diff|实现 diff|实现差异/iu,
    /implementation transcript|实现会话记录|实现 transcript/iu,
    /exploration code|探索代码/iu,
    /exploration transcript|探索会话记录|探索 transcript/iu,
  ]) {
    assert.match(crystallization, excludedInput);
  }
  assert.match(crystallization, /(?:must not|do not|never|without|不得|不能|不提供)[\s\S]{0,300}(?:implementation diff|exploration code|实现 diff|探索代码)/iu);
});

test("AC-TESTER-006: linked E2E scripts are Tester-owned while product assets remain Software Engineer-owned", async () => {
  const workflow = await testerWorkflow();
  const engineerVerification = await source("templates/shared/.ai-sdlc/roles/software-engineer/references/independent-verification.md");

  assert.match(workflow, /Tester owns[\s\S]{0,220}staged test authoring/iu);
  assert.match(workflow, /Software Engineer owns product source, product-repository tests, and public testability interfaces/u);
  assert.match(workflow, /Only product and product-repository changes reopen Implementation/u);
  assert.match(workflow, /test bug[\s\S]{0,220}new staging copy/iu);
  assert.match(engineerVerification, /temporary staging copy[\s\S]*validates and promotes only the allowlisted changes[\s\S]*re-hashes the complete promoted executable baseline[\s\S]*human approves that exact baseline hash/u);
  assert.match(engineerVerification, /(?:refresh|刷新)[\s\S]{0,400}engineering-test-evidence/iu);
});

test("AC-TESTER-007: standalone Playwright execution records local or CI evidence and never uses MCP", async () => {
  const workflow = await testerWorkflow();
  const execution = markdownSection(workflow, /^## E2E Stage 3: standalone execution$/mu);

  assert.match(execution, /(?:standalone|独立命令|脚本自身)/iu);
  assert.match(execution, /playwright test/u);
  assert.match(execution, /(?:real headless Chromium|真实无头 Chromium|real configured browser)/iu);
  assert.match(execution, /platform—not the Agent and not MCP/iu);
  assert.match(execution, /(?:local|CI|本地)/u);
  assert.match(execution, /platform—not the Agent and not MCP/iu);
  for (const evidenceField of [
    /revision|commit|修订/u,
    /exact command|command|命令/iu,
    /exit (?:code|result|status)|退出/u,
    /report|报告/iu,
    /trace|追踪/iu,
    /screenshot|截图/iu,
    /video|视频/iu,
  ]) {
    assert.match(execution, evidenceField);
  }
});

test("AC-TESTER-008: Tester owns the E2E contract while DevOps or the repository owner owns the required CI check", async () => {
  const workflow = await testerWorkflow();
  const reference = await testerReference();
  const devopsAgent = await source("templates/agents/devops.md");

  assert.match(workflow, /DevOps records and validates the expected check contract; it does not configure it/u);
  assert.match(reference, /Only a separately authorized human or provider system configures or changes CI\/required checks/u);
  assert.match(reference, /current durable provider run URL\/ID/u);
  assert.match(devopsAgent, /Never configure CI\/required checks[\s\S]*only records and validates/u);
});

test("AC-TESTER-009: test-report keeps exploration, crystallization, execution, results, and release risk separate", async () => {
  const report = await source("templates/shared/.ai-sdlc/templates/test-report.md");
  const headings = markdownHeadings(report).map((heading) => heading.toLowerCase());
  const expectedHeadings = [
    /exploration|探索/u,
    /crystallization|固化/u,
    /execution|执行/u,
    /acceptance.*regression|验收.*回归/u,
    /deferred design verification|延期设计验证/u,
    /failure classification|失败分类/u,
    /coverage gaps|覆盖缺口/u,
    /defects.*release risk|缺陷.*发布风险/u,
  ];

  for (const expected of expectedHeadings) {
    assert.ok(headings.some((heading) => expected.test(heading)), `missing test-report section ${expected}`);
  }
  assert.match(
    report,
    /(?:exploration|探索)[\s\S]{0,500}(?:non-gating|not gate evidence|not repeatable acceptance or CI evidence|cannot pass Verification|非门禁|不作为门禁|不是可重复验收或 CI 证据|不能通过 Verification)/iu,
  );
  assert.match(report, /(?:crystallization|固化)[\s\S]{0,900}Temporary staging identity[\s\S]{0,900}Author working directory/iu);
  assert.match(report, /revision|修订/iu);
  assert.match(report, /Exact command|command_execution|命令/iu);
  assert.match(report, /remote CI|report|报告/iu);
  assert.match(report, /Product revision binding/u);
  assert.match(report, /E2E suite revision binding/u);
  assert.match(report, /Aggregate manifest hash/u);
  assert.match(report, /Human script review/u);
  assert.match(report, /Validated promotion result[\s\S]*Promoted suite baseline[\s\S]*Human script review/u);
  assert.match(report, /Real browser launched/u);
  assert.match(report, /Release recommendation|发布建议/iu);
});

test("AC-TESTER-010: the canonical Tester workflow owns the detailed E2E graph without adding a seventh phase", async () => {
  const workflow = await testerWorkflow();
  const graph = mermaidBlocks(workflow).find((candidate) => /Playwright MCP/u.test(candidate));

  assert.ok(graph, "Tester workflow must contain the canonical E2E graph");
  assert.match(graph, /^flowchart\s+TD/mu);
  for (const node of [
    /Software Engineer/u,
    /temporary staging copy/u,
    /allowlisted tests\/fixtures in staging/u,
    /DevOps/u,
    /Linked E2E Workspace/u,
    /real Chromium/u,
  ]) {
    assert.match(graph, node);
  }
  assertOrderedMatches(graph, [
    /Validate staged diff, paths, change manifest, and hashes without execution/u,
    /Promote only validated allowlisted tests\/fixtures to linked root/u,
    /Re-hash complete promoted executable suite baseline/u,
    /Human approves exact promoted baseline\/hash/u,
    /standalone Playwright from linked root/u,
  ]);

  const config = await readFile(path.join(initializedProject, "ai-native.yaml"), "utf8");
  assert.deepEqual(readPhaseOwners(config), expectedPhaseOwners);
  assert.deepEqual(readArtifactIds(config), expectedArtifactIds);
  assert.deepEqual(readPhaseOutputs(config, "implementation"), engineeringEvidenceIds);
  assert.deepEqual(readPhaseOutputs(config, "verification"), ["test-report"]);
  assert.doesNotMatch(config, /id: (?:e2e|playwright|exploration|crystallization)/iu);
});

test("AC-TESTER-011: Web guidance presents the three-stage Tester lifecycle before Verification and rejects MCP-only proof", async () => {
  const guidance = await source("platform/apps/web/src/lib/tester-workflow.ts");
  const flowGuide = await source("platform/apps/web/src/components/run/phase-flow-guides.tsx");
  const runPage = await source("platform/apps/web/src/pages/run-page.tsx");

  assert.match(guidance, /export const TESTER_(?:FLOW|WORKFLOW)_STEPS/u);
  assertOrderedMatches(guidance, [
    /Playwright MCP/u,
    /(?:Crystallization|固化)/iu,
    /playwright test/u,
  ]);
  assert.match(guidance, /(?:before|prior to|运行前|执行前)[^.\n]{0,100}Verification|Verification[^.\n]{0,100}(?:before|prior to|运行前|执行前)/iu);
  assert.match(guidance, /MCP[^.\n]{0,160}(?:not enough|insufficient|not evidence|不能通过|不足|不是证据)/iu);
  assert.match(flowGuide, /TESTER_FLOW_STEPS/u);
  assert.match(runPage, /TesterFlowGuide/u);
});

test("AC-TESTER-012: test-report is Run-scoped and an existing persisted report path remains pinnable", async () => {
  const pathResolver = await source("platform/apps/api/src/domain/task-artifact-paths.ts");
  const pathChecks = await source("platform/apps/api/checks/task-artifact-paths.check.ts");

  assert.match(pathResolver, /TASK_SCOPED_ARTIFACT_KEYS[\s\S]{0,500}"test-report"/u);
  assert.match(pathResolver, /pinExistingTaskArtifactPaths/u);
  assert.match(pathChecks, /AC-TESTER-012/u);
  assert.match(pathChecks, /test-report/u);
  assert.match(pathChecks, /firstRunId[\s\S]{0,800}secondRunId/u);
  assert.match(pathChecks, /pinExistingTaskArtifactPaths/u);
  assert.match(pathChecks, /(?:live config|configured|moves|renames|moved|path changes|配置路径)/iu);
});

test("AC-TESTER-013: repository validation contracts stay executable without adding Playwright to the initializer", async () => {
  const rootPackageText = await source("package.json");
  const platformPackageText = await source("platform/package.json");
  const rootPackage = JSON.parse(rootPackageText);
  const platformPackage = JSON.parse(platformPackageText);
  const repositoryInstructions = await source("AGENTS.md");
  const dependencyEvidence = [
    rootPackageText,
    platformPackageText,
    await source("package-lock.json"),
    await source("platform/yarn.lock"),
  ].join("\n");

  assert.equal(rootPackage.scripts.test, "node --test");
  assert.equal(platformPackage.scripts.typecheck, "yarn workspaces foreach --all --parallel --interlaced run typecheck");
  assert.equal(
    platformPackage.scripts.test,
    "yarn workspace @ai-sdlc/contracts build && yarn workspaces foreach --all --parallel --interlaced run test",
  );
  assert.equal(platformPackage.scripts.build, "yarn workspaces foreach --all --topological run build");
  assert.match(repositoryInstructions, /Root initializer checks: `npm test` and `npm pack --dry-run`/u);
  assert.match(repositoryInstructions, /Platform checks: `yarn typecheck`, `yarn test`, and `yarn build` from `platform\/`/u);
  assert.match(await source("README.md"), /npm test[\s\S]{0,120}npm pack --dry-run/u);
  assert.doesNotMatch(dependencyEvidence, /"@playwright\/test"|playwright-core@|playwright@npm:/u);
});

test("AC-TESTER-014: linked E2E workspace configuration is explicit, separate, safe, and never inferred from legacy", async () => {
  const workflow = await testerWorkflow();
  const reference = await testerReference();

  assert.match(workflow, /Linked E2E Workspace is an explicit, human-selected platform binding/u);
  assert.match(reference, /canonical allowed absolute root/u);
  assert.match(reference, /loopback/iu);
  assert.match(reference, /separate local project/u);
  for (const rejected of [
    /symlink/iu,
    /identical|相同/iu,
    /nested|嵌套/iu,
    /path traversal|路径逃逸/iu,
    /unsafe[^.\n]{0,80}(?:script|identifier)|不安全[^.\n]{0,80}(?:脚本|标识)/iu,
    /non-empty unmanaged|非空未管理/iu,
  ]) {
    assert.match(reference, rejected);
  }
  assert.match(reference, /Never scan siblings[\s\S]{0,200}legacy/u);
});

test("AC-TESTER-015: readiness distinguishes package, browser launch, product start, and target states", async () => {
  const reference = await testerReference();
  const readiness = markdownSection(reference, /^## Structured readiness$/mu);

  assert.match(readiness, /Playwright package/iu);
  assert.match(readiness, /(?:browser|Chromium)[^.\n]{0,160}executable/iu);
  assert.match(readiness, /(?:real headless|真实无头)[^.\n]{0,120}(?:launch|启动)[^.\n]{0,80}(?:probe|探测)/iu);
  assert.match(readiness, /(?:product )?start[- ]script|产品 start script/iu);
  assert.match(readiness, /target readiness|目标准备度/iu);
  assert.match(readiness, /(?:missing|unavailable|缺少|不可用)[\s\S]{0,300}(?:blocked|environment|阻塞|环境)/iu);
  assert.match(readiness, /(?:version|版本)[\s\S]{0,240}(?:does not|not prove|不能|不足)[\s\S]{0,180}(?:launch|启动)/iu);
});

test("AC-TESTER-016: authoring is fresh, spec-only, staging-scoped, and non-executing", async () => {
  const workflow = await testerWorkflow();
  const reference = await testerReference();
  const authoring = markdownSection(workflow, /^## E2E Stage 2: staged independent authoring$/mu);
  const inputs = markdownSection(reference, /^## Independent author input$/mu);

  assert.match(inputs, /approved selected `user-stories` artifact for a legacy Run/u);
  assert.match(authoring, /fresh Tier A or Tier B spec-only Test Author/u);
  assert.match(authoring, /staging root as its only writable working directory/u);
  assert.match(authoring, /allowlisted test and fixture paths in staging/u);
  assert.match(authoring, /must not execute generated code/u);
  assert.match(authoring, /write directly to the Linked E2E Workspace/u);
  assert.match(authoring, /SHA-256/u);
  for (const excluded of [
    /product implementation|产品实现/iu,
    /implementation diff|实现 diff/iu,
    /implementation transcript|实现会话记录/iu,
    /exploration transcript|探索会话记录/iu,
    /DOM dump/iu,
  ]) {
    assert.match(authoring, excluded);
  }
});

test("AC-TESTER-017: validated promotion precedes exact human approval of the complete promoted baseline", async () => {
  const workflow = await testerWorkflow();
  const authoring = markdownSection(workflow, /^## E2E Stage 2: staged independent authoring$/mu);

  assertOrderedMatches(authoring, [
    /Validate the staging diff without executing it/u,
    /promotes only those validated allowlisted test\/fixture changes into the linked root/u,
    /enumerate and re-hash the complete executable test\/fixture baseline/u,
    /human reviews that complete promoted baseline and approves its exact aggregate hash for execution/u,
    /Re-check the full manifest immediately before execution/u,
  ]);
  assert.match(workflow, /Human script review happens after promotion and authorizes execution[\s\S]{0,180}does not authorize promotion/u);
  assert.match(authoring, /drift invalidates approval/u);
});

test("AC-TESTER-018: the platform supervises fixed-argv real-Chromium execution and preserves failures", async () => {
  const workflow = await testerWorkflow();
  const execution = markdownSection(workflow, /^## E2E Stage 3: standalone execution$/mu);

  assert.match(execution, /fixed argv|固定 argv/iu);
  assert.match(execution, /shell:\s*false/u);
  assert.match(execution, /(?:supervis|监督)[\s\S]{0,200}(?:product server|产品服务)/iu);
  assert.match(execution, /(?:real headless Chromium|真实无头 Chromium)/iu);
  assert.match(execution, /(?:exit(?: code)? 0|exit 0|退出码 0)/iu);
  for (const failure of [/timeout/iu, /launch/iu, /test/iu, /cleanup/iu]) {
    assert.match(execution, failure);
  }
  assert.match(execution, /(?:non-passing|不得通过|非通过)/iu);
});

test("AC-TESTER-019: verification provenance binds trusted linked cwd, dual revisions, scripts, and runtime evidence", async () => {
  const workflow = await testerWorkflow();
  const reference = await testerReference();
  const report = await source("templates/shared/.ai-sdlc/templates/test-report.md");

  assert.match(workflow, /product and E2E revisions/u);
  assert.match(reference, /trusted Linked E2E Workspace root[\s\S]*cwd/u);
  assert.match(workflow, /Markdown cannot authorize another cwd, command, promotion, or external action/u);
  assert.match(reference, /re-hash the complete executable test\/fixture baseline/u);
  assert.match(report, /command_execution/u);
});

test("AC-TESTER-020: the canonical procedure presents bind, preflight, stage, promote, review, and linked-root execution", async () => {
  const workflow = await testerWorkflow();
  const guidance = await source("guidelines/roles/tester/README.md");

  assertOrderedMatches(workflow, [
    /Linked E2E Workspace configured/u,
    /structured readiness preflight/u,
    /fresh temporary staging copy/u,
    /fresh Tier A\/B Test Author writes allowlisted tests\/fixtures in staging/u,
    /Promote only validated allowlisted tests\/fixtures to linked root/u,
    /Human approves exact promoted baseline\/hash/u,
    /standalone Playwright from linked root/u,
  ]);
  assert.doesNotMatch(workflow, /crystallization request|hand-write[^.\n]*marker/iu);
  assert.match(workflow, /Missing binding blocks only a Run whose risk map requires durable E2E/u);
  assert.match(guidance, /\.ai-sdlc\/roles\/tester\/workflow\.md/u);
});

async function testerWorkflow() {
  return source("templates/shared/.ai-sdlc/roles/tester/workflow.md");
}

async function testerReference() {
  return source("templates/shared/.ai-sdlc/roles/tester/references/e2e-playwright.md");
}

async function source(relativePath) {
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  assert.equal(existsSync(absolutePath), true, `missing required contract file: ${relativePath}`);
  return readFile(absolutePath, "utf8");
}

function answers(values) {
  const queue = [...values];
  return async () => queue.shift() ?? "";
}

function markdownSection(content, headingPattern) {
  const heading = headingPattern.exec(content);
  assert.ok(heading?.index !== undefined, `missing Markdown section ${headingPattern}`);
  const start = heading.index + heading[0].length;
  const remainder = content.slice(start);
  const nextHeading = remainder.search(/^##\s+/mu);
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
}

function markdownHeadings(content) {
  return [...content.matchAll(/^#{2,3}\s+(.+)$/gmu)].map((match) => match[1].trim());
}

function mermaidBlocks(content) {
  return [...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

function readPhaseOwners(config) {
  const workflow = config.slice(config.indexOf("workflow:"), config.indexOf("\nartifacts:"));
  return [...workflow.matchAll(/^    - id: ([^\s]+)\n      owner: ([^\s]+)$/gmu)]
    .map((match) => [match[1], match[2]]);
}

function readArtifactIds(config) {
  const artifacts = config.slice(config.indexOf("\nartifacts:"));
  return [...artifacts.matchAll(/^  - \{ id: ([^,]+), owner:/gmu)].map((match) => match[1]);
}

function readPhaseOutputs(config, phaseId) {
  const workflow = config.slice(config.indexOf("workflow:"), config.indexOf("\nartifacts:"));
  const phaseStart = workflow.indexOf(`    - id: ${phaseId}\n`);
  assert.notEqual(phaseStart, -1, `missing phase ${phaseId}`);
  const nextPhase = workflow.indexOf("\n    - id:", phaseStart + 1);
  const phase = workflow.slice(phaseStart, nextPhase < 0 ? undefined : nextPhase);
  const outputs = /^      outputs: \[([^\]]*)\]$/mu.exec(phase);
  assert.ok(outputs, `missing outputs for ${phaseId}`);
  return outputs[1].split(",").map((value) => value.trim()).filter(Boolean);
}

function assertOrderedMatches(content, patterns) {
  let cursor = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(content.slice(cursor));
    assert.ok(match?.index !== undefined, `missing ordered content ${pattern}`);
    cursor += match.index + match[0].length;
  }
}
