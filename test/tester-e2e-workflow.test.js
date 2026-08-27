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

  assert.match(crystallization, /(?:fresh|new|全新)[^.\n]{0,140}(?:session|subprocess|process|会话|进程)/iu);
  assert.match(crystallization, /Tier A(?:\s*\/\s*|\s+or\s+(?:Tier\s+)?|\s+或\s+(?:Tier\s+)?)B/iu);
  assert.match(crystallization, /(?:freeze|frozen|冻结)[^.\n]{0,120}(?:(?:AC|acceptance|验收)[^.\n]{0,120}(?:intent|意图)|(?:intent|意图)[^.\n]{0,120}(?:AC|acceptance|验收))/iu);
  assert.match(crystallization, /(?:authoritative|approved|权威|已批准)[^.\n]{0,100}(?:specification|spec|Change Contract|需求|规格)/iu);
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
  const contract = await testerContract();
  const engineerVerification = await source("templates/shared/.ai-sdlc/roles/software-engineer/references/independent-verification.md");
  const combined = `${contract}\n${engineerVerification}`;

  assert.match(combined, /Linked E2E Workspace/u);
  assert.match(combined, /Tester[^.\n]{0,180}(?:owns|拥有)[^.\n]{0,180}(?:linked|E2E)/iu);
  assert.match(combined, /Software Engineer[^.\n]{0,220}(?:product source|product-repository tests?|testability interface|产品源码|产品仓内测试)/iu);
  assert.match(combined, /(?:only|只有)[\s\S]{0,220}(?:product source|product-repository test|testability)[\s\S]{0,300}(?:Implementation reapproval|reapprove|重新审批)/iu);
  assert.match(combined, /(?:test bug|脚本错误|脚本 bug)[\s\S]{0,300}(?:fresh Test Author|Test Author|全新)/iu);
  assert.match(engineerVerification, /(?:does not require|no longer asks|不再)[\s\S]{0,220}(?:hand-write|手写|crystallization)/iu);
  assert.match(engineerVerification, /(?:refresh|刷新)[\s\S]{0,400}engineering-test-evidence/iu);
});

test("AC-TESTER-007: standalone Playwright execution records local or CI evidence and never uses MCP", async () => {
  const contract = await testerContract();
  const execution = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 3|Execution|执行阶段).*$/imu);

  assert.match(execution, /(?:standalone|独立命令|脚本自身)/iu);
  assert.match(execution, /playwright test/u);
  assert.match(execution, /(?:real headless Chromium|真实无头 Chromium|real configured browser)/iu);
  assert.match(execution, /(?:platform-supervised|platform[^.\n]{0,100}supervis|平台监督)/iu);
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
  assert.match(report, /(?:crystallization|固化)[\s\S]{0,600}(?:session|Test Author|会话|测试作者)[\s\S]{0,900}(?:linked-workspace test|\.spec\.ts|测试脚本)/iu);
  assert.match(report, /revision|修订/iu);
  assert.match(report, /Exact command|command_execution|命令/iu);
  assert.match(report, /remote CI|report|报告/iu);
  assert.match(report, /Product revision binding/u);
  assert.match(report, /E2E suite revision binding/u);
  assert.match(report, /Aggregate manifest hash/u);
  assert.match(report, /Human script review/u);
  assert.match(report, /Real browser launched/u);
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
    /(?:Execution|standalone Playwright|执行)/iu,
    /Linked E2E Workspace/u,
    /(?:manifest hash|脚本.*hash)/iu,
    /(?:real headless Chromium|真实无头 Chromium)/iu,
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
  for (const node of ["Change Contract", "Software Engineer", "Playwright MCP", "Linked E2E Workspace", "Test Author", "manifest hash", "Tester", "DevOps", "CI"]) {
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
  const contract = await testerContract();

  assert.match(contract, /(?:human-configured|human-selected|explicitly configured|人工明确关联|人工配置)[\s\S]{0,240}Linked E2E Workspace/iu);
  assert.match(contract, /(?:allowed )?absolute (?:root|path)|允许的绝对路径/iu);
  assert.match(contract, /loopback/iu);
  assert.match(contract, /(?:separate|non-nested|独立|不嵌套)[\s\S]{0,180}(?:root|workspace|工作区)/iu);
  for (const rejected of [
    /symlink/iu,
    /identical|相同/iu,
    /nested|嵌套/iu,
    /path traversal|路径逃逸/iu,
    /unsafe[^.\n]{0,80}(?:script|identifier)|不安全[^.\n]{0,80}(?:脚本|标识)/iu,
    /non-empty unmanaged|非空未管理/iu,
  ]) {
    assert.match(contract, rejected);
  }
  assert.match(contract, /(?:never|must not|不得|不会)[\s\S]{0,180}(?:infer|scan|discover|adopt|推断|扫描|发现|复用)[\s\S]{0,180}(?:legacy|sibling|旧|相邻)/iu);
});

test("AC-TESTER-015: readiness distinguishes package, browser launch, product start, and target states", async () => {
  const contract = await testerContract();
  const readiness = markdownSection(contract, /^(?:##|###)\s+.*(?:preflight|readiness|准备度).*$/imu);

  assert.match(readiness, /Playwright package/iu);
  assert.match(readiness, /(?:browser|Chromium)[^.\n]{0,160}executable/iu);
  assert.match(readiness, /(?:real headless|真实无头)[^.\n]{0,120}(?:launch|启动)[^.\n]{0,80}(?:probe|探测)/iu);
  assert.match(readiness, /(?:product )?start[- ]script|产品 start script/iu);
  assert.match(readiness, /target readiness|目标准备度/iu);
  assert.match(readiness, /(?:missing|unavailable|缺少|不可用)[\s\S]{0,300}(?:blocked|environment|阻塞|环境)/iu);
  assert.match(readiness, /(?:version|版本)[\s\S]{0,240}(?:does not|not prove|不能|不足)[\s\S]{0,180}(?:launch|启动)/iu);
});

test("AC-TESTER-016: authoring is a fresh spec-only linked-root process with allowlisted hashed output", async () => {
  const contract = await testerContract();
  const crystallization = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 2|Crystallization|固化阶段).*$/imu);

  assert.match(crystallization, /(?:legacy Run|旧 Run)[\s\S]{0,220}(?:approved|已批准)[\s\S]{0,160}`?user-stories`?/iu);
  assert.match(crystallization, /(?:fresh|全新)[^.\n]{0,140}(?:Tier A|Tier B|Test Author)[\s\S]{0,220}(?:subprocess|进程)/iu);
  assert.match(crystallization, /(?:only|只)[^.\n]{0,160}(?:Linked E2E Workspace|linked root|E2E root)/iu);
  assert.match(crystallization, /allowlist|allowlisted|白名单/iu);
  assert.match(crystallization, /manifest/iu);
  assert.match(crystallization, /SHA-256/iu);
  for (const excluded of [
    /product implementation|产品实现/iu,
    /implementation diff|实现 diff/iu,
    /implementation transcript|实现会话记录/iu,
    /exploration transcript|探索会话记录/iu,
    /DOM dump/iu,
  ]) {
    assert.match(crystallization, excluded);
  }
});

test("AC-TESTER-017: new executable scripts require exact human manifest-hash approval and invalidate on drift", async () => {
  const contract = await testerContract();

  assert.match(contract, /(?:cannot|must not|不得|不能)[^.\n]{0,180}(?:run|execute|运行|执行)[^.\n]{0,220}(?:human|人工)[^.\n]{0,160}(?:exact|精确)[^.\n]{0,120}manifest hash/iu);
  assert.match(contract, /(?:file|script|manifest|product revision|E2E revision|workspace token|binding|字节|脚本|产品 revision)[\s\S]{0,360}(?:invalidates|失效)[\s\S]{0,180}(?:approval|批准)/iu);
  assert.match(contract, /(?:script approval|脚本批准|脚本审核)[\s\S]{0,240}(?:does not|not approve|不批准|不代表)[\s\S]{0,180}Verification/iu);
});

test("AC-TESTER-018: the platform supervises fixed-argv real-Chromium execution and preserves failures", async () => {
  const contract = await testerContract();
  const execution = markdownSection(contract, /^(?:##|###)\s+.*(?:Phase 3|Execution|执行阶段).*$/imu);

  assert.match(execution, /fixed argv|固定 argv/iu);
  assert.match(execution, /shell:\s*false/u);
  assert.match(execution, /(?:supervis|监督)[\s\S]{0,200}(?:product server|产品服务)/iu);
  assert.match(execution, /(?:real headless Chromium|真实无头 Chromium)/iu);
  assert.match(execution, /(?:exit(?: code)? 0|exit 0|退出码 0)/iu);
  for (const failure of [/timeout|超时/iu, /launch failure|启动失败/iu, /test failure|测试失败/iu, /cleanup failure|清理失败/iu]) {
    assert.match(execution, failure);
  }
  assert.match(execution, /(?:non-passing|不得通过|非通过)/iu);
});

test("AC-TESTER-019: verification provenance binds trusted linked cwd, dual revisions, scripts, and runtime evidence", async () => {
  const combined = `${await testerContract()}\n${await source("templates/shared/.ai-sdlc/templates/test-report.md")}`;

  assert.match(combined, /(?:product|产品)[^.\n]{0,120}(?:Git\/workspace|revision|修订)[\s\S]{0,260}(?:E2E|Linked)[^.\n]{0,160}(?:Git\/workspace|revision|修订)/iu);
  assert.match(combined, /(?:trusted|可信)[^.\n]{0,160}(?:Linked E2E Workspace|linked root|linked cwd)/iu);
  assert.match(combined, /(?:Markdown|文档)[^.\n]{0,160}(?:cannot|不得|不能)[^.\n]{0,160}(?:authorize|授权)[^.\n]{0,120}(?:cwd|path|路径|command|命令)/iu);
  assert.match(combined, /(?:re-hash|re-hashes|重新计算|重算)[^.\n]{0,220}(?:script|脚本)[\s\S]{0,220}(?:evidence|证据)/iu);
  assert.match(combined, /command_execution/u);
});

test("AC-TESTER-020: guidance presents configure, preflight, author, review, run, and review without a manual marker", async () => {
  const documents = `${await source("README.md")}\n${await source("guidelines/roles/tester/README.md")}\n${await source("templates/shared/.ai-sdlc/roles/tester/workflow.md")}`;

  assertOrderedMatches(documents, [
    /(?:configure|configures|配置|关联)[^.\n]{0,160}(?:Linked E2E Workspace|separate root|独立工作区)/iu,
    /preflight|准备度/iu,
    /(?:fresh|全新)[^.\n]{0,160}(?:Test Author|Tier A|Tier B)/iu,
    /(?:approve|review|批准|审核)[^.\n]{0,160}manifest hash/iu,
    /(?:standalone Playwright|playwright test)/iu,
    /(?:Verification gate|Verification 审核|Verification 门禁)/iu,
  ]);
  assert.match(documents, /(?:no longer asks|does not require|不再要求|不需要)[^.\n]{0,180}(?:hand-write|手写)[^.\n]{0,180}(?:crystallization|marker|评论|标记)/iu);
  assert.match(documents, /Run without E2E obligations[^.\n]{0,220}without this binding|无需 E2E[^.\n]{0,220}不因缺少[^.\n]{0,160}Linked E2E Workspace/iu);
  assert.match(documents, /(?:never|不得|不会)[\s\S]{0,180}(?:auto|infer|scan|discover|自动|推断|扫描)[\s\S]{0,180}(?:legacy|sibling|旧|相邻)/iu);
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
