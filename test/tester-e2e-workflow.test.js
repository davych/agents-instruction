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
  const notes = readme.indexOf("implementation-notes");
  const tests = readme.indexOf("engineering-test-evidence", notes + 1);
  const review = readme.indexOf("engineering-review", tests + 1);

  assert.match(readme, /seven[^.\n]{0,120}(?:Markdown|documents?|outputs?)[^.\n]{0,160}(?:one|single)[^.\n]{0,100}(?:implementation|evidence pack)|one[^.\n]{0,100}evidence pack[^.\n]{0,160}seven/iu);
  assert.match(readme, /(?:not|rather than)[^.\n]{0,120}(?:seven|7)[^.\n]{0,100}(?:(?:manual|separate)[^.\n]{0,60})?(?:forms?|tasks?|assignments?)/iu);
  assert.ok(notes >= 0 && notes < tests && tests < review, "review order must start with notes, then test evidence, then review");
  assert.match(readme, /(?:approve|approval)[\s\S]{0,240}Tester/iu);
  assert.match(readme, /(?:do not approve|request changes|return)[\s\S]{0,240}(?:Failed|Blocked|gap|missing)/iu);
});

test("AC-TESTER-002: root guidance separates Run deliverables from repository development evidence", async () => {
  const readme = await source("README.md");

  assert.match(readme, /`changes\/`[\s\S]{0,240}`sessions\/`[\s\S]{0,240}`reviews\/`/u);
  assert.match(readme, /(?:delivery evidence|Run delivery|Run-scoped engineering paths|交付证据|交付产物)/iu);
  assert.match(readme, /(?:development evidence|repository evidence|maintainer evidence|开发证据|维护证据)/iu);
  assert.match(readme, /(?:not|isn't|is not|不是)[^.\n]{0,180}(?:next-phase input|Run delivery|initialized project|下一阶段输入|交付产物)/iu);
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
  assert.equal(existsSync(path.join(initializedProject, ".ai-sdlc/roles/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".github/skills/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".claude/skills/tester/SKILL.md")), false);
  assert.equal(existsSync(path.join(initializedProject, ".codex/skills/tester/SKILL.md")), false);
  assert.doesNotMatch(canonicalWorkflow, /^---/u);
  assert.doesNotMatch(canonicalReference, /^---/u);
});

test("AC-TESTER-004: Playwright MCP exploration is optional diagnostic work and never gate evidence by itself", async () => {
  const contract = await testerContract();
  const exploration = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 1|Exploration|探索阶段).*$/imu);

  assert.match(exploration, /Playwright MCP/u);
  assert.match(exploration, /(?:optional|when applicable|if useful|diagnostic|可选|按需|诊断)/iu);
  assert.match(exploration, /(?:one-off|transient|disposable|draft|一次性|临时|草稿)/iu);
  assert.match(exploration, /(?:by itself|alone|本身)/iu);
  assert.match(exploration, /(?:not|never|cannot|must not|不是|不得|不能)/iu);
  assert.match(exploration, /(?:repeatable acceptance|acceptance evidence|CI evidence|可重复验收|验收证据|CI 证据)/iu);
});

test("AC-TESTER-005: crystallization freezes AC intent in a fresh Tier A or B spec-only session", async () => {
  const contract = await testerContract();
  const crystallization = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 2|Crystallization|固化阶段).*$/imu);

  assert.match(crystallization, /(?:fresh|new|全新)[^.\n]{0,100}(?:independent|isolated|独立|隔离)?[^.\n]{0,80}(?:session|会话)/iu);
  assert.match(crystallization, /Tier A(?:\s*\/\s*|\s+or\s+|\s+或\s+)B/iu);
  assert.match(crystallization, /(?:freeze|frozen|冻结)[^.\n]{0,120}(?:AC|acceptance|验收)[^.\n]{0,120}(?:intent|意图)/iu);
  assert.match(crystallization, /(?:authoritative|approved|权威|已批准)[^.\n]{0,100}(?:specification|spec|Change Contract|需求|规格)/iu);
  for (const excludedInput of [
    /implementation diff|实现 diff|实现差异/iu,
    /implementation transcript|实现会话记录|实现 transcript/iu,
    /exploration code|探索代码/iu,
    /exploration transcript|探索会话记录|探索 transcript/iu,
  ]) {
    assert.match(crystallization, excludedInput);
  }
  assert.match(crystallization, /(?:must not|never|without|不得|不能|不提供)[\s\S]{0,300}(?:implementation diff|exploration code|实现 diff|探索代码)/iu);
});

test("AC-TESTER-006: a crystallized repository E2E test returns to Software Engineer for integration and evidence refresh", async () => {
  const contract = await testerContract();
  const engineerVerification = await source("templates/shared/.ai-sdlc/roles/software-engineer/references/independent-verification.md");
  const combined = `${contract}\n${engineerVerification}`;

  assert.match(combined, /tests\/e2e\/checkout-coupon\.spec\.ts/u);
  assert.match(combined, /Software Engineer[\s\S]{0,500}(?:integrat|repository test|test location|集成|测试位置)/iu);
  assert.match(combined, /(?:new|changed|新增|变更)[^.\n]{0,120}(?:repository )?E2E[^.\n]{0,120}(?:stale|refresh|过期|刷新)/iu);
  assert.match(combined, /(?:refresh|regenerate|刷新|重新生成)[\s\S]{0,400}engineering-test-evidence/iu);
  assert.match(combined, /implementation-notes[\s\S]{0,300}engineering-test-evidence[\s\S]{0,300}engineering-review/iu);
  assert.match(combined, /(?:reapprove|re-approve|approved again|重新审批|再次审批)[\s\S]{0,240}Tester/iu);
  assert.match(engineerVerification, /Tester[\s\S]{0,240}E2E/iu);
});

test("AC-TESTER-007: standalone Playwright execution records local or CI evidence and never uses MCP", async () => {
  const contract = await testerContract();
  const execution = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 3|Execution|执行阶段).*$/imu);

  assert.match(execution, /(?:standalone|独立命令|脚本自身)/iu);
  assert.match(execution, /playwright test/u);
  assert.match(execution, /(?:local|CI|本地)/u);
  assert.match(execution, /(?:never|must not|does not|without|不得|不再)[^.\n]{0,100}MCP|MCP[^.\n]{0,100}(?:never|must not|does not|without|不得|不再)/iu);
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
  const contract = await testerContract();

  assert.match(contract, /Tester[\s\S]{0,240}(?:command|report)[\s\S]{0,160}contract/iu);
  assert.match(contract, /(?:DevOps|authorized repository owner|授权的仓库负责人)[\s\S]{0,240}(?:configure|enforce|配置|维护)[\s\S]{0,160}required CI check/iu);
  assert.match(contract, /(?:must not|never|cannot|不得|不能)[\s\S]{0,200}(?:claim|声称)[\s\S]{0,160}remote CI (?:pass|success|通过)/iu);
  assert.match(contract, /(?:durable|可追溯|持久)[^.\n]{0,120}(?:run|执行)[^.\n]{0,80}(?:reference|URL|引用)/iu);
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
  assert.match(report, /(?:crystallization|固化)[\s\S]{0,500}(?:session|会话)[\s\S]{0,500}(?:repository test|\.spec\.ts|测试脚本)/iu);
  assert.match(report, /(?:revision|修订)[\s\S]{0,500}(?:command|命令)[\s\S]{0,500}(?:CI|report|报告)/iu);
  assert.match(report, /Release recommendation|发布建议/iu);
});

test("AC-TESTER-010: the documented workflow has a detailed Mermaid graph, node table, failure loops, and no seventh phase", async () => {
  const rootReadme = await source("README.md");
  const workflowReadme = await source("guidelines/workflow/README.md");
  const documents = [rootReadme, workflowReadme];
  const graph = documents
    .flatMap(mermaidBlocks)
    .find((candidate) => /Playwright MCP/u.test(candidate)
      && /(?:Crystallization|固化)/iu.test(candidate)
      && /(?:playwright test|CI)/iu.test(candidate));

  assert.ok(graph, "README guidance must contain the complete E2E Mermaid graph");
  assert.match(graph, /^flowchart\s+TD/mu);
  for (const node of [
    /Change Contract/u,
    /Product/u,
    /Design/u,
    /Architecture/u,
    /Software Engineer/u,
    /Tester/u,
    /DevOps/u,
    /(?:human release|human.*release|人类发布|人工发布)/iu,
    /(?:Exploration|探索)/iu,
    /(?:Crystallization|固化)/iu,
    /(?:Execution|Standalone playwright test|执行)/iu,
  ]) {
    assert.match(graph, node);
  }
  assert.match(graph, /(?:Classify|分类)[^.\n]{0,100}(?:return|route|回流|返回)/iu);
  for (const failureLoop of [
    /product\/spec|product|PM \/ BA|产品|需求/iu,
    /design|设计/iu,
    /architecture|架构/iu,
    /implementation|Software Engineer|实现/iu,
    /test script|Tester|测试脚本/iu,
    /environment|DevOps|CI environment|环境/iu,
  ]) {
    assert.match(graph, failureLoop);
  }

  const nodeTable = documents.map(findNodeTable).find(Boolean);
  assert.ok(nodeTable, "README guidance must contain a Node/Owner/Input/Action/Output-or-gate table");
  assert.ok(nodeTable.rows.length >= 12, `expected at least 12 detailed workflow nodes, got ${nodeTable.rows.length}`);
  for (const node of ["Change Contract", "Software Engineer", "Playwright MCP", "Crystallization", "Tester", "DevOps", "CI"]) {
    assert.match(nodeTable.text, new RegExp(escapeRegExp(node), "iu"));
  }

  const config = await readFile(path.join(initializedProject, "ai-native.yaml"), "utf8");
  assert.deepEqual(readPhaseOwners(config), expectedPhaseOwners);
  assert.deepEqual(readArtifactIds(config), expectedArtifactIds);
  assert.deepEqual(readPhaseOutputs(config, "implementation"), engineeringEvidenceIds);
  assert.deepEqual(readPhaseOutputs(config, "verification"), ["test-report"]);
  assert.doesNotMatch(config, /id: (?:e2e|playwright|exploration|crystallization)/iu);
});

test("AC-TESTER-011: Web guidance presents the three-stage Tester lifecycle before Verification and rejects MCP-only proof", async () => {
  const guidance = await source("platform/apps/web/src/lib/tester-workflow.ts");
  const runPage = await source("platform/apps/web/src/pages/run-page.tsx");

  assert.match(guidance, /export const TESTER_(?:FLOW|WORKFLOW)_STEPS/u);
  assertOrderedMatches(guidance, [
    /Playwright MCP/u,
    /(?:Crystallization|固化)/iu,
    /playwright test/u,
  ]);
  assert.match(guidance, /(?:before|prior to|运行前|执行前)[^.\n]{0,100}Verification|Verification[^.\n]{0,100}(?:before|prior to|运行前|执行前)/iu);
  assert.match(guidance, /MCP[^.\n]{0,160}(?:not enough|insufficient|not evidence|不能通过|不足|不是证据)/iu);
  assert.match(runPage, /TESTER_(?:FLOW|WORKFLOW)_STEPS|tester-workflow/u);
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
  const validationGuide = await source("docs/context/testing.md");
  const dependencyEvidence = [
    rootPackageText,
    platformPackageText,
    await source("package-lock.json"),
    await source("platform/yarn.lock"),
  ].join("\n");

  assert.equal(rootPackage.scripts.test, "node --test");
  assert.equal(platformPackage.scripts.typecheck, "yarn workspaces foreach --all --parallel --interlaced run typecheck");
  assert.equal(platformPackage.scripts.test, "yarn workspaces foreach --all --parallel --interlaced run test");
  assert.equal(platformPackage.scripts.build, "yarn workspaces foreach --all --topological run build");
  assert.match(validationGuide, /root tests plus platform typecheck, tests, and build/iu);
  assert.match(await source("README.md"), /npm test[\s\S]{0,120}npm pack --dry-run/u);
  assert.doesNotMatch(dependencyEvidence, /"@playwright\/test"|playwright-core@|playwright@npm:/u);
});

async function testerContract() {
  return [
    await source("templates/shared/.ai-sdlc/roles/tester/workflow.md"),
    await source("templates/shared/.ai-sdlc/roles/tester/references/e2e-playwright.md"),
    await source("templates/agents/tester.md"),
    await source("guidelines/roles/tester/README.md"),
  ].join("\n\n");
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

function findNodeTable(content) {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    if (
      !/^\|/u.test(header)
      || !/\bNode\b|节点/iu.test(header)
      || !/\bOwner\b|负责人/iu.test(header)
      || !/\bInputs?\b|输入/iu.test(header)
      || !/\bAction\b|动作|操作/iu.test(header)
      || !/\bOutput\b|\bGate\b|输出|门禁/iu.test(header)
    ) continue;
    const tableLines = [];
    for (let cursor = index; cursor < lines.length && /^\|/u.test(lines[cursor]); cursor += 1) {
      tableLines.push(lines[cursor]);
    }
    const rows = tableLines.slice(2).filter((line) => !/^\|(?:\s*:?-+:?\s*\|)+$/u.test(line));
    return { text: tableLines.join("\n"), rows };
  }
  return undefined;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
