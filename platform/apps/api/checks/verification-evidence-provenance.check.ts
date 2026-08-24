import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExecutionDto, ExecutionEventDto } from "@ai-sdlc/contracts";

import type { CurrentArtifactSnapshot } from "../src/db/store.ts";
import { captureE2eInputRevisionToken } from "../src/services/verification-e2e-coordinator.ts";
import { validateVerificationEvidenceProvenance } from "../src/services/verification-evidence-provenance.ts";
import {
  captureVerificationGitState,
  type VerificationGitState,
} from "../src/services/verification-git-state.ts";
import { captureVerificationWorkspaceRevision } from "../src/services/verification-workspace.ts";

const execFileAsync = promisify(execFile);

test("AC-TESTER-009 legacy provenance: a normal passing report remains valid without a Linked E2E event", async () => {
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

test("AC-TESTER-020 provenance: Linked E2E pass binds only to the completed platform event", async () => {
  const fixture = await linkedE2eProvenanceFixture();
  try {
    const result = await validateVerificationEvidenceProvenance(fixture.input);
    assert.equal(result.executionId, fixture.execution.id);
    assert.equal(result.evidenceHashes[fixture.copiedEvidencePath], fixture.evidenceHash);
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-020 adversarial provenance: completed Linked E2E machine facts fail closed", async (context) => {
  const attacks: Array<{
    label: string;
    mutate(payload: Record<string, unknown>): void;
    expected: RegExp;
  }> = [
    {
      label: "missing raw test exit code",
      mutate: (payload) => { delete payload.testExitCode; },
      expected: /completed event is malformed/iu,
    },
    {
      label: "nonzero raw test exit code",
      mutate: (payload) => { payload.testExitCode = 1; },
      expected: /effective and raw test exit code 0/iu,
    },
    {
      label: "missing server cleanup result",
      mutate: (payload) => { delete payload.serverCleanup; },
      expected: /completed event is malformed/iu,
    },
    {
      label: "forced server cleanup",
      mutate: (payload) => { payload.serverCleanup = "sigkill"; },
      expected: /successful supervised server cleanup/iu,
    },
    {
      label: "missing target probe fields",
      mutate: (payload) => { payload.targetProbe = {}; },
      expected: /completed event is malformed/iu,
    },
    {
      label: "server-error target status",
      mutate: (payload) => {
        payload.targetProbe = { ...(payload.targetProbe as object), status: 503 };
      },
      expected: /target probe must record HTTP status 200-499/iu,
    },
    {
      label: "target on another origin",
      mutate: (payload) => {
        payload.targetProbe = { ...(payload.targetProbe as object), url: "http://127.0.0.1:4999/" };
      },
      expected: /target probe URL is not bound to the configured baseUrl/iu,
    },
    {
      label: "target on a different same-origin path",
      mutate: (payload) => {
        const target = payload.targetProbe as Record<string, unknown>;
        payload.targetProbe = {
          ...target,
          url: new URL("redirected", String(target.url)).href,
        };
      },
      expected: /target probe URL is not bound to the configured baseUrl/iu,
    },
    {
      label: "target browser version mismatch",
      mutate: (payload) => {
        payload.targetProbe = { ...(payload.targetProbe as object), browserVersion: "129.0" };
      },
      expected: /target probe browser version does not match/iu,
    },
  ];
  for (const attack of attacks) {
    await context.test(attack.label, async () => {
      const fixture = await linkedE2eProvenanceFixture();
      try {
        const completed = fixture.input.phase.events.find(
          ({ eventType }) => eventType === "e2e.execution.completed",
        );
        assert.ok(completed?.payload && typeof completed.payload === "object");
        attack.mutate(completed.payload as Record<string, unknown>);
        await assertProvenanceFailure(fixture.input, attack.expected);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("AC-TESTER-020 adversarial provenance: report prose cannot replace the completed platform event", async () => {
  const fixture = await linkedE2eProvenanceFixture();
  try {
    fixture.input.phase.events = fixture.input.phase.events.filter(
      ({ eventType }) => eventType !== "e2e.execution.completed",
    );
    await assertProvenanceFailure(
      fixture.input,
      /Linked E2E claims require a bound platform e2e\.execution\.completed event/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-020 adversarial provenance: Linked E2E script and evidence tampering fail closed", async (context) => {
  await context.test("report substitutes the approved script hash", async () => {
    const fixture = await linkedE2eProvenanceFixture();
    try {
      fixture.report.content = fixture.report.content.replace(
        fixture.scriptHash,
        "0".repeat(64),
      );
      fixture.report.contentHash = createHash("sha256")
        .update(fixture.report.content)
        .digest("hex");
      await assertProvenanceFailure(fixture.input, /approved script .*not bound|script manifest/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("approved script bytes change after execution", async () => {
    const fixture = await linkedE2eProvenanceFixture();
    try {
      await writeFile(fixture.scriptPath, "// tampered after platform execution\n", "utf8");
      await assertProvenanceFailure(fixture.input, /script hash or size|revision token is stale/iu);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("copied evidence bytes change after collection", async () => {
    const fixture = await linkedE2eProvenanceFixture();
    try {
      await writeFile(fixture.copiedEvidenceAbsolutePath, "tampered evidence\n", "utf8");
      await assertProvenanceFailure(fixture.input, /evidence hash or size|evidence hash does not match/iu);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("AC-TESTER-020 adversarial provenance: a Linked E2E row cannot substitute another cwd", async () => {
  const fixture = await linkedE2eProvenanceFixture();
  try {
    fixture.report.content = fixture.report.content.replaceAll(
      fixture.e2eRoot,
      fixture.root,
    );
    fixture.report.contentHash = createHash("sha256")
      .update(fixture.report.content)
      .digest("hex");
    await assertProvenanceFailure(
      fixture.input,
      /no execution row exactly binds|working directory is missing or unsafe/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("AC-TESTER-020 adversarial provenance: a stale E2E input revision cannot reuse approval", async () => {
  const fixture = await linkedE2eProvenanceFixture();
  try {
    await writeFile(
      path.join(fixture.e2eRoot, "playwright.config.mjs"),
      "export default { retries: 1 };\n",
      "utf8",
    );
    await assertProvenanceFailure(fixture.input, /E2E suite revision token is stale/iu);
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

async function linkedE2eProvenanceFixture(): Promise<Awaited<ReturnType<typeof provenanceFixture>> & {
  e2eRoot: string;
  baseUrl: string;
  scriptPath: string;
  scriptHash: string;
  copiedEvidencePath: string;
  copiedEvidenceAbsolutePath: string;
}> {
  const fixture = await provenanceFixture();
  const e2eRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-linked-e2e-")));
  const originalCleanup = fixture.cleanup;
  fixture.cleanup = async () => {
    await Promise.all([
      originalCleanup(),
      rm(e2eRoot, { recursive: true, force: true }),
    ]);
  };
  await mkdir(path.join(e2eRoot, "tests"), { recursive: true });
  await writeFile(
    path.join(e2eRoot, "package.json"),
    `${JSON.stringify({ scripts: { "test:e2e": "playwright test" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(e2eRoot, "playwright.config.mjs"),
    "export default { use: { browserName: 'chromium' } };\n",
    "utf8",
  );
  const scriptRelativePath = "tests/checkout-coupon.spec.ts";
  const scriptPath = path.join(e2eRoot, ...scriptRelativePath.split("/"));
  const scriptContent = "// frozen linked-workspace E2E contract for CC-AC-001 and REG-001\n";
  const scriptHash = createHash("sha256").update(scriptContent).digest("hex");
  await writeFile(scriptPath, scriptContent, "utf8");
  const e2eRevisionToken = await captureE2eInputRevisionToken(e2eRoot);
  const e2eGitState = await captureVerificationGitState(e2eRoot);
  const e2eGitBinding = linkedE2eGitBinding(e2eGitState);

  const baseUrl = "http://127.0.0.1:4173/app";
  const descriptorContent = `${JSON.stringify({
    version: 1,
    e2eRoot,
    packageManager: "npm",
    testScript: "test:e2e",
    sourceStartScript: "start:e2e",
    baseUrl,
    browser: "chromium",
    playwrightVersion: "1.62.1",
  }, null, 2)}\n`;
  await mkdir(path.join(fixture.root, ".ai-sdlc"), { recursive: true });
  await writeFile(
    path.join(fixture.root, ".ai-sdlc", "e2e-workspace.json"),
    descriptorContent,
    "utf8",
  );
  const descriptorHash = createHash("sha256").update(descriptorContent).digest("hex");
  const productRevision = await captureVerificationWorkspaceRevision({
    projectRoot: fixture.root,
    selectedOutputPaths: [path.join(fixture.root, fixture.report.filePath)],
  });
  const productGitState = await captureVerificationGitState(fixture.root);
  fixture.report.content = fixture.report.content.replaceAll(
    fixture.workspaceToken,
    productRevision.token,
  );
  fixture.workspaceToken = productRevision.token;
  const runnerStarted = fixture.input.phase.events.find(
    ({ eventType }) => eventType === "runner.started",
  );
  assert.ok(runnerStarted?.payload && typeof runnerStarted.payload === "object");
  Object.assign(runnerStarted.payload as Record<string, unknown>, {
    workspaceRevisionToken: productRevision.token,
    verificationGitState: productGitState,
  });

  const command = "npm run test:e2e";
  const commandHash = createHash("sha256").update(command).digest("hex");
  const patchHash = createHash("sha256").update("human-approved script manifest").digest("hex");
  const authoringExecutionId = randomUUID();
  const copiedEvidencePath = path.posix.join(
    "test-results",
    "ai-sdlc",
    fixture.execution.id,
    "playwright-report",
    "index.html",
  );
  const copiedEvidenceAbsolutePath = path.join(
    fixture.root,
    ...copiedEvidencePath.split("/"),
  );
  await mkdir(path.dirname(copiedEvidenceAbsolutePath), { recursive: true });
  await writeFile(copiedEvidenceAbsolutePath, "durable current Playwright result\n", "utf8");

  fixture.report.content = fixture.report.content
    .replace("**Current revision:**", "**Product revision binding:**")
    .replace(
      [
        "## E2E Stage 2: Crystallization",
        "",
        "- **E2E script required:** yes — browser journey risk",
      ].join("\n"),
      [
        "## E2E Stage 0: Linked workspace and readiness",
        "",
        "- **E2E required:** yes — browser journey risk",
        "",
        "## E2E Stage 2: Crystallization and script review",
      ].join("\n"),
    )
    .replace(
      "| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |",
      "| Execution | Exact command and trusted working directory | Product and E2E revisions / real browser | Result | Durable evidence |",
    )
    .replace(
      "| Criterion or regression obligation | Repository test or observation | Execution evidence | Result |",
      "| Criterion or regression obligation | Test or declared observation | Current machine execution evidence | Result |",
    )
    .replaceAll(
      `platform execution ${fixture.execution.id}`,
      `platform execution ${fixture.execution.id}; e2e workspace sha256:${e2eRevisionToken}; ${e2eGitBinding}`,
    )
    .replace(
      `- **Platform execution ID:** ${fixture.execution.id}`,
      [
        `- **Platform execution ID:** ${fixture.execution.id}`,
        `- **Linked E2E Workspace binding:** ${e2eRoot}; descriptor sha256:${descriptorHash}`,
        `- **E2E suite revision binding:** e2e workspace sha256:${e2eRevisionToken}; ${e2eGitBinding}`,
        `- **Approved script manifest:** sha256:${patchHash}; human review REVIEW-001`,
      ].join("\n"),
    )
    .replaceAll(
      "npx playwright test tests/e2e/checkout-coupon.spec.ts",
      command,
    )
    .replaceAll("tests/e2e/checkout-coupon.spec.ts", scriptRelativePath)
    .replaceAll(fixture.root, e2eRoot)
    .replaceAll("playwright-report/index.html", copiedEvidencePath)
    .replace(
      `- **Repository test path:** ${scriptRelativePath}`,
      [
        `- **Repository test path:** ${scriptRelativePath}`,
        `- **Aggregate manifest hash:** sha256:${patchHash}`,
        `- **Human script review:** approved sha256:${patchHash}; REVIEW-001`,
        `- ${scriptRelativePath} — sha256:${scriptHash}`,
      ].join("\n"),
    );
  fixture.report.contentHash = createHash("sha256")
    .update(fixture.report.content)
    .digest("hex");

  const now = fixture.execution.finishedAt ?? new Date().toISOString();
  fixture.input.phase.events = [
    fixture.input.phase.events.find((candidate) => candidate.eventType === "runner.started")!,
    event(fixture.execution.id, 2, "e2e.execution.started", {
      e2eRoot,
      descriptorHash,
      patchHash,
      e2eWorkspaceRevisionToken: e2eRevisionToken,
      e2eGitState,
      browser: { executablePath: "/platform/chromium", version: "130.0" },
    }, now),
    event(fixture.execution.id, 3, "item.completed", {
      type: "item.completed",
      item: {
        type: "command_execution",
        status: "completed",
        exit_code: 0,
        commandHash,
      },
    }, now),
    event(fixture.execution.id, 4, "e2e.execution.completed", {
      workingDirectory: e2eRoot,
      command,
      commandHash,
      exitCode: 0,
      testExitCode: 0,
      passed: true,
      serverCleanup: "sigterm",
      descriptorHash,
      authoringExecutionId,
      authoringPatchHash: patchHash,
      productRevisionToken: fixture.workspaceToken,
      e2eWorkspaceRevisionToken: e2eRevisionToken,
      e2eGitState,
      browser: { executablePath: "/platform/chromium", version: "130.0" },
      targetProbe: { url: baseUrl, status: 200, browserVersion: "130.0" },
      scripts: [{
        path: scriptRelativePath,
        sha256: scriptHash,
        bytes: Buffer.byteLength(scriptContent),
      }],
      evidence: [{
        path: copiedEvidencePath,
        sha256: fixture.evidenceHash,
        bytes: Buffer.byteLength("durable current Playwright result\n"),
      }],
    }, now),
    event(fixture.execution.id, 5, "runner.completed", { exitCode: 0 }, now),
  ];

  return {
    ...fixture,
    e2eRoot,
    baseUrl,
    scriptPath,
    scriptHash,
    copiedEvidencePath,
    copiedEvidenceAbsolutePath,
  };
}

function gitReportBinding(state: VerificationGitState): string {
  if (state.kind === "head") return `git HEAD ${state.head}`;
  if (state.kind === "unborn") return `git unborn ${state.symbolicHead}`;
  return "git state:not-repository";
}

function linkedE2eGitBinding(state: VerificationGitState): string {
  if (state.kind === "head") return `e2e git HEAD ${state.head}`;
  if (state.kind === "unborn") return `e2e git unborn ${state.symbolicHead}`;
  return "e2e git state:not-repository";
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
