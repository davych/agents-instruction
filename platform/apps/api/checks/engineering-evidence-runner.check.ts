import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PhaseDefinition, ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import { buildTaskEnvelope, CodexTerminalRunner } from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";
import { engineeringEvidenceArtifactKeys } from "../src/services/engineering-evidence-validator.ts";

const roots: string[] = [];
const executionConfig = { model: "gpt-5.6-sol", reasoningEffort: "high" as const };

test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("AC-ENG-008: the implementation envelope protects role resources and scopes evidence writes", async () => {
  const fixture = await runnerFixture();
  const selectedOutputKeys = ["implementation-plan", "engineering-test-evidence"];
  const prompt = buildTaskEnvelope({
    executionId: crypto.randomUUID(),
    ...fixture,
    selectedArtifacts: [],
    selectedOutputKeys,
    ...executionConfig,
  });

  assert.match(prompt, /Agent\/角色配置[\s\S]*默认与角色工作流[\s\S]*参考规则[\s\S]*证据模板/u);
  assert.match(prompt, /read[- ]only|只读/iu);
  assert.match(prompt, /source|源码/iu);
  assert.match(prompt, /test|测试/iu);
  assert.match(prompt, /confirmed scope|确认范围|Change Contract 范围/iu);
  assert.match(prompt, /only the selected registered evidence outputs|唯一可写的注册输出|仅.*选中.*注册.*证据/iu);
  assert.match(prompt, /旧证据模板.*机器合同.*不得改写模板/iu);
  assert.match(prompt, /Acceptance coverage.*精确 AC ID.*真实可执行测试路径.*durable Evidence.*Result.*Pass/iu);
  assert.match(prompt, /Verification gates.*下游 Tester.*Outcome.*Known limitations.*Next owner/iu);
  assert.match(prompt, /none found.*durable evidence reference.*not-applicable/iu);
  assert.match(prompt, /PR created or opened by Software Engineer: No.*PR published by Software Engineer: No.*Merge\/deploy\/release performed by Software Engineer: No/iu);
  for (const artifactKey of selectedOutputKeys) {
    assert.match(prompt, new RegExp(`- ${artifactKey}: `, "u"));
  }
});

test("AC-CLARITY-024: the implementation envelope delivers machine repair diagnostics", async () => {
  const fixture = await runnerFixture();
  const selectedOutputKeys = ["implementation-notes", "engineering-review"];
  const prompt = buildTaskEnvelope({
    executionId: crypto.randomUUID(),
    ...fixture,
    selectedArtifacts: [],
    selectedOutputKeys,
    revisionFeedback: [
      "Machine evidence-gate repair feedback:\n- implementation-notes: Status must be exactly Ready for verification\n- engineering-review: section must use the canonical table",
    ],
    ...executionConfig,
  });

  assert.match(prompt, /本次修改反馈[\s\S]*Machine evidence-gate repair feedback/iu);
  assert.match(prompt, /implementation-notes: Status must be exactly Ready for verification/iu);
  assert.match(prompt, /engineering-review: section must use the canonical table/iu);
  assert.match(prompt, /唯一可写的注册输出：implementation-notes, engineering-review/u);
});

test("AC-ENG-003/008: the fake runner writes exactly the selected engineering evidence outputs", async () => {
  const fixture = await runnerFixture();
  const protectedWorkflow = path.join(
    fixture.project.rootPath,
    ".ai-sdlc/roles/software-engineer/workflow.md",
  );
  const workflowBefore = await readFile(protectedWorkflow, "utf8");
  const selectedOutputKeys = [...engineeringEvidenceArtifactKeys];

  const result = await new CodexTerminalRunner({ fake: true }).run(
    {
      executionId: crypto.randomUUID(),
      ...fixture,
      selectedArtifacts: [],
      selectedOutputKeys,
      ...executionConfig,
    },
    async () => undefined,
  );

  assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactKey), selectedOutputKeys);
  assert.equal(new Set(result.artifacts.map((artifact) => artifact.filePath)).size, 7);
  for (const artifact of result.artifacts) {
    assert.match(artifact.content ?? "", /\S/u);
    assert.match(artifact.filePath, new RegExp(fixture.run.id, "u"));
  }
  assert.equal(await readFile(protectedWorkflow, "utf8"), workflowBefore);
});

test("AC-ENG-008: real execution allows scoped code/tests but restores a mutated role pack", async () => {
  const fixture = await runnerFixture();
  const root = fixture.project.rootPath;
  const selected = fixture.definition.artifacts.find(
    (artifact) => artifact.id === "implementation-plan",
  )!;
  await mkdir(path.dirname(selected.absolutePath), { recursive: true });

  const allowedStub = path.join(root, "codex-allowed-engineering-stub.mjs");
  await writeFile(allowedStub, [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'mkdirSync(path.join(process.cwd(), "src"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "test"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "src", "scoped-change.ts"), "export const changed = true;\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "test", "scoped-change.test.ts"), "// independent scoped test\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Updated implementation plan\\n", "utf8");`,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "allowed-engineering" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(allowedStub, 0o755);

  const allowed = await new CodexTerminalRunner({ binary: allowedStub, fake: false }).run(
    {
      executionId: crypto.randomUUID(),
      ...fixture,
      selectedArtifacts: [],
      selectedOutputKeys: ["implementation-plan"],
      ...executionConfig,
    },
    async () => undefined,
  );
  assert.deepEqual(allowed.artifacts.map((artifact) => artifact.artifactKey), ["implementation-plan"]);
  assert.match(await readFile(path.join(root, "src/scoped-change.ts"), "utf8"), /changed = true/u);
  assert.match(await readFile(path.join(root, "test/scoped-change.test.ts"), "utf8"), /independent scoped test/u);

  const protectedWorkflow = path.join(root, ".ai-sdlc/roles/software-engineer/workflow.md");
  const protectedBefore = await readFile(protectedWorkflow, "utf8");
  const maliciousStub = path.join(root, "codex-role-mutation-stub.mjs");
  await writeFile(maliciousStub, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'writeFileSync(path.join(process.cwd(), ".ai-sdlc", "roles", "software-engineer", "workflow.md"), "# Mutated policy\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Second implementation plan\\n", "utf8");`,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "role-mutation" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(maliciousStub, 0o755);

  await assert.rejects(
    () => new CodexTerminalRunner({ binary: maliciousStub, fake: false }).run(
      {
        executionId: crypto.randomUUID(),
        ...fixture,
        selectedArtifacts: [],
        selectedOutputKeys: ["implementation-plan"],
        ...executionConfig,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /protected|role resource|software-engineer(?:\/|-workflow)|受保护|角色资源|未选中的产物.*还原/iu,
      );
      return true;
    },
  );
  assert.equal(await readFile(protectedWorkflow, "utf8"), protectedBefore);
});

test("AC-ENG-008: control or environment mutation rejects execution and rolls back selected evidence", async () => {
  const fixture = await runnerFixture();
  const root = fixture.project.rootPath;
  const selected = fixture.definition.artifacts.find(
    (artifact) => artifact.id === "implementation-plan",
  )!;
  await mkdir(path.dirname(selected.absolutePath), { recursive: true });
  const selectedBefore = "# Original implementation plan\n";
  await writeFile(selected.absolutePath, selectedBefore, "utf8");

  const protectedContents = new Map<string, string>([
    ["ai-native.yaml", "version: 1\nproject:\n  name: Demo\n"],
    ["AGENTS.md", "# Project controls\n"],
    ["CLAUDE.md", "# Client controls\n"],
    [".env", "APP_SECRET=original-root\n"],
    [".env.local", "APP_SECRET=original-local\n"],
    [".env.development", "APP_SECRET=original-development\n"],
    [".env.test", "APP_SECRET=original-test\n"],
    [".env.production", "APP_SECRET=original-production\n"],
  ]);
  await Promise.all(
    [...protectedContents].map(([relativePath, content]) =>
      writeFile(path.join(root, relativePath), content, "utf8")),
  );

  const stub = path.join(root, "codex-control-mutation-stub.mjs");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'mkdirSync(path.join(process.cwd(), "src"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "test"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "src", "protected-attempt.ts"), "export const retained = true;\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "test", "protected-attempt.test.ts"), "// retained independent test\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Retained selected evidence\\n", "utf8");`,
    `for (const relativePath of ${JSON.stringify([...protectedContents.keys()])}) writeFileSync(path.join(process.cwd(), relativePath), "mutated control or environment file\\n", "utf8");`,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "control-mutation" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(stub, 0o755);

  await assert.rejects(
    () => new CodexTerminalRunner({ binary: stub, fake: false }).run(
      {
        executionId: crypto.randomUUID(),
        ...fixture,
        selectedArtifacts: [],
        selectedOutputKeys: ["implementation-plan"],
        ...executionConfig,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /protected|read[- ]only|control|environment|unauthorized|restore|受保护|只读|控制|环境|还原/iu,
      );
      return true;
    },
  );
  for (const [relativePath, content] of protectedContents) {
    assert.equal(await readFile(path.join(root, relativePath), "utf8"), content, relativePath);
  }
  assert.equal(await readFile(selected.absolutePath, "utf8"), selectedBefore);
});

for (const [label, protectedRelativePath] of [
  ["environment file", ".env"],
  ["client-native Agent", ".codex/agents/software-engineer.toml"],
  ["role workflow", ".ai-sdlc/roles/software-engineer/workflow.md"],
] as const) {
  test(`AC-ENG-008: chmod-only mutation of the protected ${label} is rejected and restored`, async () => {
    const fixture = await runnerFixture();
    const root = fixture.project.rootPath;
    const protectedPath = path.join(root, protectedRelativePath);
    if (protectedRelativePath === ".env") {
      await writeFile(protectedPath, "APP_SECRET=original\n", "utf8");
    }
    const protectedContentBefore = await readFile(protectedPath, "utf8");
    await chmod(protectedPath, 0o640);
    const protectedModeBefore = (await stat(protectedPath)).mode & 0o777;

    const selected = fixture.definition.artifacts.find(
      (artifact) => artifact.id === "implementation-plan",
    )!;
    await mkdir(path.dirname(selected.absolutePath), { recursive: true });
    const selectedBefore = "# Original implementation plan before chmod violation\n";
    await writeFile(selected.absolutePath, selectedBefore, "utf8");

    const stub = path.join(root, `codex-chmod-${label.replaceAll(" ", "-")}-stub.mjs`);
    await writeFile(stub, [
      "#!/usr/bin/env node",
      'import { chmodSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      `chmodSync(path.join(process.cwd(), ${JSON.stringify(protectedRelativePath)}), 0o777);`,
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Mutated selected evidence\\n", "utf8");`,
      `process.stdout.write(\`${JSON.stringify({ type: "thread.started", thread_id: `chmod-${label.replaceAll(" ", "-")}` })}\\n\`);`,
      "",
    ].join("\n"), "utf8");
    await chmod(stub, 0o755);

    await assert.rejects(
      () => new CodexTerminalRunner({ binary: stub, fake: false }).run(
        {
          executionId: crypto.randomUUID(),
          ...fixture,
          selectedArtifacts: [],
          selectedOutputKeys: ["implementation-plan"],
          ...executionConfig,
        },
        async () => undefined,
      ),
      (error: unknown) => {
        assert.match(
          error instanceof Error ? error.message : String(error),
          /protected|read[- ]only|role resource|environment|unauthorized|restore|受保护|只读|角色资源|环境|还原/iu,
        );
        return true;
      },
    );

    assert.equal(await readFile(protectedPath, "utf8"), protectedContentBefore);
    assert.equal((await stat(protectedPath)).mode & 0o777, protectedModeBefore);
    assert.equal(await readFile(selected.absolutePath, "utf8"), selectedBefore);
  });
}

for (const [label, protectedRelativePath] of [
  ["project-owned engineer reference", ".ai-sdlc/roles/software-engineer/references/custom-policy.md"],
  ["project-owned evidence template", ".ai-sdlc/templates/custom-project-evidence.md"],
  ["root environment variant", ".env.staging"],
] as const) {
  test(`AC-ENG-008: mutation of a ${label} is rejected, restored, and rolls back selected evidence`, async () => {
    const fixture = await runnerFixture();
    const root = fixture.project.rootPath;
    const protectedPath = path.join(root, protectedRelativePath);
    await mkdir(path.dirname(protectedPath), { recursive: true });
    const protectedBefore = `# Original ${label}\n`;
    await writeFile(protectedPath, protectedBefore, "utf8");

    const selected = fixture.definition.artifacts.find(
      (artifact) => artifact.id === "implementation-plan",
    )!;
    await mkdir(path.dirname(selected.absolutePath), { recursive: true });
    const selectedBefore = "# Original implementation plan before custom resource violation\n";
    await writeFile(selected.absolutePath, selectedBefore, "utf8");

    const stub = path.join(root, `codex-custom-${label.replaceAll(" ", "-")}-stub.mjs`);
    await writeFile(stub, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(protectedRelativePath)}), "# Mutated custom protected resource\\n", "utf8");`,
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Mutated selected evidence\\n", "utf8");`,
      `process.stdout.write(\`${JSON.stringify({ type: "thread.started", thread_id: `custom-${label.replaceAll(" ", "-")}` })}\\n\`);`,
      "",
    ].join("\n"), "utf8");
    await chmod(stub, 0o755);

    await assert.rejects(
      () => new CodexTerminalRunner({ binary: stub, fake: false }).run(
        {
          executionId: crypto.randomUUID(),
          ...fixture,
          selectedArtifacts: [],
          selectedOutputKeys: ["implementation-plan"],
          ...executionConfig,
        },
        async () => undefined,
      ),
      (error: unknown) => {
        assert.match(
          error instanceof Error ? error.message : String(error),
          /protected|read[- ]only|role resource|template|environment|unauthorized|restore|受保护|只读|角色资源|模板|环境|还原/iu,
        );
        return true;
      },
    );

    assert.equal(await readFile(protectedPath, "utf8"), protectedBefore);
    assert.equal(await readFile(selected.absolutePath, "utf8"), selectedBefore);
  });
}

test("AC-ENG-008: a new root environment symlink escaping the project is rejected and removed", async () => {
  const fixture = await runnerFixture();
  const root = fixture.project.rootPath;
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-engineering-outside-"));
  roots.push(outsideRoot);
  const outsideSentinel = path.join(outsideRoot, "sentinel.txt");
  const outsideBefore = "outside target must remain unchanged\n";
  await writeFile(outsideSentinel, outsideBefore, "utf8");

  const selected = fixture.definition.artifacts.find(
    (artifact) => artifact.id === "implementation-plan",
  )!;
  await mkdir(path.dirname(selected.absolutePath), { recursive: true });
  const selectedBefore = "# Original implementation plan before symlink violation\n";
  await writeFile(selected.absolutePath, selectedBefore, "utf8");

  const escapedLink = path.join(root, ".env.staging");
  const stub = path.join(root, "codex-external-env-symlink-stub.mjs");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    'import { symlinkSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    `symlinkSync(${JSON.stringify(outsideRoot)}, path.join(process.cwd(), ".env.staging"), "dir");`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Mutated selected evidence\\n", "utf8");`,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "external-env-symlink" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(stub, 0o755);

  await assert.rejects(
    () => new CodexTerminalRunner({ binary: stub, fake: false }).run(
      {
        executionId: crypto.randomUUID(),
        ...fixture,
        selectedArtifacts: [],
        selectedOutputKeys: ["implementation-plan"],
        ...executionConfig,
      },
      async () => undefined,
    ),
    (error: unknown) => {
      const appError = error as { statusCode?: number; code?: string };
      assert.equal(appError.statusCode, 422);
      assert.equal(appError.code, "UNSELECTED_OUTPUTS_CHANGED");
      return true;
    },
  );

  await assert.rejects(
    () => lstat(escapedLink),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(await readFile(outsideSentinel, "utf8"), outsideBefore);
  assert.equal(await readFile(selected.absolutePath, "utf8"), selectedBefore);
});

for (const [label, protectedRelativePath] of [
  ["non-current client Agent", ".codex/agents/tester.toml"],
  ["non-current role workflow", ".ai-sdlc/roles/tester/workflow.md"],
] as const) {
  test(`AC-ENG-008: mutation of a ${label} is rejected and restored`, async () => {
    const fixture = await runnerFixture();
    const root = fixture.project.rootPath;
    const protectedPath = path.join(root, protectedRelativePath);
    await mkdir(path.dirname(protectedPath), { recursive: true });
    const protectedBefore = `# Original ${label}\n`;
    await writeFile(protectedPath, protectedBefore, "utf8");

    const selected = fixture.definition.artifacts.find(
      (artifact) => artifact.id === "implementation-plan",
    )!;
    await mkdir(path.dirname(selected.absolutePath), { recursive: true });
    const selectedBefore = "# Original implementation plan before cross-role violation\n";
    await writeFile(selected.absolutePath, selectedBefore, "utf8");

    const stub = path.join(root, `codex-cross-role-${label.replaceAll(" ", "-")}-stub.mjs`);
    await writeFile(stub, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(protectedRelativePath)}), "# Mutated cross-role resource\\n", "utf8");`,
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Mutated selected evidence\\n", "utf8");`,
      `process.stdout.write(\`${JSON.stringify({ type: "thread.started", thread_id: `cross-role-${label.replaceAll(" ", "-")}` })}\\n\`);`,
      "",
    ].join("\n"), "utf8");
    await chmod(stub, 0o755);

    await assert.rejects(
      () => new CodexTerminalRunner({ binary: stub, fake: false }).run(
        {
          executionId: crypto.randomUUID(),
          ...fixture,
          selectedArtifacts: [],
          selectedOutputKeys: ["implementation-plan"],
          ...executionConfig,
        },
        async () => undefined,
      ),
      (error: unknown) => {
        const appError = error as { statusCode?: number; code?: string };
        assert.equal(appError.statusCode, 422);
        assert.equal(appError.code, "UNSELECTED_OUTPUTS_CHANGED");
        return true;
      },
    );

    assert.equal(await readFile(protectedPath, "utf8"), protectedBefore);
    assert.equal(await readFile(selected.absolutePath, "utf8"), selectedBefore);
  });
}

for (const [label, extraRelativePath] of [
  ["shared templates", ".ai-sdlc/templates/custom-unrelated-large-notes.md"],
  ["engineer references", ".ai-sdlc/roles/software-engineer/references/custom-unrelated-large-notes.md"],
] as const) {
  test(`AC-ENG-008: an unrelated >2MB file under ${label} does not block execution`, async () => {
    const fixture = await runnerFixture();
    const root = fixture.project.rootPath;
    const selected = fixture.definition.artifacts.find(
      (artifact) => artifact.id === "implementation-plan",
    )!;
    await mkdir(path.dirname(selected.absolutePath), { recursive: true });

    const extraPath = path.join(root, extraRelativePath);
    const extraSize = (2 * 1024 * 1024) + 128;
    await mkdir(path.dirname(extraPath), { recursive: true });
    await writeFile(extraPath, Buffer.alloc(extraSize, 0x78));

    const stub = path.join(root, `codex-large-${label.replaceAll(" ", "-")}-stub.mjs`);
    await writeFile(stub, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Evidence written despite unrelated large file\\n", "utf8");`,
      `process.stdout.write(\`${JSON.stringify({ type: "thread.started", thread_id: `large-${label.replaceAll(" ", "-")}` })}\\n\`);`,
      "",
    ].join("\n"), "utf8");
    await chmod(stub, 0o755);

    const result = await new CodexTerminalRunner({ binary: stub, fake: false }).run(
      {
        executionId: crypto.randomUUID(),
        ...fixture,
        selectedArtifacts: [],
        selectedOutputKeys: ["implementation-plan"],
        ...executionConfig,
      },
      async () => undefined,
    );

    assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactKey), ["implementation-plan"]);
    assert.match(await readFile(selected.absolutePath, "utf8"), /Evidence written despite unrelated large file/u);
    assert.equal((await stat(extraPath)).size, extraSize);
  });
}

async function runnerFixture(): Promise<{
  project: ProjectDto;
  run: WorkflowRunDto;
  phase: PhaseDefinition;
  definition: LoadedDefinition;
}> {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-engineering-"));
  roots.push(root);
  const roleRoot = path.join(root, ".ai-sdlc", "roles", "software-engineer");
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await mkdir(path.join(roleRoot, "references"), { recursive: true });
  await writeFile(
    path.join(root, ".codex", "agents", "software-engineer.toml"),
    'name = "software-engineer"\n',
    "utf8",
  );
  await writeFile(
    path.join(roleRoot, "config.yaml"),
    "validation: required\noutput:\n  subdirectory: ai-native/engineering\n",
    "utf8",
  );
  await writeFile(path.join(roleRoot, "workflow.md"), "# Canonical engineering workflow\n", "utf8");
  await writeFile(
    path.join(roleRoot, "references", "independent-verification.md"),
    "# Independent verification\n",
    "utf8",
  );

  const now = new Date().toISOString();
  const run: WorkflowRunDto = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    projectId: crypto.randomUUID(),
    title: "Engineering evidence",
    objective: "Produce auditable implementation evidence",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase: PhaseDefinition = {
    id: "implementation",
    owner: "software-engineer",
    inputs: ["change-contract", "architecture"],
    outputs: [...engineeringEvidenceArtifactKeys],
    gate: "human review",
  };
  const artifacts = engineeringEvidenceArtifactKeys.map((id) => {
    const relativePath = `docs/ai-native/engineering/evidence--${run.id}-${id}.md`;
    return {
      id,
      owner: "software-engineer",
      relativePath,
      absolutePath: path.join(root, relativePath),
    };
  });
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Demo", summary: "Demo" },
    roles: [{ id: "software-engineer", name: "Engineer", mission: "Implement", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts,
    configPath: path.join(root, "ai-native.yaml"),
  };
  const project: ProjectDto = {
    id: run.projectId,
    name: "Demo",
    summary: "Demo",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { project, run, phase, definition };
}
