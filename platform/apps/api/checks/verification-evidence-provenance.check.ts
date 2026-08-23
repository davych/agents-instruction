import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExecutionDto, ExecutionEventDto } from "@ai-sdlc/contracts";

import type { CurrentArtifactSnapshot } from "../src/db/store.ts";
import { validateVerificationEvidenceProvenance } from "../src/services/verification-evidence-provenance.ts";
import {
  captureVerificationGitState,
  type VerificationGitState,
} from "../src/services/verification-git-state.ts";
import { captureVerificationWorkspaceRevision } from "../src/services/verification-workspace.ts";

const execFileAsync = promisify(execFile);

test("AC-TESTER-009 provenance: a report head binds to real execution, worktree, command, cwd, and evidence bytes", async () => {
  const fixture = await provenanceFixture();
  try {
    const result = await validateVerificationEvidenceProvenance(fixture.input);
    assert.equal(result.executionId, fixture.execution.id);
    assert.equal(result.workspaceRevisionToken, fixture.workspaceToken);
    assert.equal(result.evidenceHashes["playwright-report/index.html"], fixture.evidenceHash);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 provenance: a non-Git project binds to the protected worktree without inventing a commit", async () => {
  const fixture = await provenanceFixture({ git: false });
  try {
    const result = await validateVerificationEvidenceProvenance(fixture.input);
    assert.equal(result.workspaceRevisionToken, fixture.workspaceToken);
    assert.equal(fixture.gitHead, "");
    assert.doesNotMatch(result.currentRevision, /\bcommit\b|git\s+HEAD/iu);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 provenance: an unborn Git repository is explicit and does not invent HEAD", async () => {
  const fixture = await provenanceFixture({ git: "unborn" });
  try {
    const result = await validateVerificationEvidenceProvenance(fixture.input);
    assert.match(result.currentRevision, /git unborn refs\/heads\//u);
    assert.doesNotMatch(result.currentRevision, /git HEAD/iu);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 adversarial provenance: invented repository revisions fail closed", async () => {
  const fixture = await provenanceFixture();
  try {
    fixture.report.content = fixture.report.content.replace(
      fixture.gitHead,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    await assertProvenanceFailure(fixture.input, /pre-run Git binding|git HEAD/iu);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 adversarial provenance: pre-run Git state cannot disappear, corrupt, or move HEAD", async (context) => {
  await context.test("repository disappears", async () => {
    const fixture = await provenanceFixture();
    try {
      await rm(path.join(fixture.root, ".git"), { recursive: true, force: true });
      await assertProvenanceFailure(fixture.input, /Git state or HEAD does not match/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("HEAD becomes corrupt", async () => {
    const fixture = await provenanceFixture();
    try {
      await writeFile(path.join(fixture.root, ".git", "HEAD"), "not-a-valid-ref\n", "utf8");
      await assertProvenanceFailure(fixture.input, /Git state is unreadable or corrupt/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("HEAD changes after the bound execution", async () => {
    const fixture = await provenanceFixture();
    try {
      await execFileAsync("git", ["commit", "--quiet", "--allow-empty", "-m", "move head"], {
        cwd: fixture.root,
      });
      await assertProvenanceFailure(fixture.input, /Git state or HEAD does not match/iu);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("AC-TESTER-009 adversarial provenance: nonexistent or unsafe local claims are rejected", async (context) => {
  await context.test("nonexistent cwd", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.report.content = fixture.report.content.replaceAll(
        fixture.root,
        path.join(fixture.root, "missing-cwd"),
      );
      await assertProvenanceFailure(fixture.input, /working directory is missing or unsafe/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("existing nested cwd is not the trusted project-root cwd", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.report.content = fixture.report.content.replaceAll(
        fixture.root,
        path.join(fixture.root, "packages", "app"),
      );
      await assertProvenanceFailure(fixture.input, /working directory is missing or unsafe/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("nonexistent evidence path", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.report.content = fixture.report.content.replaceAll(
        "playwright-report/index.html",
        "playwright-report/missing.html",
      );
      await assertProvenanceFailure(fixture.input, /cannot verify playwright-report\/missing\.html/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("forged local run id cannot replace the platform execution id", async () => {
    const fixture = await provenanceFixture();
    try {
      const invented = randomUUID();
      fixture.report.content = fixture.report.content.replaceAll(fixture.execution.id, invented);
      await assertProvenanceFailure(fixture.input, /Platform execution ID.*exactly match/iu);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("AC-TESTER-009 adversarial provenance: wrong and stale executions cannot approve a newer report", async (context) => {
  await context.test("simulated runner", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.execution.runnerMode = "fake";
      await assertProvenanceFailure(fixture.input, /simulated\/fake runner output/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("human-authored report head without a fresh execution", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.report.executionId = null;
      fixture.report.revisionSource = "human";
      await assertProvenanceFailure(fixture.input, /no persisted platform execution provenance/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("wrong execution", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.report.executionId = randomUUID();
      await assertProvenanceFailure(fixture.input, /execution does not exist/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("stale execution", async () => {
    const fixture = await provenanceFixture();
    try {
      fixture.input.phase.executions = [
        { ...fixture.execution, id: randomUUID(), createdAt: new Date(Date.now() + 1_000).toISOString() },
        fixture.execution,
      ];
      await assertProvenanceFailure(fixture.input, /stale Verification execution/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("wrong command event", async () => {
    const fixture = await provenanceFixture();
    try {
      const commandEvent = fixture.input.phase.events.find((event) => event.eventType === "item.completed");
      assert.ok(commandEvent);
      commandEvent.payload = {
        type: "item.completed",
        item: {
          type: "command_execution",
          status: "completed",
          exit_code: 0,
          commandHash: createHash("sha256").update("echo not-a-test").digest("hex"),
        },
      };
      await assertProvenanceFailure(fixture.input, /no matching successful platform command_execution event/iu);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("AC-TESTER-009 adversarial provenance: a successful command hash cannot bind shell prose disguised as a runner", async (context) => {
  const attacks = new Map<string, string>([
    [
      "Playwright only in a unit-command comment",
      "node --test tests/unit.test.js # npx playwright test tests/e2e/checkout-coupon.spec.ts",
    ],
    [
      "printf claim before a unit runner",
      "printf npx-playwright-test && node --test tests/unit.test.js",
    ],
    [
      "echoed Playwright claim",
      "echo npx playwright test tests/e2e/checkout-coupon.spec.ts",
    ],
    [
      "inline assignment before a Playwright claim",
      "PLAYWRIGHT=npx playwright test tests/e2e/checkout-coupon.spec.ts",
    ],
  ]);
  for (const [label, command] of attacks) {
    await context.test(label, async () => {
      const fixture = await provenanceFixture();
      try {
        replaceBoundCommand(fixture, command);
        await assertProvenanceFailure(
          fixture.input,
          /exact autonomous test-runner|Playwright\/E2E runner/iu,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("AC-TESTER-009 adversarial provenance: an executed E2E wrapper cannot be self-declared non-E2E", async () => {
  const fixture = await provenanceFixture();
  try {
    await mkdir(path.join(fixture.root, "test-results"), { recursive: true });
    await writeFile(
      path.join(fixture.root, "test-results", "results.tap"),
      "durable current Playwright result\n",
      "utf8",
    );
    replaceBoundCommand(fixture, "yarn test:e2e");
    fixture.report.content = fixture.report.content
      .replace(
        "E2E script required:** yes — browser journey risk",
        "E2E script required:** no — author claims unit coverage is enough",
      )
      .replaceAll("tests/e2e/checkout-coupon.spec.ts", "tests/checkout-coupon.spec.ts")
      .replaceAll("playwright-report/index.html", "test-results/results.tap");
    fixture.report.contentHash = createHash("sha256").update(fixture.report.content).digest("hex");
    fixture.input.acceptanceCriteria = ["CC-AC-001: coupon total is correct"];
    fixture.input.regressionScope = ["REG-001: checkout default is unchanged"];
    fixture.input.riskFlags = [];

    await assertProvenanceFailure(
      fixture.input,
      /canonical execution command invokes an E2E runner/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 adversarial provenance: self-declared no-E2E cannot override authoritative signals", async () => {
  const fixture = await provenanceFixture();
  try {
    fixture.report.content = fixture.report.content
      .replace(
        "E2E script required:** yes — browser journey risk",
        "E2E script required:** no — author claims unit coverage is enough",
      )
      .replaceAll("npx playwright test tests/e2e/checkout-coupon.spec.ts", "node --test tests/checkout.test.js")
      .replaceAll("tests/e2e/checkout-coupon.spec.ts", "tests/checkout.test.js")
      .replaceAll("playwright-report/index.html", "test-results/results.tap");
    await assertProvenanceFailure(fixture.input, /authoritative signals require E2E/iu);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-009 adversarial provenance: evidence content must match its declared digest", async () => {
  const fixture = await provenanceFixture();
  try {
    fixture.report.content = fixture.report.content.replace(
      fixture.evidenceHash,
      "0".repeat(64),
    );
    await assertProvenanceFailure(fixture.input, /evidence hash does not match/iu);
  } finally {
    await fixture.cleanup();
  }
});

interface MutableProvenanceInput {
  projectRoot: string;
  artifacts: CurrentArtifactSnapshot[];
  phase: {
    id: string;
    executions: ExecutionDto[];
    events: ExecutionEventDto[];
  };
  acceptanceCriteria: string[];
  regressionScope: string[];
  riskFlags: string[];
}

async function provenanceFixture(options: { git?: boolean | "unborn" } = {}): Promise<{
  root: string;
  input: MutableProvenanceInput;
  report: CurrentArtifactSnapshot;
  execution: ExecutionDto;
  evidenceHash: string;
  workspaceToken: string;
  gitHead: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-provenance-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(path.join(root, "tests", "e2e"), { recursive: true });
  await mkdir(path.join(root, "playwright-report"), { recursive: true });
  await writeFile(
    path.join(root, "tests", "e2e", "checkout-coupon.spec.ts"),
    "// frozen independent E2E contract\n",
    "utf8",
  );
  const evidenceContent = "durable current Playwright result\n";
  const evidenceHash = createHash("sha256").update(evidenceContent).digest("hex");
  await writeFile(path.join(root, "playwright-report", "index.html"), evidenceContent, "utf8");
  let gitHead = "";
  if (options.git !== false) {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "verification@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Verification Fixture"], { cwd: root });
    if (options.git !== "unborn") {
      await execFileAsync("git", ["add", "tests/e2e/checkout-coupon.spec.ts"], { cwd: root });
      await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
      gitHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    }
  }
  const gitState = await captureVerificationGitState(root);

  const reportPath = path.join(root, "docs", "test-report.md");
  const workspace = await captureVerificationWorkspaceRevision({
    projectRoot: root,
    selectedOutputPaths: [reportPath],
  });
  const executionId = randomUUID();
  const phaseRunId = randomUUID();
  const command = "npx playwright test tests/e2e/checkout-coupon.spec.ts";
  const commandLabel = "codex verification --json";
  const currentRevision = [
    gitReportBinding(gitState),
    `workspace sha256:${workspace.token}`,
    `platform execution ${executionId}`,
  ].filter(Boolean).join("; ");
  const now = new Date().toISOString();
  const content = [
    "# Test Report",
    "",
    "## Status and recommendation",
    "",
    "- **Verification state:** Ready for release review",
    "- **Release recommendation:** Current evidence supports human release review.",
    `- **Current revision:** ${currentRevision}`,
    `- **Platform execution ID:** ${executionId}`,
    "",
    "## E2E Stage 2: Crystallization",
    "",
    "- **E2E script required:** yes — browser journey risk",
    "- **Repository test path:** tests/e2e/checkout-coupon.spec.ts",
    "",
    "## E2E Stage 3: Execution",
    "",
    "| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |",
    "|---|---|---|---|---|",
    `| local standalone | \`${command}\` from \`${root}\` | ${currentRevision}; Chromium | pass; exit code 0 | playwright-report/index.html sha256:${evidenceHash} |`,
    "",
    "## Acceptance and regression results",
    "",
    "| Criterion or regression obligation | Repository test or observation | Execution evidence | Result |",
    "|---|---|---|---|",
    "| CC-AC-001 | tests/e2e/checkout-coupon.spec.ts :: coupon checkout | playwright-report/index.html#coupon | pass |",
    "| REG-001 | tests/e2e/checkout-coupon.spec.ts :: checkout without coupon | playwright-report/index.html#default | pass |",
    "",
    "## Failure classification and routing",
    "",
    "| Failure ID | Classification | Evidence | Owner | Next action | Status |",
    "|---|---|---|---|---|---|",
    "| None | Not applicable | playwright-report/index.html | Tester | None | resolved |",
    "",
    "## Coverage gaps",
    "",
    "- None",
  ].join("\n");
  const report: CurrentArtifactSnapshot = {
    id: randomUUID(),
    phaseRunId,
    executionId,
    artifactKey: "test-report",
    filePath: "docs/test-report.md",
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    reviewStatus: "pending",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt: now,
  };
  const execution: ExecutionDto = {
    id: executionId,
    phaseRunId,
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
  };
  const events: ExecutionEventDto[] = [
    event(executionId, 1, "runner.started", {
      mode: "real",
      phaseId: "verification",
      command: commandLabel,
      workingDirectory: root,
      workspaceRevisionToken: workspace.token,
      verificationGitState: gitState,
    }, now),
    event(executionId, 2, "item.completed", {
      type: "item.completed",
      item: {
        type: "command_execution",
        status: "completed",
        exit_code: 0,
        commandHash: createHash("sha256").update(command).digest("hex"),
      },
    }, now),
    event(executionId, 3, "runner.completed", { exitCode: 0 }, now),
  ];
  return {
    root,
    report,
    execution,
    evidenceHash,
    workspaceToken: workspace.token,
    gitHead,
    input: {
      projectRoot: root,
      artifacts: [report],
      phase: { id: phaseRunId, executions: [execution], events },
      acceptanceCriteria: ["CC-AC-001: coupon checkout completes in the browser journey"],
      regressionScope: ["REG-001: browser checkout without coupon still completes once"],
      riskFlags: ["browser journey"],
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function gitReportBinding(state: VerificationGitState): string {
  if (state.kind === "head") return `git HEAD ${state.head}`;
  if (state.kind === "unborn") return `git unborn ${state.symbolicHead}`;
  return "git state:not-repository";
}

function replaceBoundCommand(
  fixture: Awaited<ReturnType<typeof provenanceFixture>>,
  command: string,
): void {
  fixture.report.content = fixture.report.content.replace(
    "npx playwright test tests/e2e/checkout-coupon.spec.ts",
    command,
  );
  fixture.report.contentHash = createHash("sha256").update(fixture.report.content).digest("hex");
  const commandEvent = fixture.input.phase.events.find((event) => event.eventType === "item.completed");
  assert.ok(commandEvent);
  commandEvent.payload = {
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      exit_code: 0,
      commandHash: createHash("sha256").update(command).digest("hex"),
    },
  };
}

function event(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  createdAt: string,
): ExecutionEventDto {
  return { id: randomUUID(), executionId, sequence, eventType, payload, createdAt };
}

async function assertProvenanceFailure(
  input: MutableProvenanceInput,
  expectedIssue: RegExp,
): Promise<void> {
  await assert.rejects(
    () => validateVerificationEvidenceProvenance(input),
    (error: unknown) => {
      const appError = error as {
        statusCode?: number;
        code?: string;
        details?: { issues?: unknown };
      };
      assert.equal(appError.statusCode, 409);
      assert.equal(appError.code, "VERIFICATION_EVIDENCE_GATE_FAILED");
      assert.ok(Array.isArray(appError.details?.issues));
      assert.match((appError.details?.issues as string[]).join("\n"), expectedIssue);
      return true;
    },
  );
}
