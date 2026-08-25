import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { PhaseDefinition, ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import { resolveTaskArtifactPaths } from "../src/domain/task-artifact-paths.ts";
import { buildTaskEnvelope, CodexTerminalRunner } from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";

const roots: string[] = [];
const executionConfig = { model: "gpt-5.6-sol", reasoningEffort: "high" as const };
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("platform-injected optional outputs never overwrite an unadopted project file", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-backfill-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "designer.toml"), "name='designer'\n", "utf8");
  const prototypePath = path.join(root, "docs", "prototype.html");
  await mkdir(path.dirname(prototypePath), { recursive: true });
  const sentinel = "<!doctype html><p>project-owned sentinel</p>\n";
  await writeFile(prototypePath, sentinel, "utf8");
  const now = new Date().toISOString();
  const phase: PhaseDefinition = {
    id: "design",
    owner: "designer",
    inputs: [],
    outputs: ["design-prototype"],
    gate: "human review",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Legacy design", summary: "Backfill collision" },
    roles: [{ id: "designer", name: "Designer", mission: "Design", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [{
      id: "design-prototype",
      owner: "designer",
      relativePath: "docs/prototype.html",
      absolutePath: prototypePath,
      platformInjected: true,
    }],
    configPath: path.join(root, "ai-native.yaml"),
    releaseEvidenceValidationRequired: false,
  };
  const project: ProjectDto = {
    id: crypto.randomUUID(),
    name: "Legacy design",
    summary: "Backfill collision",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(),
    projectId: project.id,
    title: "Legacy design",
    objective: "Preserve project-owned prototype",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await assert.rejects(
    () => new CodexTerminalRunner({ fake: true }).run({
      executionId: crypto.randomUUID(),
      project,
      run,
      phase,
      definition,
      selectedArtifacts: [],
      selectedOutputKeys: ["design-prototype"],
      ...executionConfig,
    }, async () => undefined),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PLATFORM_BACKFILL_COLLISION");
      return true;
    },
  );
  assert.equal(await readFile(prototypePath, "utf8"), sentinel);
});

test("fake Codex runner creates deterministic registered artifacts", async () => {
  const temporaryRoot = path.join(process.cwd(), ".test-tmp-");
  const root = await mkdtemp(temporaryRoot);
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "pm-ba.toml"), "name='pm-ba'\n", "utf8");
  const now = new Date().toISOString();
  const phase: PhaseDefinition = {
    id: "discovery",
    owner: "pm-ba",
    inputs: [],
    outputs: ["prd", "user-stories"],
    gate: "human review"
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [{ id: "pm-ba", name: "PM", mission: "Stories", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [
      { id: "prd", owner: "pm-ba", relativePath: "docs/prd.md", absolutePath: path.join(root, "docs/prd.md") },
      { id: "user-stories", owner: "pm-ba", relativePath: "docs/user-stories", absolutePath: path.join(root, "docs/user-stories") }
    ],
    configPath: path.join(root, "ai-native.yaml")
  };
  const project: ProjectDto = { id: crypto.randomUUID(), name: "Demo", summary: "Demo", rootPath: root, configPath: definition.configPath, runCount: 0, createdAt: now, updatedAt: now };
  const run: WorkflowRunDto = { id: crypto.randomUUID(), projectId: project.id, title: "Login", objective: "Create login stories", status: "active", createdAt: now, updatedAt: now };
  const events: Array<{ type: string; payload: unknown }> = [];
  const result = await new CodexTerminalRunner({ fake: true }).run(
    { executionId: crypto.randomUUID(), project, run, phase, definition, selectedArtifacts: [], ...executionConfig },
    async (type, payload) => { events.push({ type, payload }); }
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactKey), ["prd", "user-stories"]);
  assert.match(result.artifacts[0]?.content ?? "", /Deterministic fake artifact/u);
  assert.deepEqual(events.map((event) => event.type), ["runner.started", "runner.completed"]);
  assert.deepEqual(events[0]?.payload, {
    mode: "fake",
    simulated: true,
    phaseId: "discovery",
    selectedOutputKeys: ["prd", "user-stories"],
    model: null,
    reasoningEffort: null,
    workspaceRevisionToken: null,
    verificationGitState: null,
  });

  const rerun = await new CodexTerminalRunner({ fake: true }).run(
    { executionId: crypto.randomUUID(), project, run, phase, definition, selectedArtifacts: [], ...executionConfig },
    async () => undefined
  );
  assert.notEqual(rerun.artifacts[0]?.contentHash, result.artifacts[0]?.contentHash);

  const unselectedStoriesPath = path.join(root, "docs", "user-stories", "user-stories.md");
  const unselectedStoriesBefore = await readFile(unselectedStoriesPath, "utf8");
  const selectedOnly = await new CodexTerminalRunner({ fake: true }).run(
    {
      executionId: crypto.randomUUID(),
      project,
      run,
      phase,
      definition,
      selectedArtifacts: [],
      ...executionConfig,
      selectedOutputKeys: ["prd"]
    },
    async () => undefined
  );
  assert.deepEqual(selectedOnly.artifacts.map((artifact) => artifact.artifactKey), ["prd"]);
  assert.equal(
    await readFile(unselectedStoriesPath, "utf8"),
    unselectedStoriesBefore,
    "a partial rerun must leave every unselected registered output unchanged"
  );

  const prototypePath = path.join(root, "docs/prototype.html");
  definition.artifacts.push({
    id: "design-prototype",
    owner: "designer",
    relativePath: "docs/prototype.html",
    absolutePath: prototypePath
  });
  const designPhase: PhaseDefinition = {
    id: "design",
    owner: "designer",
    inputs: [],
    outputs: ["design-prototype"],
    gate: "human review"
  };
  const prototypeRequest = {
    project,
    run,
    phase: designPhase,
    definition,
    selectedArtifacts: [],
    ...executionConfig,
    selectedOutputKeys: ["design-prototype"]
  };
  const prototypeExecutionId = crypto.randomUUID();
  const prototypePrompt = buildTaskEnvelope({
    ...prototypeRequest,
    executionId: prototypeExecutionId,
  });
  assert.match(
    prototypePrompt,
    new RegExp(`<!-- ai-sdlc:execution:${prototypeExecutionId} -->`, "u"),
  );
  assert.match(prototypePrompt, /不得仅检查旧文件后原样保留/u);
  const prototype = await new CodexTerminalRunner({ fake: true }).run(
    { ...prototypeRequest, executionId: prototypeExecutionId },
    async () => undefined
  );
  assert.match(prototype.artifacts[0]?.content ?? "", /<!doctype html>/u);
  await assert.rejects(
    () => new CodexTerminalRunner({ fake: true }).run(
      { ...prototypeRequest, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    /可选设计产物没有更新/u
  );

  definition.artifacts.push({
    id: "figma-handoff",
    owner: "designer",
    relativePath: "docs/figma-handoff.md",
    absolutePath: path.join(root, "docs/figma-handoff.md")
  });
  await assert.rejects(
    () => new CodexTerminalRunner({ fake: true }).run(
      {
        ...prototypeRequest,
        executionId: crypto.randomUUID(),
        selectedOutputKeys: ["figma-handoff"]
      },
      async () => undefined
    ),
    /只能由真实 Codex Runner/u
  );
});

test("a design spec is written to the current task path and never to the default basename", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "designer.toml"), "name='designer'\n", "utf8");
  const now = new Date().toISOString();
  const phase: PhaseDefinition = {
    id: "design",
    owner: "designer",
    inputs: [],
    outputs: ["design-spec"],
    gate: "human review"
  };
  const baseDefinition: LoadedDefinition = {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [{ id: "designer", name: "Designer", mission: "Design", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [{
      id: "design-spec",
      owner: "designer",
      relativePath: "docs/design-spec.md",
      absolutePath: path.join(root, "docs", "design-spec.md")
    }],
    configPath: path.join(root, "ai-native.yaml")
  };
  const project: ProjectDto = {
    id: crypto.randomUUID(),
    name: "Demo",
    summary: "Demo",
    rootPath: root,
    configPath: baseDefinition.configPath,
    runCount: 0,
    createdAt: now,
    updatedAt: now
  };
  const run: WorkflowRunDto = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    projectId: project.id,
    title: "登录体验改版",
    objective: "Define the login experience",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const definition = resolveTaskArtifactPaths(baseDefinition, run);
  const result = await new CodexTerminalRunner({ fake: true }).run(
    {
      executionId: crypto.randomUUID(),
      project,
      run,
      phase,
      definition,
      selectedArtifacts: [],
      selectedOutputKeys: ["design-spec"],
      ...executionConfig
    },
    async () => undefined
  );

  const expectedRelativePath = `docs/登录体验改版--${run.id}-design-spec.md`;
  assert.equal(result.artifacts[0]?.filePath, expectedRelativePath);
  assert.match(await readFile(path.join(root, expectedRelativePath), "utf8"), /登录体验改版/u);
  await assert.rejects(() => readFile(path.join(root, "docs", "design-spec.md"), "utf8"), /ENOENT/u);
});

test("the architect envelope reconciles pause points with selected output materialization", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "architect.toml"), "name='architect'\n", "utf8");
  await mkdir(path.join(root, "docs", "ai-native", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "ai-native", "architecture", "architecture.md"),
    "# Uncommitted checkpoint residue\n",
    "utf8",
  );
  const now = new Date().toISOString();
  const outputDefinitions = [
    ["architecture", "architecture.md"],
    ["architecture-discovery-context", "00-discovery-context.md"],
    ["architecture-options", "00-options.md"],
    ["architecture-c4-context", "01-context.mmd"],
    ["architecture-c4-containers", "02-containers.mmd"],
    ["architecture-adrs", "04-adrs"],
    ["architecture-patterns", "05-patterns.md"],
    ["architecture-nfrs", "06-nfrs.md"],
    ["architecture-adversarial", "07-adversarial.md"],
  ] as const;
  const phase: PhaseDefinition = {
    id: "architecture",
    owner: "architect",
    inputs: ["prd", "user-stories", "design-spec"],
    outputs: outputDefinitions.map(([id]) => id),
    gate: "human architecture acceptance",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [{ id: "architect", name: "Architect", mission: "Decide", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: outputDefinitions.map(([id, fileName]) => ({
      id,
      owner: "architect",
      relativePath: `docs/ai-native/architecture/${fileName}`,
      absolutePath: path.join(root, "docs", "ai-native", "architecture", fileName),
    })),
    configPath: path.join(root, "ai-native.yaml"),
  };
  const project: ProjectDto = {
    id: crypto.randomUUID(),
    name: "Demo",
    summary: "Demo",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(),
    projectId: project.id,
    title: "Architecture checkpoint",
    objective: "Choose an evidence-backed architecture",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const request = {
    executionId: crypto.randomUUID(),
    project,
    run,
    phase,
    definition,
    selectedArtifacts: [],
    selectedOutputKeys: phase.outputs,
    ...executionConfig,
  };
  const prompt = buildTaskEnvelope(request);

  for (const [id, fileName] of outputDefinitions) {
    assert.match(prompt, new RegExp(`- ${id}: docs/ai-native/architecture/${fileName}`, "u"));
  }
  assert.match(prompt, /每一个输出路径都必须存在且包含非空白内容/u);
  assert.match(prompt, /stop、pause[\s\S]*不允许省略/u);
  assert.match(prompt, /没有人类选项选择证据[\s\S]*pending scaffold/u);
  assert.match(prompt, /C4 `\.mmd`[\s\S]*可渲染的 Mermaid pending notice/u);
  assert.match(prompt, /ADR 目录至少写入 `README\.md`[\s\S]*不是 ADR/u);
  assert.match(prompt, /Pending scaffold 不是有效的 C4[\s\S]*不得把架构阶段标为可实施或已接受/u);
  assert.match(prompt, /没有对应的当前 artifact revision[\s\S]*architecture[\s\S]*实际重写/u);

  const discoveryPath = path.join(root, "docs", "ai-native", "architecture", "00-discovery-context.md");
  const discoveryBefore = "# Reviewed discovery context\n";
  await writeFile(discoveryPath, discoveryBefore, "utf8");
  const strictStub = path.join(root, "strict-refresh-stub.mjs");
  await writeFile(strictStub, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'writeFileSync(path.join(process.cwd(), "docs", "ai-native", "architecture", "architecture.md"), "# Selected architecture\\n", "utf8");',
    "",
  ].join("\n"), "utf8");
  await chmod(strictStub, 0o755);
  const currentArtifacts = [
    {
      id: crypto.randomUUID(),
      phaseRunId: crypto.randomUUID(),
      artifactKey: "architecture",
      filePath: "docs/ai-native/architecture/architecture.md",
      content: "# Uncommitted checkpoint residue\n",
      contentHash: "a".repeat(64),
      reviewStatus: "changes_requested" as const,
      revision: 1,
      revisionSource: "ai" as const,
      parentArtifactId: null,
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      phaseRunId: crypto.randomUUID(),
      artifactKey: "architecture-discovery-context",
      filePath: "docs/ai-native/architecture/00-discovery-context.md",
      content: discoveryBefore,
      contentHash: "b".repeat(64),
      reviewStatus: "changes_requested" as const,
      revision: 1,
      revisionSource: "ai" as const,
      parentArtifactId: null,
      createdAt: now,
    },
  ];
  const architectureSelection = {
    optionId: "B",
    reviewId: "review-newest",
    optionsArtifactId: "options-v1",
    selectedAt: "2026-08-18T08:00:00.000Z",
  };
  assert.match(
    buildTaskEnvelope({
      ...request,
      selectedOutputKeys: ["architecture", "architecture-discovery-context"],
      currentArtifacts,
      requireEverySelectedOutputUpdated: true,
      architectureSelection,
    }),
    /有效人工选型之后[\s\S]*每一个 selected 输出都必须[\s\S]*完全相同[\s\S]*拒绝整次执行并回滚/u,
  );
  const selectedStatePrompt = buildTaskEnvelope({
    ...request,
    selectedOutputKeys: ["architecture"],
    currentArtifacts,
    revisionFeedback: ["Selected option: A", "consider another change"],
    architectureSelection,
  });
  assert.match(
    selectedStatePrompt,
    /平台验证的架构选型[\s\S]*Selected option: B[\s\S]*review-newest[\s\S]*options-v1[\s\S]*若普通反馈中出现其他 Option[\s\S]*以本区块为准/u,
  );
  assert.match(
    selectedStatePrompt,
    /Discovery \/ Options 是已评审的人类选型 checkpoint[\s\S]*architecture-discovery-context: docs\/ai-native\/architecture\/00-discovery-context\.md[\s\S]*architecture-options: docs\/ai-native\/architecture\/00-options\.md[\s\S]*不得为了记录本次 selection 而修正、刷新或补写/u,
  );
  assert.match(
    selectedStatePrompt,
    /受保护的未选中输出（只读）[\s\S]*architecture-discovery-context: docs\/ai-native\/architecture\/00-discovery-context\.md[\s\S]*architecture-options: docs\/ai-native\/architecture\/00-options\.md[\s\S]*只读清单优先于角色文件/u,
  );
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: strictStub, fake: false }).run(
      {
        ...request,
        executionId: crypto.randomUUID(),
        selectedOutputKeys: ["architecture", "architecture-discovery-context"],
        currentArtifacts,
        requireEverySelectedOutputUpdated: true,
        architectureSelection,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "SELECTED_OUTPUTS_UNCHANGED");
      assert.deepEqual(
        (error as { details?: { unchanged?: string[] } }).details?.unchanged,
        ["architecture-discovery-context"],
      );
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(root, "docs", "ai-native", "architecture", "architecture.md"), "utf8"),
    "# Uncommitted checkpoint residue\n",
  );
  assert.equal(await readFile(discoveryPath, "utf8"), discoveryBefore);

  const partialStub = path.join(root, "partial-architect-stub.mjs");
  await writeFile(partialStub, [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'const output = path.join(process.cwd(), "docs", "ai-native", "architecture");',
    "mkdirSync(output, { recursive: true });",
    'writeFileSync(path.join(output, "architecture.md"), "# Awaiting human selection\\n", "utf8");',
    'writeFileSync(path.join(output, "00-discovery-context.md"), "# Context\\n", "utf8");',
    'writeFileSync(path.join(output, "00-options.md"), "# Options\\n", "utf8");',
    "",
  ].join("\n"), "utf8");
  await chmod(partialStub, 0o755);

  await assert.rejects(
    () => new CodexTerminalRunner({ binary: partialStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "OUTPUT_ARTIFACTS_MISSING");
      assert.deepEqual(
        (error as { details?: { missing?: string[] } }).details?.missing,
        [
          "architecture-c4-context (docs/ai-native/architecture/01-context.mmd)",
          "architecture-c4-containers (docs/ai-native/architecture/02-containers.mmd)",
          "architecture-adrs (docs/ai-native/architecture/04-adrs)",
          "architecture-patterns (docs/ai-native/architecture/05-patterns.md)",
          "architecture-nfrs (docs/ai-native/architecture/06-nfrs.md)",
          "architecture-adversarial (docs/ai-native/architecture/07-adversarial.md)",
        ],
      );
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(root, "docs", "ai-native", "architecture", "architecture.md"), "utf8"),
    "# Uncommitted checkpoint residue\n",
  );
  await assert.rejects(
    () => readFile(path.join(root, "docs", "ai-native", "architecture", "00-options.md"), "utf8"),
    /ENOENT/u,
  );

  const mutateRulebookStub = path.join(root, "mutate-rulebook-stub.mjs");
  await writeFile(mutateRulebookStub, [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'const output = path.join(process.cwd(), "docs", "ai-native", "architecture");',
    'const rules = path.join(process.cwd(), ".ai-sdlc", "roles", "architect", "references", "rules");',
    "mkdirSync(output, { recursive: true });",
    "mkdirSync(rules, { recursive: true });",
    'writeFileSync(path.join(output, "architecture.md"), "# Mutated selected output\\n", "utf8");',
    'writeFileSync(path.join(rules, "api.md"), "# Mutated rulebook\\n", "utf8");',
    "",
  ].join("\n"), "utf8");
  await chmod(mutateRulebookStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: mutateRulebookStub, fake: false }).run(
      {
        ...request,
        executionId: crypto.randomUUID(),
        selectedOutputKeys: ["architecture"],
        currentArtifacts,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.deepEqual(
        (error as { details?: { changed?: string[] } }).details?.changed,
        ["architect-rulebook-packs"],
      );
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(root, "docs", "ai-native", "architecture", "architecture.md"), "utf8"),
    "# Uncommitted checkpoint residue\n",
  );
  await assert.rejects(
    () => readFile(path.join(root, ".ai-sdlc", "roles", "architect", "references", "rules", "api.md"), "utf8"),
    /ENOENT/u,
  );
});

test("real Codex runner spawns the configured binary and consumes JSONL output", async () => {
  const temporaryRoot = path.join(process.cwd(), ".test-tmp-");
  const root = await mkdtemp(temporaryRoot);
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "pm-ba.toml"), "name='pm-ba'\n", "utf8");

  const stubPath = path.join(root, "codex-stub.mjs");
  const eventSecret = "connector-event-secret-value";
  const eventSignedUrl = "https://signed.example.test/private?token=event-secret";
  await writeFile(
    stubPath,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const chunks = [];",
      'process.stdin.setEncoding("utf8");',
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      'writeFileSync(path.join(process.cwd(), "stub-args.json"), JSON.stringify(process.argv.slice(2)), "utf8");',
      'writeFileSync(path.join(process.cwd(), "stub-prompt.txt"), chunks.join(""), "utf8");',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      'writeFileSync(path.join(process.cwd(), "docs", "prd.md"), "# Stub PRD\\n\\nGenerated without a real model.\\n", "utf8");',
      'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "stub-thread" })}\\n`);',
      `process.stdout.write(JSON.stringify({ type: ${JSON.stringify(`Bearer ${eventSecret}`)}, item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", arguments: { authorization: ${JSON.stringify(`Bearer ${eventSecret}`)} }, result: { url: ${JSON.stringify(eventSignedUrl)} } } }) + "\\n");`,
      'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", command: "node --test", exit_code: 0 } })}\\n`);',
      'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "stub completed" } })}\\n`);',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(stubPath, 0o755);

  const now = new Date().toISOString();
  const executionId = crypto.randomUUID();
  const phase: PhaseDefinition = {
    id: "discovery",
    owner: "pm-ba",
    inputs: [],
    outputs: ["prd"],
    gate: "human review"
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [{ id: "pm-ba", name: "PM", mission: "Stories", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [
      { id: "prd", owner: "pm-ba", relativePath: "docs/prd.md", absolutePath: path.join(root, "docs/prd.md") }
    ],
    configPath: path.join(root, "ai-native.yaml")
  };
  const project: ProjectDto = {
    id: crypto.randomUUID(),
    name: "Demo",
    summary: "Demo",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 0,
    createdAt: now,
    updatedAt: now
  };
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(),
    projectId: project.id,
    title: "Hermetic real runner",
    objective: "Exercise the spawn protocol without a model",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const events: Array<{ type: string; payload: unknown }> = [];
  const runner = new CodexTerminalRunner({ binary: stubPath, fake: false });

  assert.equal(runner.mode(), "real");
  assert.equal(
    runner.commandLabel(executionConfig),
    'codex-stub.mjs --dangerously-bypass-approvals-and-sandbox exec --model gpt-5.6-sol --config model_reasoning_effort="high" --json --color never'
  );
  const result = await runner.run(
    {
      executionId,
      project,
      run,
      phase,
      definition,
      selectedArtifacts: [],
      currentArtifacts: [{
        id: crypto.randomUUID(),
        phaseRunId: crypto.randomUUID(),
        artifactKey: "prd",
        filePath: "docs/prd.md",
        content: "# Human-adjusted PRD\n",
        contentHash: "a".repeat(64),
        reviewStatus: "changes_requested",
        revision: 2,
        revisionSource: "human",
        parentArtifactId: crypto.randomUUID(),
        createdAt: now
      }],
      revisionFeedback: ["Keep the approved scope and tighten the acceptance wording."],
      ...executionConfig
    },
    async (type, payload) => { events.push({ type, payload }); }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.artifactKey, "prd");
  assert.match(result.artifacts[0]?.content ?? "", /Generated without a real model/u);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "stub-args.json"), "utf8")),
    [
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      root,
      "-"
    ]
  );

  const prompt = await readFile(path.join(root, "stub-prompt.txt"), "utf8");
  assert.match(prompt, new RegExp(`Run: ${executionSafe(run.id)}`, "u"));
  assert.match(prompt, /任务: Hermetic real runner/u);
  assert.match(prompt, /当前阶段: discovery/u);
  assert.match(prompt, /Codex model: gpt-5\.6-sol/u);
  assert.match(prompt, /Reasoning effort: high/u);
  assert.match(prompt, /\.codex\/agents\/pm-ba\.toml/u);
  assert.match(prompt, /- prd: docs\/prd\.md/u);
  assert.match(prompt, /当前阶段已有的最新产物版本/u);
  assert.match(prompt, /Human-adjusted PRD/u);
  assert.match(prompt, /Revision source: human/u);
  assert.match(prompt, /Keep the approved scope and tighten the acceptance wording\./u);
  assert.match(prompt, /未被选中的输出必须保持原样/u);
  assert.deepEqual(events.map((event) => event.type), [
    "runner.started",
    "thread.started",
    "codex.event",
    "item.completed",
    "item.completed",
    "runner.completed"
  ]);
  assert.deepEqual(events[0]?.payload, {
    mode: "real",
    command: runner.commandLabel(executionConfig),
    workingDirectory: root,
    phaseId: "discovery",
    selectedOutputKeys: ["prd"],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    figmaTargetMode: null,
    workspaceRevisionToken: null,
    verificationGitState: null,
  });
  assert.deepEqual(events[1]?.payload, { type: "thread.started" });
  assert.deepEqual(events[2]?.payload, {
    type: "codex.event",
    item: {
      type: "mcp_tool_call",
      status: "completed",
      server: "figma",
      tool: "generate_figma_design",
      argumentsRedacted: true,
      resultRedacted: true
    }
  });
  assert.deepEqual(events[3]?.payload, {
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      exit_code: 0,
      commandRedacted: true,
      commandHash: createHash("sha256").update("node --test").digest("hex"),
    },
  });
  assert.deepEqual(events[4]?.payload, {
    type: "item.completed",
    item: { type: "agent_message", textBytes: 14 }
  });
  const persistedEvents = JSON.stringify(events);
  assert.doesNotMatch(persistedEvents, new RegExp(eventSecret, "u"));
  assert.doesNotMatch(persistedEvents, /signed\.example\.test/u);

  const secret = "stderr-secret-token-value";
  const failingStubPath = path.join(root, "codex-failing-stub.mjs");
  await writeFile(
    failingStubPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'writeFileSync(path.join(process.cwd(), "docs", "prd.md"), "selected mutation before failure", "utf8");',
      'writeFileSync(path.join(process.cwd(), "docs", "architecture.md"), "mutated before failure", "utf8");',
      `process.stderr.write(${JSON.stringify(`authorization: Bearer ${secret}`)} + "x".repeat(4096));`,
      "process.exit(7);",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(failingStubPath, 0o755);
  const selectedPath = path.join(root, "docs", "prd.md");
  const selectedBeforeFailure = await readFile(selectedPath, "utf8");
  const protectedPath = path.join(root, "docs", "architecture.md");
  await writeFile(protectedPath, "original unselected bytes", "utf8");
  const protectedDefinition: LoadedDefinition = {
    ...definition,
    artifacts: [
      ...definition.artifacts,
      {
        id: "architecture",
        owner: "architect",
        relativePath: "docs/architecture.md",
        absolutePath: protectedPath,
      },
    ],
  };
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: failingStubPath, fake: false, maxStderrBytes: 64 }).run(
      {
        executionId: crypto.randomUUID(),
        project,
        run,
        phase,
        definition: protectedDefinition,
        selectedArtifacts: [],
        ...executionConfig,
      },
      async () => undefined
    ),
    (error: unknown) => {
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(secret, "u"));
      assert.doesNotMatch(serialized, new RegExp(secret, "u"));
      assert.match(error instanceof Error ? error.message : String(error), /exit 7/u);
      assert.equal(
        (error as { details?: { diagnosticBytes?: number } }).details?.diagnosticBytes,
        64
      );
      return true;
    }
  );
  assert.equal(
    await readFile(selectedPath, "utf8"),
    selectedBeforeFailure,
    "runner failures must restore every selected output before returning",
  );
  assert.equal(
    await readFile(protectedPath, "utf8"),
    "original unselected bytes",
    "runner failures must restore every unselected output before returning",
  );

  const oversizedStdoutStubPath = path.join(root, "codex-oversized-stdout-stub.mjs");
  await writeFile(
    oversizedStdoutStubPath,
    [
      "#!/usr/bin/env node",
      'process.stdout.write("x".repeat(4096));',
      "setTimeout(() => process.exit(0), 1000);",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(oversizedStdoutStubPath, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({
      binary: oversizedStdoutStubPath,
      fake: false,
      maxStdoutBytes: 8_192,
      maxStdoutLineBytes: 128
    }).run(
      { executionId: crypto.randomUUID(), project, run, phase, definition, selectedArtifacts: [], ...executionConfig },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CODEX_OUTPUT_LIMIT_EXCEEDED");
      assert.equal(
        (error as { details?: { limitType?: string } }).details?.limitType,
        "line_bytes"
      );
      return true;
    }
  );
});

test("a successful runner that mutates an unselected output restores every touched artifact", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "pm-ba.toml"), "name='pm-ba'\n", "utf8");

  const selectedPath = path.join(root, "docs", "prd.md");
  const unselectedPath = path.join(root, "docs", "architecture.md");
  const selectedBefore = "# Original PRD\n";
  const unselectedBefore = "# Original architecture\n";
  await writeFile(selectedPath, selectedBefore, "utf8");
  await writeFile(unselectedPath, unselectedBefore, "utf8");

  const stubPath = path.join(root, "codex-scope-violation-stub.mjs");
  await writeFile(
    stubPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      'writeFileSync(path.join(process.cwd(), "docs", "prd.md"), "# Updated PRD\\n", "utf8");',
      'writeFileSync(path.join(process.cwd(), "docs", "architecture.md"), "# Out-of-scope architecture\\n", "utf8");',
      'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "scope-violation" })}\\n`);',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(stubPath, 0o755);

  const now = new Date().toISOString();
  const phase: PhaseDefinition = {
    id: "discovery",
    owner: "pm-ba",
    inputs: [],
    outputs: ["prd"],
    gate: "human review",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Scope guard", summary: "Runner rollback regression" },
    roles: [{ id: "pm-ba", name: "PM", mission: "Stories", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [
      {
        id: "prd",
        owner: "pm-ba",
        relativePath: "docs/prd.md",
        absolutePath: selectedPath,
      },
      {
        id: "architecture",
        owner: "architect",
        relativePath: "docs/architecture.md",
        absolutePath: unselectedPath,
      },
    ],
    configPath: path.join(root, "ai-native.yaml"),
  };
  const project: ProjectDto = {
    id: crypto.randomUUID(),
    name: "Scope guard",
    summary: "Runner rollback regression",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(),
    projectId: project.id,
    title: "Scope guard",
    objective: "Reject out-of-scope writes atomically",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await assert.rejects(
    () => new CodexTerminalRunner({ binary: stubPath, fake: false }).run(
      {
        executionId: crypto.randomUUID(),
        project,
        run,
        phase,
        definition,
        selectedArtifacts: [],
        selectedOutputKeys: ["prd"],
        ...executionConfig,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.deepEqual(
        (error as { details?: { changed?: string[]; restored?: boolean } }).details,
        { changed: ["architecture"], restored: true },
      );
      return true;
    },
  );
  assert.equal(
    await readFile(selectedPath, "utf8"),
    selectedBefore,
    "the selected write must roll back when the later scope validation rejects the run",
  );
  assert.equal(
    await readFile(unselectedPath, "utf8"),
    unselectedBefore,
    "the unselected write must be restored before the scope error is returned",
  );
});

test("real Figma output requires a successful matching MCP or Desktop connector write event", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "designer.toml"), "name='designer'\n", "utf8");
  const artifactPath = path.join(root, "docs", "figma-handoff.md");
  const figmaUrl = "https://www.figma.com/design/file-123/demo?node-id=1-2";
  const phase: PhaseDefinition = {
    id: "design",
    owner: "designer",
    inputs: [],
    outputs: ["figma-handoff"],
    gate: "human review"
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Figma", summary: "Figma evidence" },
    roles: [{ id: "designer", name: "Designer", mission: "Design", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [{
      id: "figma-handoff",
      owner: "designer",
      relativePath: "docs/figma-handoff.md",
      absolutePath: artifactPath
    }],
    configPath: path.join(root, "ai-native.yaml")
  };
  const now = new Date().toISOString();
  const project: ProjectDto = {
    id: crypto.randomUUID(), name: "Figma", summary: "Figma", rootPath: root,
    configPath: definition.configPath, runCount: 0, createdAt: now, updatedAt: now
  };
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(), projectId: project.id, title: "Figma design",
    objective: "Create the selected Figma design", status: "active", createdAt: now, updatedAt: now
  };
  const request = {
    project,
    run,
    phase,
    definition,
    selectedArtifacts: [],
    ...executionConfig,
    selectedOutputKeys: ["figma-handoff"],
    figmaTarget: {
      mode: "existing_file" as const,
      fileUrl: "https://www.figma.com/design/file-123",
      fileKey: "file-123",
    },
  };

  const noWriteStub = path.join(root, "codex-without-figma-write.mjs");
  await writeFile(
    noWriteStub,
    [
      "#!/usr/bin/env node",
      'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "target was not selected" } })}\\n`);',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(noWriteStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: noWriteStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_WRITE_NOT_ATTEMPTED");
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        "NO_FIGMA_WRITE_CALL"
      );
      assert.doesNotMatch((error as Error).message, /Codex 未生成所有必需产物/u);
      return true;
    }
  );
  await assert.rejects(
    () => readFile(artifactPath, "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
  );

  const noEvidenceStub = path.join(root, "codex-no-figma-evidence.mjs");
  await writeFile(
    noEvidenceStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${figmaUrl}\n- Node ID: 1:2\n- Evidence: unverified\n`)}, "utf8");`,
      'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "claimed done" } })}\\n`);',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(noEvidenceStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: noEvidenceStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_WRITE_NOT_ATTEMPTED");
      return true;
    }
  );

  const prefixUrlStub = path.join(root, "codex-with-prefix-figma-url.mjs");
  const prefixFigmaUrl = "https://www.figma.com/design/file-12/demo?node-id=1-2";
  await writeFile(
    prefixUrlStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${prefixFigmaUrl}\n- Node ID: 1:2\n- Evidence: prefix collision\n`)}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "file-123" }, result: { url: ${JSON.stringify(figmaUrl)}, fileKey: "file-123", nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(prefixUrlStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: prefixUrlStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    /没有可验证的 Figma 写入证据/u
  );

  const evidenceStub = path.join(root, "codex-with-figma-evidence.mjs");
  await writeFile(
    evidenceStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${figmaUrl}\n- Node ID: 1:2\n- Evidence: verified in this execution\n`)}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "file-123" }, result: { url: ${JSON.stringify(figmaUrl)}, fileKey: "file-123", nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(evidenceStub, 0o755);
  const result = await new CodexTerminalRunner({ binary: evidenceStub, fake: false }).run(
    { ...request, executionId: crypto.randomUUID() },
    async () => undefined
  );
  assert.equal(result.artifacts[0]?.artifactKey, "figma-handoff");
  assert.match(result.artifacts[0]?.content ?? "", /verified in this execution/u);

  const connectorContexts = [
    {
      name: "camel",
      tool: "use_figma",
      context: {
        appContext: {
          connectorId: "connector_68df038e0ba48191908c8434991bbac2",
          appName: "Figma",
          actionName: "generate_figma_design"
        }
      }
    },
    {
      name: "snake",
      tool: "use_figma",
      context: {
        app_context: {
          connector_id: "connector_68df038e0ba48191908c8434991bbac2",
          app_name: "Figma",
          action_name: "generate_figma_design"
        }
      }
    },
    {
      name: "action",
      tool: "call_app",
      context: {
        appContext: {
          connectorId: "connector_68df038e0ba48191908c8434991bbac2",
          appName: "Figma",
          actionName: "use_figma"
        }
      }
    },
    {
      name: "cli-namespaced",
      tool: "figma.use_figma",
      context: {}
    }
  ] as const;

  const readOnlyConnectorStub = path.join(root, "codex-with-read-only-figma-connector.mjs");
  const readOnlyConnectorEvent = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex_apps",
      tool: "use_figma",
      status: "completed",
      error: null,
      arguments: {
        fileKey: "file-123",
        code: "const example = 'figma.createFrame()'; const labels = new Map(); labels.set('page', figma.currentPage.name); return figma.currentPage.children.map((node) => node.id);"
      },
      result: { url: figmaUrl, nodeIds: ["1:2"] },
      appContext: {
        connectorId: "connector_68df038e0ba48191908c8434991bbac2",
        appName: "Figma",
        actionName: "get_file"
      }
    }
  };
  await writeFile(
    readOnlyConnectorStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${figmaUrl}\n- Node ID: 1:2\n- Evidence: read-only connector\n`)}, "utf8");`,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(readOnlyConnectorEvent)}\n`)});`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(readOnlyConnectorStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: readOnlyConnectorStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_WRITE_NOT_ATTEMPTED");
      return true;
    }
  );

  for (const connector of connectorContexts) {
    const connectorStub = path.join(root, `codex-with-figma-connector-${connector.name}.mjs`);
    const connectorContent = `# Figma handoff\n\n- URL: ${figmaUrl}\n- Node ID: 1:2\n- Evidence: ${connector.name} connector verified\n`;
    const connectorEvent = {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "codex_apps",
        tool: connector.tool,
        status: "completed",
        error: null,
        arguments: {
          fileKey: "file-123",
          code: "const frame = figma.createFrame(); frame.name = 'AI SDLC prototype'; return { nodeIds: [frame.id] };"
        },
        result: connector.name === "action"
          ? { nodeIds: ["1:2"] }
          : { url: figmaUrl, fileKey: "file-123", nodeIds: ["1:2"] },
        ...connector.context
      }
    };
    await writeFile(
      connectorStub,
      [
        "#!/usr/bin/env node",
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
        `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(connectorContent)}, "utf8");`,
        `process.stdout.write(${JSON.stringify(`${JSON.stringify(connectorEvent)}\n`)});`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(connectorStub, 0o755);
    const connectorResult = await new CodexTerminalRunner({ binary: connectorStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    );
    assert.match(connectorResult.artifacts[0]?.content ?? "", new RegExp(connector.name, "u"));
  }

  const wrongTargetStub = path.join(root, "codex-with-wrong-figma-target.mjs");
  await writeFile(
    wrongTargetStub,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "other-file-999" }, result: { url: "https://www.figma.com/design/other-file-999/demo?node-id=1-2", fileKey: "other-file-999", nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(wrongTargetStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: wrongTargetStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_TARGET_MISMATCH");
      return true;
    }
  );

  const targetMentionOnlyStub = path.join(root, "codex-with-target-mentioned-only.mjs");
  await writeFile(
    targetMentionOnlyStub,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "use_figma", status: "completed", error: null, arguments: { fileKey: "other-file-999", code: "const ref = 'https://www.figma.com/design/file-123/demo'; const frame = figma.createFrame(); return frame.id;" }, result: { nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(targetMentionOnlyStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: targetMentionOnlyStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_TARGET_MISMATCH");
      return true;
    }
  );

  const ratioOnlyResultStub = path.join(root, "codex-with-ratio-only-result.mjs");
  await writeFile(
    ratioOnlyResultStub,
    [
      "#!/usr/bin/env node",
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "use_figma", status: "completed", error: null, arguments: { fileKey: "file-123", code: "const frame = figma.createFrame(); return frame.id;" }, result: { message: "layout ratio 1:2" } } }) + "\\n");',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(ratioOnlyResultStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: ratioOnlyResultStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_TARGET_MISMATCH");
      return true;
    }
  );

  for (const conflict of [
    {
      name: "conflicting-argument-file-key",
      arguments: {
        fileKey: "file-123",
        metadata: { fileKey: "other-file-999" },
        code: "const frame = figma.createFrame(); return frame.id;",
      },
      result: { nodeIds: ["1:2"] },
    },
    {
      name: "conflicting-result-file-key",
      arguments: {
        fileKey: "file-123",
        code: "const frame = figma.createFrame(); return frame.id;",
      },
      result: {
        fileKey: "file-123",
        metadata: { fileKey: "other-file-999" },
        nodeIds: ["1:2"],
      },
    },
  ]) {
    const conflictStub = path.join(root, `codex-with-${conflict.name}.mjs`);
    await writeFile(
      conflictStub,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "use_figma", status: "completed", error: null, arguments: ${JSON.stringify(conflict.arguments)}, result: ${JSON.stringify(conflict.result)} } }) + "\\n");`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(conflictStub, 0o755);
    await assert.rejects(
      () => new CodexTerminalRunner({ binary: conflictStub, fake: false }).run(
        { ...request, executionId: crypto.randomUUID() },
        async () => undefined
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "FIGMA_TARGET_MISMATCH");
        return true;
      },
      conflict.name,
    );
  }

  const unrelatedRatioHandoffStub = path.join(root, "codex-with-unrelated-node-ratio.mjs");
  await writeFile(
    unrelatedRatioHandoffStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify("# Figma handoff\n\n- Figma File URL: https://www.figma.com/design/file-123/demo\n- Node ID: 9:9\n- Layout ratio observed: 1:2\n")}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "file-123" }, result: { url: ${JSON.stringify(figmaUrl)}, nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(unrelatedRatioHandoffStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: unrelatedRatioHandoffStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_EXECUTION_UNVERIFIED");
      return true;
    }
  );

  const multipleFileHandoffStub = path.join(root, "codex-with-multiple-handoff-files.mjs");
  await writeFile(
    multipleFileHandoffStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- Figma File URL: ${figmaUrl}\n- Figma File URL: https://www.figma.com/design/other-file-999/other\n- Node ID: 1:2\n`)}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "file-123" }, result: { url: ${JSON.stringify(figmaUrl)}, nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(multipleFileHandoffStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: multipleFileHandoffStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_EXECUTION_UNVERIFIED");
      return true;
    }
  );

  const privateDraftTarget = {
    mode: "new_private_draft" as const,
    planKey: "team::100",
    fileName: "AI SDLC private draft",
  };
  const privateDraftUrl = "https://www.figma.com/design/new-file-456/private-draft?node-id=9-10";
  const createOnlyStub = path.join(root, "codex-with-empty-figma-draft.mjs");
  await writeFile(
    createOnlyStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${privateDraftUrl}\n- Node ID: 9:10\n- Evidence: blank file only\n`)}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "create_new_file", status: "completed", error: null, arguments: { planKey: "team::100", fileName: "AI SDLC private draft", editorType: "design" }, result: { url: ${JSON.stringify(privateDraftUrl)}, fileKey: "new-file-456" } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(createOnlyStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: createOnlyStub, fake: false }).run(
      {
        ...request,
        executionId: crypto.randomUUID(),
        figmaTarget: privateDraftTarget,
      },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_DESIGN_WRITE_NOT_COMPLETED");
      assert.equal(
        (error as { details?: { createCallMatched?: boolean } }).details?.createCallMatched,
        true,
      );
      return true;
    }
  );

  for (const invalidCreate of [
    {
      name: "wrong-editor",
      arguments: {
        planKey: "team::100",
        fileName: "AI SDLC private draft",
        editorType: "figjam",
      },
    },
    {
      name: "project-placement",
      arguments: {
        planKey: "team::100",
        fileName: "AI SDLC private draft",
        editorType: "design",
        projectId: "project-should-be-omitted",
      },
    },
    {
      name: "conflicting-plan-and-name",
      arguments: {
        planKey: "team::100",
        fileName: "AI SDLC private draft",
        editorType: "design",
        metadata: {
          planKey: "team::999",
          fileName: "decoy",
        },
      },
    },
  ]) {
    const invalidCreateStub = path.join(root, `codex-with-${invalidCreate.name}.mjs`);
    await writeFile(
      invalidCreateStub,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "create_new_file", status: "completed", error: null, arguments: ${JSON.stringify(invalidCreate.arguments)}, result: { url: ${JSON.stringify(privateDraftUrl)}, fileKey: "new-file-456" } } }) + "\\n");`,
        `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "use_figma", status: "completed", error: null, arguments: { fileKey: "new-file-456", code: "const frame = figma.createFrame(); return frame.id;" }, result: { nodeIds: ["9:10"] } } }) + "\\n");`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(invalidCreateStub, 0o755);
    await assert.rejects(
      () => new CodexTerminalRunner({ binary: invalidCreateStub, fake: false }).run(
        {
          ...request,
          executionId: crypto.randomUUID(),
          figmaTarget: privateDraftTarget,
        },
        async () => undefined
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "FIGMA_TARGET_MISMATCH");
        return true;
      },
      invalidCreate.name,
    );
  }

  const privateDraftStub = path.join(root, "codex-with-private-figma-draft.mjs");
  await writeFile(
    privateDraftStub,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });',
      `writeFileSync(path.join(process.cwd(), "docs", "figma-handoff.md"), ${JSON.stringify(`# Figma handoff\n\n- URL: ${privateDraftUrl}\n- Node ID: 9:10\n- Evidence: created and populated private Draft\n`)}, "utf8");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "figma.create_new_file", status: "completed", error: null, arguments: { planKey: "team::100", fileName: "AI SDLC private draft", editorType: "design" }, result: { url: ${JSON.stringify(privateDraftUrl)}, fileKey: "new-file-456" } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "figma.use_figma", status: "completed", error: null, arguments: { fileKey: "new-file-456", code: "const frame = figma.createFrame(); frame.name = 'Private Draft'; return frame.id;" }, result: { url: ${JSON.stringify(privateDraftUrl)}, fileKey: "new-file-456", nodeIds: ["9:10"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(privateDraftStub, 0o755);
  const privateDraftResult = await new CodexTerminalRunner({ binary: privateDraftStub, fake: false }).run(
    {
      ...request,
      executionId: crypto.randomUUID(),
      figmaTarget: privateDraftTarget,
    },
    async () => undefined
  );
  assert.match(privateDraftResult.artifacts[0]?.content ?? "", /populated private Draft/u);

  await rm(artifactPath, { force: true });
  const missingHandoffStub = path.join(root, "codex-with-write-but-no-handoff.mjs");
  await writeFile(
    missingHandoffStub,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "generate_figma_design", status: "completed", error: null, arguments: { fileKey: "file-123" }, result: { url: ${JSON.stringify(figmaUrl)}, fileKey: "file-123", nodeIds: ["1:2"] } } }) + "\\n");`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(missingHandoffStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: missingHandoffStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_HANDOFF_MISSING");
      assert.doesNotMatch((error as Error).message, /Codex 未生成所有必需产物/u);
      return true;
    }
  );

  const rateLimitedWriteStub = path.join(root, "codex-with-rate-limited-figma-write.mjs");
  await writeFile(
    rateLimitedWriteStub,
    [
      "#!/usr/bin/env node",
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "figma.use_figma", status: "failed", error: null, arguments: { fileKey: "file-123", code: "const frame = figma.createFrame(); return frame.id;" }, result: { content: [{ type: "text", text: "You have reached the Figma MCP tool call limit on the Starter plan. Upgrade your plan for more tool calls." }], isError: true } } }) + "\\n");',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(rateLimitedWriteStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: rateLimitedWriteStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_RATE_LIMITED");
      assert.match((error as Error).message, /额度已耗尽/u);
      return true;
    }
  );

  const failedWriteStub = path.join(root, "codex-with-failed-figma-write.mjs");
  await writeFile(
    failedWriteStub,
    [
      "#!/usr/bin/env node",
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "figma", tool: "use_figma", status: "failed", error: { message: "permission denied" }, arguments: { fileKey: "file-123", code: "const frame = figma.createFrame(); return frame.id;" } } }) + "\\n");',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(failedWriteStub, 0o755);
  await assert.rejects(
    () => new CodexTerminalRunner({ binary: failedWriteStub, fake: false }).run(
      { ...request, executionId: crypto.randomUUID() },
      async () => undefined
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "FIGMA_WRITE_FAILED");
      return true;
    }
  );
});

function executionSafe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
