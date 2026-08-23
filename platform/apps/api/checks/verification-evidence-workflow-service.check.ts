import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArtifactDto,
  ChangeContractDto,
  ProjectDto,
  ReviewDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { validateVerificationEvidenceGate } from "../src/services/verification-evidence-validator.ts";
import { captureVerificationWorkspaceRevision } from "../src/services/verification-workspace.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const acceptanceCriteria = ["The eligible coupon reduces the displayed total"];
const regressionScope = ["Checkout without a coupon still completes once"];

test("AC-TESTER-009: a current local standalone pass needs durable evidence but no remote CI URL", () => {
  const result = validateVerificationEvidenceGate({
    artifacts: [{ artifactKey: "test-report", content: validReport() }],
    acceptanceCriteria,
    regressionScope,
  });

  assert.equal(result.currentRevision, "commit abc123def");
  assert.equal(result.standaloneExecutionCount, 1);
});

test("AC-TESTER-009: a claimed remote CI pass includes a durable CI URL or run ID", () => {
  const content = validReport().replace(
    "| local standalone | `yarn test:e2e` from `/workspace/shop` | commit abc123def; Chromium | pass; exit code 0 | artifacts/playwright-report/index.html; local run ID local-123 |",
    "| remote CI | `yarn test:e2e` from `/workspace/shop` | commit abc123def; Chromium | pass; exit code 0 | CI run ID gha-9182; https://ci.example.test/runs/gha-9182 |",
  );
  const result = validateVerificationEvidenceGate({
    artifacts: [{ artifactKey: "test-report", content }],
    acceptanceCriteria,
    regressionScope,
  });
  assert.equal(result.standaloneExecutionCount, 1);
});

test("AC-TESTER-009: legitimate HTML element evidence is not an unresolved angle placeholder", () => {
  const content = validReport().replace(
    "## E2E Stage 2: Crystallization",
    "- **Observed DOM:** `<button type=\"submit\">Apply coupon</button>`\n\n## E2E Stage 2: Crystallization",
  );
  const result = validateVerificationEvidenceGate({
    artifacts: [{ artifactKey: "test-report", content }],
    acceptanceCriteria,
    regressionScope,
  });

  assert.equal(result.standaloneExecutionCount, 1);
});

test("AC-TESTER-009 adversarial: placeholders and a Blocked status cannot be approved", (context) => {
  const cases = new Map<string, string>([
    ["template placeholder", validReport().replace("commit abc123def", "<commit SHA>")],
    ["blocked state", validReport().replace("Ready for release review", "Blocked")],
    ["untested result labeled pass", validReport().replace("pass; exit code 0", "pass; untested; exit code 0")],
  ]);
  for (const [label, content] of cases) {
    void context.test(label, () => assertGateFailure(content));
  }
});

test("AC-TESTER-009 adversarial: MCP exploration cannot masquerade as standalone execution", () => {
  const content = validReport().replace(
    "`yarn test:e2e` from `/workspace/shop`",
    "Playwright MCP browser session mcp-421",
  );
  assertGateFailure(content, /autonomous test-runner|standalone execution/iu);
});

test("AC-TESTER-009 adversarial: E2E semantics use the same single canonical command as provenance", (context) => {
  const variants = new Map<string, string>([
    [
      "unit command plus an unbound Playwright claim",
      "`node --test tests/unit.test.js` from `/workspace/shop`; claimed E2E: npx playwright test tests/e2e/fake.spec.ts",
    ],
    [
      "extra backticked Playwright candidate",
      "`node --test tests/unit.test.js` from `/workspace/shop`; claimed E2E: `npx playwright test tests/e2e/fake.spec.ts`",
    ],
    ["working directory and command reversed", "`/workspace/shop` from `yarn test:e2e`"],
    ["unbackticked command", "yarn test:e2e from `/workspace/shop`"],
    [
      "unit runner plus Playwright in a shell comment",
      "`node --test tests/unit.test.js # npx playwright test tests/e2e/fake.spec.ts` from `/workspace/shop`",
    ],
    [
      "printf claim followed by a unit runner",
      "`printf npx-playwright-test && node --test tests/unit.test.js` from `/workspace/shop`",
    ],
    ["echoed runner name", "`echo npx playwright test tests/e2e/fake.spec.ts` from `/workspace/shop`"],
    [
      "assignment before an unexecuted runner name",
      "`PLAYWRIGHT=npx playwright test tests/e2e/fake.spec.ts` from `/workspace/shop`",
    ],
    [
      "Playwright list-only mode",
      "`npx playwright test tests/e2e/fake.spec.ts --list` from `/workspace/shop`",
    ],
  ]);
  for (const [label, commandCell] of variants) {
    void context.test(label, () => {
      const content = validReport().replace(
        "`yarn test:e2e` from `/workspace/shop`",
        commandCell,
      );
      assertGateFailure(content, /exact autonomous test-runner|Playwright\/E2E runner/iu);
    });
  }
});

test("AC-TESTER-009: canonical direct and repository E2E wrappers remain valid", (context) => {
  for (const command of [
    "npx playwright test tests/e2e/checkout-coupon.spec.ts",
    "yarn test:e2e",
    "npm run test:e2e",
  ]) {
    void context.test(command, () => {
      const content = validReport().replace(
        "`yarn test:e2e` from `/workspace/shop`",
        `\`${command}\` from \`/workspace/shop\``,
      );
      const result = validateVerificationEvidenceGate({
        artifacts: [{ artifactKey: "test-report", content }],
        acceptanceCriteria,
        regressionScope,
      });
      assert.equal(result.standaloneExecutionCount, 1);
      assert.equal(result.e2eRequired, true);
    });
  }
});

test("AC-TESTER-009 adversarial: a canonical E2E wrapper makes self-declared no-E2E fail closed", () => {
  const content = validReport().replace(
    "E2E script required:** yes — CC-AC-001 and REG-001 cross the browser checkout boundary",
    "E2E script required:** no — author claims this is only a unit check",
  );
  assertGateFailure(
    content,
    /canonical execution command invokes an E2E runner/iu,
  );
});

test("AC-TESTER-009 adversarial: non-E2E evidence also requires a direct canonical runner", (context) => {
  for (const command of [
    "echo npm test",
    "printf npm-test && true",
    "CHECK=npm npm test",
  ]) {
    void context.test(command, () => {
      const content = validReport()
        .replace(
          "E2E script required:** yes — CC-AC-001 and REG-001 cross the browser checkout boundary",
          "E2E script required:** no — browser coverage is not applicable",
        )
        .replace("`yarn test:e2e` from `/workspace/shop`", `\`${command}\` from \`/workspace/shop\``);
      assertGateFailure(content, /exact autonomous test-runner/iu);
    });
  }
});

test("AC-TESTER-009 adversarial: a report must identify and execute the current revision", (context) => {
  void context.test("missing revision", () => {
    const content = validReport().replace("- **Current revision:** commit abc123def\n", "");
    assertGateFailure(content, /Current revision/iu);
  });
  void context.test("execution references another revision", () => {
    const content = validReport().replace(
      "commit abc123def; Chromium",
      "commit deadbeef9; Chromium",
    );
    assertGateFailure(content, /does not trace Current revision/iu);
  });
});

test("AC-TESTER-009 adversarial: an unrun command or missing execution table cannot pass", (context) => {
  void context.test("no command", () => {
    const content = validReport().replace(
      "`yarn test:e2e` from `/workspace/shop`",
      "command will be selected later",
    );
    assertGateFailure(content, /autonomous test-runner/iu);
  });
  void context.test("no table", () => {
    const content = validReport().replace(
      /\| Execution \| Exact command and working directory \| Revision and environment \| Result \| Durable evidence \|[\s\S]*?(?=\n## Acceptance and regression results)/u,
      "No standalone execution was performed.\n",
    );
    assertGateFailure(content, /standalone execution row/iu);
  });
});

test("AC-TESTER-009 adversarial: every applicable AC and regression needs a passing evidence row", (context) => {
  void context.test("missing acceptance", () => {
    const content = validReport().replace(
      /\| CC-AC-001 \|[^\n]+\n/u,
      "",
    );
    assertGateFailure(content, /CC-AC-001 is missing/iu);
  });
  void context.test("missing regression", () => {
    const content = validReport().replace(
      /\| REG-001 \|[^\n]+\n/u,
      "",
    );
    assertGateFailure(content, /REG-001 is missing/iu);
  });
  void context.test("untested regression", () => {
    const content = validReport().replace(
      "| REG-001 | tests/e2e/checkout-coupon.spec.ts :: checkout without coupon | artifacts/playwright-report/index.html#checkout-default | pass |",
      "| REG-001 | tests/e2e/checkout-coupon.spec.ts :: checkout without coupon | artifacts/playwright-report/index.html#checkout-default | untested |",
    );
    assertGateFailure(content, /REG-001 has no passing|blocked or untested coverage/iu);
  });
});

test("AC-TESTER-009 adversarial: only a remote CI pass claim requires a CI URL or ID", () => {
  const content = validReport().replace(
    "| local standalone | `yarn test:e2e` from `/workspace/shop` | commit abc123def; Chromium | pass; exit code 0 | artifacts/playwright-report/index.html; local run ID local-123 |",
    "| remote CI | `yarn test:e2e` from `/workspace/shop` | commit abc123def; Chromium | pass; exit code 0 | artifacts/playwright-report/index.html |",
  );
  assertGateFailure(content, /remote CI pass without a durable CI URL or run\/build\/job ID/iu);
});

test("AC-TESTER-009: WorkflowService rejects invalid Verification evidence before approval persistence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-gate-"));
  try {
    const requestedRoot = path.join(parent, "sample");
    await initializeCodexProject(requestedRoot, "Verification gate", "Semantic Test Report gate");
    const rootPath = await realpath(requestedRoot);
    const now = "2026-08-20T15:00:00.000Z";
    const project: ProjectDto = {
      id: randomUUID(),
      name: "Verification gate",
      summary: "Semantic Test Report gate",
      rootPath,
      configPath: path.join(rootPath, "ai-native.yaml"),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    const changeContract: ChangeContractDto = {
      workType: "change",
      summary: "Verify coupon checkout",
      currentBehavior: "Coupon checkout has no independent Verification evidence.",
      expectedBehavior: "The current revision has a standalone passing checkout run.",
      inScope: ["Checkout coupon journey"],
      outOfScope: ["Release configuration"],
      acceptanceCriteria,
      regressionScope,
      riskFlags: ["browser journey"],
      evidenceRefs: ["artifact:change-contract"],
    };
    const run = {
      id: randomUUID(),
      projectId: project.id,
      title: "Verification evidence gate",
      objective: "Reject MCP-only or unexecuted evidence",
      changeContract,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const designPhaseId = randomUUID();
    const verificationPhaseId = randomUUID();
    const designSpec = artifact(
      designPhaseId,
      "design-spec",
      "docs/design-spec.md",
      '# Design Specification\n\n```json\n{"status":"ready-for-engineering","blockers":[],"open_questions":[],"deferred_validations":[]}\n```\n',
      now,
    );
    designSpec.reviewStatus = "approved";
    const executionId = randomUUID();
    const command = "yarn test:e2e";
    const commandLabel = "codex verification --json";
    const evidenceContent = "verified Playwright report\n";
    const evidenceHash = createHash("sha256").update(evidenceContent).digest("hex");
    await mkdir(path.join(rootPath, "playwright-report"), { recursive: true });
    await writeFile(path.join(rootPath, "playwright-report", "index.html"), evidenceContent, "utf8");
    const workspaceRevision = await captureVerificationWorkspaceRevision({
      projectRoot: rootPath,
      selectedOutputPaths: [path.join(rootPath, "docs", "test-report.md")],
    });
    const boundReport = bindReportToExecution(validReport(), {
      projectRoot: rootPath,
      executionId,
      workspaceRevisionToken: workspaceRevision.token,
      evidenceHash,
    });
    const report = artifact(
      verificationPhaseId,
      "test-report",
      "docs/test-report.md",
      boundReport.replace("`yarn test:e2e` from `" + rootPath + "`", "Playwright MCP session mcp-421"),
      now,
    );
    const design = phase(run.id, designPhaseId, "design", 1, "approved", [designSpec], now);
    const verification = phase(
      run.id,
      verificationPhaseId,
      "verification",
      4,
      "awaiting_review",
      [report],
      now,
    );
    verification.executions = [{
      id: executionId,
      phaseRunId: verification.id,
      status: "completed",
      selectedArtifactIds: [],
      selectedOutputKeys: ["test-report"],
      runnerMode: "real",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      command: commandLabel,
      exitCode: 0,
      error: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    }];
    verification.events = [
      executionEvent(executionId, 1, "runner.started", {
        mode: "real",
        phaseId: "verification",
        command: commandLabel,
        workingDirectory: rootPath,
        workspaceRevisionToken: workspaceRevision.token,
        verificationGitState: { kind: "not_repository" },
      }, now),
      executionEvent(executionId, 2, "item.completed", {
        type: "item.completed",
        item: {
          type: "command_execution",
          status: "completed",
          exit_code: 0,
          commandHash: createHash("sha256").update(command).digest("hex"),
        },
      }, now),
      executionEvent(executionId, 3, "runner.completed", { exitCode: 0 }, now),
    ];
    const reviewCalls: unknown[][] = [];
    const phases = [design, verification];
    const fakeStore = {
      getRun: async () => ({ project, run, phases, artifactPaths: {} }),
      currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: string) => {
        const selected = phases.find((candidate) => candidate.phaseId === phaseId);
        return selected?.artifacts.map((candidate) => ({
          ...candidate,
          content: candidate.content ?? "",
          executionId: candidate.artifactKey === "test-report" ? executionId : null,
        })) ?? [];
      },
      reviewPhase: async (...args: unknown[]) => {
        reviewCalls.push(args);
        const review: ReviewDto = {
          id: randomUUID(),
          phaseRunId: verification.id,
          decision: args[2] as "approve" | "request_changes",
          comment: String(args[3]),
          artifactIds: args[4] as string[],
          createdAt: now,
        };
        return review;
      },
    };
    const service = new WorkflowService(
      fakeStore as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    await assert.rejects(
      () => service.reviewPhase(run.id, "verification", {
        decision: "approve",
        comment: "MCP-only evidence cannot approve Verification.",
        expectedArtifactIds: [report.id],
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, "VERIFICATION_EVIDENCE_GATE_FAILED");
        return true;
      },
    );
    assert.equal(reviewCalls.length, 0);

    report.content = boundReport;
    report.contentHash = createHash("sha256").update(boundReport).digest("hex");
    await service.reviewPhase(run.id, "verification", {
      decision: "approve",
      comment: "Current standalone evidence and coverage mapping are complete.",
      expectedArtifactIds: [report.id],
    });
    assert.equal(reviewCalls.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function assertGateFailure(content: string, issuePattern?: RegExp): void {
  assert.throws(
    () => validateVerificationEvidenceGate({
      artifacts: [{ artifactKey: "test-report", content }],
      acceptanceCriteria,
      regressionScope,
    }),
    (error: unknown) => {
      const appError = error as { statusCode?: number; code?: string; details?: { issues?: unknown } };
      assert.equal(appError.statusCode, 409);
      assert.equal(appError.code, "VERIFICATION_EVIDENCE_GATE_FAILED");
      assert.ok(Array.isArray(appError.details?.issues));
      if (issuePattern) assert.match((appError.details?.issues as string[]).join("\n"), issuePattern);
      return true;
    },
  );
}

function validReport(): string {
  return [
    "# Test Report",
    "",
    "## Status and recommendation",
    "",
    "- **Verification state:** Ready for release review",
    "- **Release recommendation:** Current evidence supports human release review.",
    "- **Current revision:** commit abc123def",
    "",
    "## E2E Stage 2: Crystallization",
    "",
    "- **E2E script required:** yes — CC-AC-001 and REG-001 cross the browser checkout boundary",
    "",
    "## E2E Stage 3: Execution",
    "",
    "| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |",
    "|---|---|---|---|---|",
    "| local standalone | `yarn test:e2e` from `/workspace/shop` | commit abc123def; Chromium | pass; exit code 0 | artifacts/playwright-report/index.html; local run ID local-123 |",
    "",
    "- **Required PR check:** planned by DevOps; no remote CI pass is claimed",
    "- **MCP used for execution:** No",
    "",
    "## Acceptance and regression results",
    "",
    "| Criterion or regression obligation | Repository test or observation | Execution evidence | Result |",
    "|---|---|---|---|",
    "| CC-AC-001 | tests/e2e/checkout-coupon.spec.ts :: eligible coupon checkout | artifacts/playwright-report/index.html#coupon | pass |",
    "| REG-001 | tests/e2e/checkout-coupon.spec.ts :: checkout without coupon | artifacts/playwright-report/index.html#checkout-default | pass |",
    "",
    "## Failure classification and routing",
    "",
    "| Failure ID | Classification | Evidence | Owner | Next action | Status |",
    "|---|---|---|---|---|---|",
    "| None | Not applicable | artifacts/playwright-report/index.html | Tester | None | resolved |",
    "",
    "## Coverage gaps",
    "",
    "- None",
  ].join("\n");
}

function bindReportToExecution(content: string, input: {
  projectRoot: string;
  executionId: string;
  workspaceRevisionToken: string;
  evidenceHash: string;
}): string {
  const revision = `git state:not-repository; workspace sha256:${input.workspaceRevisionToken}; platform execution ${input.executionId}`;
  return content
    .replace(
      "- **Current revision:** commit abc123def",
      `- **Current revision:** ${revision}\n- **Platform execution ID:** ${input.executionId}`,
    )
    .replaceAll("commit abc123def", revision)
    .replaceAll("/workspace/shop", input.projectRoot)
    .replaceAll(
      "artifacts/playwright-report/index.html",
      `playwright-report/index.html sha256:${input.evidenceHash}`,
    );
}

function executionEvent(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  createdAt: string,
) {
  return {
    id: randomUUID(),
    executionId,
    sequence,
    eventType,
    payload,
    createdAt,
  };
}

function artifact(
  phaseRunId: string,
  artifactKey: string,
  filePath: string,
  content: string,
  createdAt: string,
): ArtifactDto {
  return {
    id: randomUUID(),
    phaseRunId,
    artifactKey,
    filePath,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    reviewStatus: "pending",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt,
  };
}

function phase(
  workflowRunId: string,
  id: string,
  phaseId: "design" | "verification",
  position: number,
  status: "approved" | "awaiting_review",
  artifacts: ArtifactDto[],
  createdAt: string,
) {
  return {
    id,
    workflowRunId,
    phaseId,
    position,
    status,
    artifacts,
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    createdAt,
    updatedAt: createdAt,
  };
}
