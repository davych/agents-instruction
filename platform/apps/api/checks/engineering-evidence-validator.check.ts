import assert from "node:assert/strict";
import test from "node:test";

import {
  engineeringEvidenceArtifactKeys,
  engineeringEvidenceRepairFeedback,
  engineeringReviewHeadings,
  engineeringVerificationTiers,
  passingEngineeringVerificationTiers,
  validateEngineeringEvidencePack,
} from "../src/services/engineering-evidence-validator.ts";

const acceptanceCriteria = [
  "The canonical Software Engineer policy and role workflow are loaded.",
  "A fresh initialization contains the complete role pack.",
] as const;

test("AC-ENG-003/007: the complete seven-artifact Tier A pack passes", () => {
  assert.deepEqual(engineeringEvidenceArtifactKeys, [
    "implementation-notes",
    "implementation-plan",
    "implementation-tasks",
    "engineering-session-log",
    "engineering-test-evidence",
    "engineering-review",
    "engineering-provenance",
  ]);
  assert.deepEqual(engineeringVerificationTiers, ["A", "B", "C", "Limited"]);
  assert.deepEqual(passingEngineeringVerificationTiers, ["A", "B"]);
  assert.equal(engineeringReviewHeadings.length, 7);
  assert.equal(new Set(engineeringReviewHeadings).size, 7);
  assert.ok(engineeringReviewHeadings.some((heading) => /security/iu.test(heading)));

  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: validPack("A"),
    acceptanceCriteria,
    reviewComment: "The evidence pack is ready for human review.",
  }), { verificationTier: "A" });
});

test("AC-CLARITY-024: rerun feedback contains only selected evidence issues plus global issues", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "implementation-notes",
    (content) => content.replace("Ready for verification", "Complete for Tester handoff"),
  );
  const feedback = engineeringEvidenceRepairFeedback({
    artifacts,
    acceptanceCriteria: [],
    selectedArtifactKeys: ["implementation-notes"],
  });

  assert.ok(feedback);
  assert.match(feedback, /machine evidence-gate repair/iu);
  assert.match(feedback, /authoritative acceptance criterion/iu);
  assert.match(feedback, /implementation-notes: Status must be exactly Ready for verification/iu);
  assert.doesNotMatch(feedback, /engineering-review:/iu);
  assert.match(feedback, /preserve.*template headings.*table columns/iu);
});

test("AC-CLARITY-024: a valid pack adds no machine repair feedback", () => {
  assert.equal(engineeringEvidenceRepairFeedback({
    artifacts: validPack("A"),
    acceptanceCriteria,
    selectedArtifactKeys: [...engineeringEvidenceArtifactKeys],
  }), undefined);
});

test("AC-CLARITY-024: repair feedback gives exact canonical repairs for all four affected evidence types", () => {
  let artifacts = withTesterDeferredSessionGate(
    "Blocked / deferred",
    "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
  );
  artifacts = replaceArtifact(
    artifacts,
    "engineering-test-evidence",
    () => canonicalTableTestEvidence({
      tier: "A",
      resultEvidence: "The rendered output and state transition were asserted.",
    }),
  );
  artifacts = replaceArtifact(
    artifacts,
    "engineering-review",
    () => canonicalTableReview({
      lensRows: {
        [engineeringReviewHeadings[0]!]: [
          "| none found | N/A | N/A | N/A | N/A | resolved |",
        ],
      },
    }),
  );
  artifacts = replaceArtifact(
    artifacts,
    "engineering-provenance",
    (content) => content.replace("PR created or opened by Software Engineer: No\n", ""),
  );

  const feedback = engineeringEvidenceRepairFeedback({
    artifacts,
    acceptanceCriteria,
    selectedArtifactKeys: [
      "engineering-session-log",
      "engineering-test-evidence",
      "engineering-review",
      "engineering-provenance",
    ],
  });

  assert.ok(feedback);
  assert.match(feedback, /stable AC ID.*real executable test path and test name.*durable artifact, path, URL, or command reference/isu);
  assert.match(feedback, /\| none found \| N\/A \| <durable evidence reference> \| N\/A \| N\/A \| not-applicable \|/u);
  assert.match(feedback, /remove the downstream Tester row from `Verification gates`/iu);
  assert.match(feedback, /preserve its true `Blocked \/ deferred`.*`Owner: Tester`.*Verification\/Release impact.*`Outcome`.*`Known limitations`.*`Next owner`/isu);
  assert.match(feedback, /PR created or opened by Software Engineer: No/iu);
  assert.match(feedback, /PR published by Software Engineer: No/iu);
  assert.match(feedback, /Merge\/deploy\/release performed by Software Engineer: No/iu);
});

test("AC-ENG-007: approval rejects an otherwise-valid pack without acceptance criteria", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: validPack("A"),
      acceptanceCriteria: [],
      reviewComment: "A legacy run supplied no Change Contract acceptance criteria.",
    }),
    [/acceptance|criterion|criteria|Change Contract/iu],
  );
});

for (const evidenceKey of engineeringEvidenceArtifactKeys.slice(1)) {
  test(`AC-ENG-003/007: implementation-notes Evidence index requires ${evidenceKey}`, () => {
    const artifacts = replaceArtifact(
      validPack("A"),
      "implementation-notes",
      (content) => content.replace(
        new RegExp(`^- ${escapeRegExp(evidenceKey)}:.*(?:\\n|$)`, "mu"),
        "",
      ),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `The Evidence index omits ${evidenceKey}.`,
      }),
      [new RegExp(`${escapeRegExp(evidenceKey)}|Evidence index`, "iu")],
    );
  });
}

test("AC-ENG-007: missing artifacts and unresolved placeholders are reported together", () => {
  const artifacts = validPack("A")
    .filter((artifact) => artifact.artifactKey !== "engineering-provenance")
    .map((artifact) => artifact.artifactKey === "implementation-plan"
      ? { ...artifact, content: artifact.content.replace("Add the evidence validation gate.", "{{TODO}}") }
      : artifact);

  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "Please approve this incomplete pack.",
    }),
    [/engineering-provenance/iu, /placeholder|unresolved|TODO/iu],
  );
});

test("AC-ENG-007: every acceptance criterion needs explicit independent-test coverage", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => content.replace("| CC-AC-002 |", "| implementation regression |"),
  );

  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The evidence pack is ready for human review.",
    }),
    [/CC-AC-002/u],
  );
});

test("AC-ENG-007: an authoritative stable acceptance ID is traced without a CC-AC alias", () => {
  const artifacts = validPack("A").map((artifact) => ({
    ...artifact,
    content: artifact.content
      .replaceAll("CC-AC-001 and CC-AC-002", "AC-ENG-007")
      .replaceAll("CC-AC-001", "AC-ENG-007")
      .replaceAll("CC-AC-002", "AC-ENG-007"),
  }));
  assert.ok(artifacts.every((artifact) => !/CC-AC-/u.test(artifact.content)));
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts,
    acceptanceCriteria: ["AC-ENG-007: approval rejects incomplete engineering evidence."],
    reviewComment: "The authoritative AC-ENG-007 ID is preserved throughout the evidence chain.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007: an authoritative stable acceptance ID followed by an ASCII dash is preserved", () => {
  const artifacts = validPack("A").map((artifact) => ({
    ...artifact,
    content: artifact.content
      .replaceAll("CC-AC-001 and CC-AC-002", "AC-ENG-007")
      .replaceAll("CC-AC-001", "AC-ENG-007")
      .replaceAll("CC-AC-002", "AC-ENG-007"),
  }));
  assert.ok(artifacts.every((artifact) => !/CC-AC-/u.test(artifact.content)));
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts,
    acceptanceCriteria: ["AC-ENG-007 - approval rejects incomplete engineering evidence"],
    reviewComment: "The authoritative AC-ENG-007 ID remains the sole trace ID.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007: criteria without authoritative IDs still derive ordered CC-AC aliases", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: validPack("A"),
    acceptanceCriteria,
    reviewComment: "The two no-ID criteria are traced as CC-AC-001 and CC-AC-002.",
  }), { verificationTier: "A" });
});

for (const tier of ["A", "B"] as const) {
  test(`AC-ENG-007: a complete canonical Tier ${tier} isolation and coverage table passes`, () => {
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts: withCanonicalTestEvidence({ tier }),
      acceptanceCriteria,
      reviewComment: `Canonical Tier ${tier} metadata and durable coverage evidence are complete.`,
    }), { verificationTier: tier });
  });

  for (const missingField of [
    "Test-authoring model/session",
    "Requirements visible while authoring",
    "Implementation visible while authoring",
    "Test intent frozen at",
  ] as const) {
    test(`AC-ENG-007: canonical Tier ${tier} rejects missing ${missingField}`, () => {
      assertGateFailure(
        () => validateEngineeringEvidencePack({
          artifacts: withCanonicalTestEvidence({ tier, omitIsolationField: missingField }),
          acceptanceCriteria,
          reviewComment: `Canonical Tier ${tier} isolation omits ${missingField}.`,
        }),
        [new RegExp(`${escapeRegExp(missingField)}|Isolation|Tier ${tier}`, "iu")],
      );
    });
  }

  test(`AC-ENG-007: canonical Tier ${tier} rejects implementation visibility`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalTestEvidence({ tier, implementationVisible: "Yes; full source and diff" }),
        acceptanceCriteria,
        reviewComment: `Tier ${tier} authoring had implementation visibility.`,
      }),
      [/Implementation visible|Isolation|Tier|source|diff/iu],
    );
  });

  test(`AC-ENG-007: canonical Tier ${tier} rejects the implementation-author session`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalTestEvidence({
          tier,
          testAuthoringSession: "same implementation session with the implementation author",
        }),
        acceptanceCriteria,
        reviewComment: `Tier ${tier} uses the implementation-author session.`,
      }),
      [/Test-authoring|Isolation|independent|same implementation session|author/iu],
    );
  });
}

test("AC-ENG-007: an Isolation section containing only Tier A metadata is rejected", () => {
  const artifacts = replaceArtifact(
    withCanonicalTestEvidence({ tier: "A" }),
    "engineering-test-evidence",
    (content) => content.replace(
      /\| Tier \| A \|[\s\S]*?\n\n## Acceptance coverage/u,
      "| Tier | A |\n\n## Acceptance coverage",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "Only the Tier A token remains; authoring and frozen-intent metadata are absent.",
    }),
    [/Isolation|Test-authoring|Requirements visible|Implementation visible|frozen/iu],
  );
});

for (const [label, overrides] of [
  ["empty test path/name", { testPathAndName: "" }],
  ["none test path/name", { testPathAndName: "none" }],
  ["empty result evidence", { resultEvidence: "" }],
  ["none result evidence", { resultEvidence: "none" }],
] as const) {
  test(`AC-ENG-007: canonical Passed coverage rejects ${label}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalTestEvidence({ tier: "A", ...overrides }),
        acceptanceCriteria,
        reviewComment: `The Passed row contains ${label}.`,
      }),
      [/Acceptance coverage|test path|test name|Evidence|CC-AC-001|CC-AC-002/iu],
    );
  });
}

test("AC-ENG-007: canonical coverage rejects assertion-only Evidence despite a durable test reference", () => {
  const artifacts = replaceArtifact(
    withCanonicalTestEvidence({
      tier: "A",
      resultEvidence: "Focused test included in the full run; state and rendered output asserted",
    }),
    "engineering-test-evidence",
    (content) => content.replace(
      "Canonical role workflow is loaded.",
      "Re-entry resumes the first incomplete task without a duplicate count.",
    ),
  );

  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The Evidence cell has an assertion summary but no durable reference.",
    }),
    [/engineering-test-evidence|CC-AC-001|passing automated-test row/iu],
  );
});

for (const proseEvidence of [
  "Assertions cover status/count transitions.",
  "Assertions cover pinyin/flashcard/quiz branches.",
  "Keyboard coverage includes Tab/Enter.",
  "All 4/4 scenarios passed.",
] as const) {
  test(`AC-ENG-007: slash prose is not durable Evidence: ${proseEvidence}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalTestEvidence({ tier: "A", resultEvidence: proseEvidence }),
        acceptanceCriteria,
        reviewComment: "Slash-separated prose is an assertion summary, not a durable reference.",
      }),
      [/engineering-test-evidence|CC-AC-001|passing automated-test row/iu],
    );
  });
}

test("AC-ENG-007: prose beginning with a tool name is not an exact command reference", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalTestEvidence({
        tier: "A",
        resultEvidence: "npm test passed but no durable result was retained",
      }),
      acceptanceCriteria,
      reviewComment: "A command claim without exact command formatting or retained output is not durable.",
    }),
    [/engineering-test-evidence|CC-AC-001|passing automated-test row/iu],
  );
});

for (const durableEvidence of [
  "artifact:engineering-test-evidence@rev-2",
  "https://ci.example/runs/42",
  "artifacts/test-results/engineering-evidence-validator.tap",
  "`yarn workspace @ai-sdlc/api test`",
  "npm test",
  `git:${"a".repeat(40)}`,
] as const) {
  test(`AC-ENG-007: a durable Evidence reference passes: ${durableEvidence}`, () => {
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts: withCanonicalTestEvidence({ tier: "A", resultEvidence: durableEvidence }),
      acceptanceCriteria,
      reviewComment: "The Evidence cell contains a durable machine-traceable reference.",
    }), { verificationTier: "A" });
  });
}

for (const [label, overrides] of [
  ["Acceptance gate Blocked", { acceptanceGate: "Blocked; CC-AC-002 has no passing evidence." }],
  ["Project-check gate Failed", { projectCheckGate: "Failed; yarn test exited 1." }],
  ["Ready for review No", { readyForReview: "No" }],
] as const) {
  test(`AC-ENG-007: canonical test conclusion rejects ${label} despite top-level Pass`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalTestEvidence({ tier: "A", ...overrides }),
        acceptanceCriteria,
        reviewComment: `The canonical conclusion explicitly says ${label}.`,
      }),
      [/Conclusion|Acceptance gate|Project-check gate|Ready for review|Blocked|Failed|No/iu],
    );
  });
}

test("AC-ENG-007: session Project checks Blocked cannot be hidden by top-level Complete", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalSessionGates("Blocked", "CI access unavailable"),
      acceptanceCriteria,
      reviewComment: "The session Project checks gate is Blocked.",
    }),
    [/session|Verification gates|Project checks|Blocked/iu],
  );
});

test("AC-ENG-007: session Pass with Blocker / waiver No remains a valid success row", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withCanonicalSessionGates("Pass", "No"),
    acceptanceCriteria,
    reviewComment: "The session Project checks gate passed and has no blocker or waiver.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007: a Tester-owned downstream deferred gate must move out of Verification gates", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withTesterDeferredSessionGate(
        "Blocked / deferred",
        "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
      ),
      acceptanceCriteria,
      reviewComment: "The downstream deferral belongs under Outcome, limitations, or Next owner.",
    }),
    [/session|Verification gates|downstream Tester deferral|Outcome|limitations/iu],
  );
});

for (const [label, result, boundary] of [
  [
    "non-Tester owner",
    "Blocked / deferred",
    "Owner: Software Engineer; blocks Verification/Release only, not this implementation handoff",
  ],
  [
    "Implementation impact",
    "Blocked / deferred",
    "Owner: Tester; blocks Implementation and Verification",
  ],
  [
    "ordinary blocked result",
    "Blocked",
    "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
  ],
  [
    "failed deferred result",
    "Failed / deferred",
    "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
  ],
  [
    "pending deferred result",
    "Pending / deferred",
    "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
  ],
  [
    "skipped deferred result",
    "Skipped / deferred",
    "Owner: Tester; blocks Verification/Release only, not this implementation handoff",
  ],
] as const) {
  test(`AC-ENG-007: a deferred-looking session gate still blocks for ${label}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withTesterDeferredSessionGate(result, boundary),
        acceptanceCriteria,
        reviewComment: `The session row has ${label}.`,
      }),
      [/session|Verification gates|Blocked|deferred/iu],
    );
  });
}

for (const result of ["Blocked", "Failed", "Pending", "Untested", "Skipped"] as const) {
  test(`AC-ENG-007: provenance Verification gates rejects ${result} despite top-level Complete`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalProvenanceGates(result),
        acceptanceCriteria,
        reviewComment: `The provenance Project checks result is ${result}.`,
      }),
      [/provenance|Verification gates|Project checks|Blocked|Failed|Pending|Untested|Skipped/iu],
    );
  });
}

for (const tier of ["A", "B"] as const) {
  for (const [label, isolationClaim] of [
    [
      "same implementation session",
      "Isolation: tests were authored by the implementation author in the same implementation session.",
    ],
    [
      "author read full source and diff",
      "Isolation: the test author read the full implementation source and git diff before authoring tests.",
    ],
  ] as const) {
    test(`AC-ENG-007: Tier ${tier} rejects ${label}`, () => {
      const artifacts = replaceArtifact(
        validPack(tier),
        "engineering-test-evidence",
        (content) => replaceCanonicalIsolationField(
          content,
          "Test-authoring model/session",
          isolationClaim,
        ),
      );
      assertGateFailure(
        () => validateEngineeringEvidencePack({
          artifacts,
          acceptanceCriteria,
          reviewComment: `Tier ${tier} evidence admits ${label}.`,
        }),
        [/Isolation|Tier|independent|same implementation session|source|diff/iu],
      );
    });
  }
}

test("AC-ENG-007: Tier A rejects the exact combined same-session and full-source admission", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalIsolationField(
      content,
      "Test-authoring model/session",
      "same implementation session; test author read the full implementation source and diff before authoring.",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "Tier A admits same-session authorship and full source/diff access.",
    }),
    [/Isolation|Tier A|independent|same implementation session|source|diff/iu],
  );
});

test("AC-ENG-007: mapped criteria still fail when their independent result is not passing", () => {
  for (const result of ["Untested", "Blocked", "Failed", "Pending", "Not run", "None run"]) {
    const artifacts = replaceArtifact(
      validPack("A"),
      "engineering-test-evidence",
      (content) => replaceCanonicalCoverageResult(content, "CC-AC-001", result),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `CC-AC-001 is ${result}.`,
      }),
      [/CC-AC-001|engineering-test-evidence|pass/iu],
    );
  }
});

for (const misleadingResult of ["Did not pass", "Not successful", "Should pass"] as const) {
  test(`AC-ENG-007: AC result "${misleadingResult}" cannot satisfy the gate`, () => {
    const acceptanceResult = replaceArtifact(
      validPack("A"),
      "engineering-test-evidence",
      (content) => replaceCanonicalCoverageResult(content, "CC-AC-001", misleadingResult),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: acceptanceResult,
        acceptanceCriteria,
        reviewComment: `CC-AC-001 result says ${misleadingResult}.`,
      }),
      [/CC-AC-001|engineering-test-evidence|pass/iu],
    );
  });

  test(`AC-ENG-007: command result "${misleadingResult}" cannot satisfy the gate`, () => {
    const commandResult = replaceArtifact(
      validPack("A"),
      "engineering-test-evidence",
      (content) => replaceCanonicalCommandResult(
        replaceCanonicalCommandResult(content, "npm test", misleadingResult),
        "yarn test",
        misleadingResult,
      ),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: commandResult,
        acceptanceCriteria,
        reviewComment: `Every command result says ${misleadingResult}.`,
      }),
      [/command|engineering-test-evidence|pass|successful/iu],
    );
  });
}

test("AC-ENG-007: an AC result cannot hide None run beside a Passed token", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalCoverageResult(content, "CC-AC-001", "None run; Pass"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "CC-AC-001 was not run despite the trailing token.",
    }),
    [/CC-AC-001|None run|engineering-test-evidence/iu],
  );
});

test("AC-ENG-007: a command cannot hide None run beside a Passed token", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalCommandResult(
      replaceCanonicalCommandResult(content, "npm test", "None run; Pass"),
      "yarn test",
      "None run; Pass",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "No command was actually run.",
    }),
    [/command|None run|engineering-test-evidence/iu],
  );
});

test("AC-ENG-007: an AC result cannot hide Skipped beside a Passed token", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalCoverageResult(content, "CC-AC-001", "Skipped; Pass"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "CC-AC-001 was skipped despite the trailing Passed token.",
    }),
    [/CC-AC-001|Skipped|engineering-test-evidence/iu],
  );
});

test("AC-ENG-007: a command cannot hide Skipped beside a Passed token", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalCommandResult(
      replaceCanonicalCommandResult(content, "npm test", "Skipped; Pass"),
      "yarn test",
      "Skipped; Pass",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The commands were skipped despite the trailing Passed token.",
    }),
    [/command|Skipped|engineering-test-evidence/iu],
  );
});

test("AC-ENG-007: one failed required command cannot be hidden by another passed command", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-test-evidence",
    (content) => replaceCanonicalCommandResult(content, "npm test", "Failed, exit code 1"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "npm test failed with exit code 1 even though yarn test passed.",
    }),
    [/command|npm test|Failed|exit code 1|engineering-test-evidence/iu],
  );
});

test("AC-ENG-007: a negated complete token cannot satisfy the session outcome", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-session-log",
    (content) => content.replace(
      "The evidence pack is ready for independent verification.",
      "Result: Not complete",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The session outcome explicitly says it is not complete.",
    }),
    [/Outcome|Not complete|session/iu],
  );
});

for (const unfinishedStatus of ["pending", "waiting", "failed"] as const) {
  test(`AC-ENG-007: task ledger rejects an unfinished ${unfinishedStatus} task beside a completed task`, () => {
    const artifacts = replaceArtifact(
      validPack("A"),
      "implementation-tasks",
      (content) => content.replace(
        "- [x] ENG-TASK-002 — scaffold exactly one native Agent and the complete role pack.",
        `- ENG-TASK-002 — Status: ${unfinishedStatus} — scaffold exactly one native Agent and the complete role pack.`,
      ),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `ENG-TASK-002 is still ${unfinishedStatus}.`,
      }),
      [/ENG-TASK-002|task|pending|waiting|failed|complete/iu],
    );
  });
}

for (const checkedFailureStatus of ["failed", "cancelled"] as const) {
  test(`AC-ENG-007: a checked task with Status: ${checkedFailureStatus} remains non-passing`, () => {
    const artifacts = replaceArtifact(
      validPack("A"),
      "implementation-tasks",
      (content) => content.replace(
        "- [x] ENG-TASK-002 — scaffold exactly one native Agent and the complete role pack.",
        `- [x] ENG-TASK-002 — Status: ${checkedFailureStatus} — scaffold exactly one native Agent and the complete role pack.`,
      ),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `ENG-TASK-002 is checked but explicitly ${checkedFailureStatus}.`,
      }),
      [/ENG-TASK-002|task|failed|cancelled|complete/iu],
    );
  });
}

for (const artifactKey of engineeringEvidenceArtifactKeys) {
  for (const state of ["Failed", "Blocked"] as const) {
    test(`AC-ENG-007: ${artifactKey} rejects a top-level State: ${state}`, () => {
      const artifacts = replaceArtifact(
        validPack("A"),
        artifactKey,
        (content) => addTopLevelState(content, state),
      );
      assertGateFailure(
        () => validateEngineeringEvidencePack({
          artifacts,
          acceptanceCriteria,
          reviewComment: `${artifactKey} explicitly declares State: ${state}.`,
        }),
        [new RegExp(`${state}|state|${escapeRegExp(artifactKey)}`, "iu")],
      );
    });
  }
}

test("AC-ENG-007: implementation notes cannot hide Blocked beside Ready", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "implementation-notes",
    (content) => content.replace(
      "Ready for verification",
      "Ready for verification\nState: Blocked",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The notes contradict Ready with State: Blocked.",
    }),
    [/implementation-notes|Ready|Blocked|state/iu],
  );
});

test("AC-ENG-007: session outcome cannot hide Blocked beside Complete", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-session-log",
    (content) => content.replace(
      "The evidence pack is ready for independent verification.",
      "State: Complete\nState: Blocked",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The session outcome contradicts Complete with State: Blocked.",
    }),
    [/engineering-session-log|session|Complete|Blocked|state/iu],
  );
});

for (const blockedArtifactKey of [
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
] as const) {
  test(`AC-ENG-007: ${blockedArtifactKey} cannot pass with an explicit Blocked state`, () => {
    const heading = blockedArtifactKey === "engineering-review" ? "Verdict" : "Status";
    const artifacts = replaceArtifact(
      validPack("A"),
      blockedArtifactKey,
      (content) => `${content}\n## ${heading}\nState: Blocked\n`,
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `${blockedArtifactKey} is explicitly blocked.`,
      }),
      [/Blocked|Status|Verdict|artifact/iu],
    );
  });
}

test("AC-ENG-007: Tier C and Limited reject malformed verification exception headers", () => {
  for (const tier of ["C", "Limited"] as const) {
    const artifacts = validPack(tier);
    for (const reviewComment of [
      "",
      `verification gate exception: Tier ${tier} - This has enough explanation text`,
      `Verification gate exception: Tier ${tier}: This has enough explanation text`,
      `Verification gate exception: Tier ${tier} - short`,
      `Verification gate exception: Tier ${tier} - <reason must be supplied>`,
    ]) {
      assertGateFailure(
        () => validateEngineeringEvidencePack({ artifacts, acceptanceCriteria, reviewComment }),
        [/Verification gate exception/u],
      );
    }
  }
});

const verificationExceptionFields = [
  "owner",
  "reference",
  "scope",
  "compensating evidence",
  "residual risk",
  "revisit",
] as const;

for (const tier of ["C", "Limited"] as const) {
  test(`AC-ENG-007: a complete human Tier ${tier} exception passes`, () => {
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts: validPack(tier),
      acceptanceCriteria,
      reviewComment: verificationExceptionComment(tier),
    }), { verificationTier: tier });
  });

  test(`AC-ENG-007: Tier ${tier} header and reason alone cannot waive verification`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: validPack(tier),
        acceptanceCriteria,
        reviewComment: verificationExceptionComment(tier).split("\n").slice(0, 2).join("\n"),
      }),
      [/owner|reference|scope|compensating|residual|revisit|exception/iu],
    );
  });

  for (const missingField of verificationExceptionFields) {
    test(`AC-ENG-007: Tier ${tier} exception rejects missing ${missingField}`, () => {
      assertGateFailure(
        () => validateEngineeringEvidencePack({
          artifacts: validPack(tier),
          acceptanceCriteria,
          reviewComment: verificationExceptionComment(tier, { omit: missingField }),
        }),
        [new RegExp(escapeRegExp(missingField), "iu")],
      );
    });
  }

  test(`AC-ENG-007: Tier ${tier} exception owner must be a non-Agent human`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: validPack(tier),
        acceptanceCriteria,
        reviewComment: verificationExceptionComment(tier, {
          owner: "Software Engineer Agent",
        }),
      }),
      [/owner|human|Agent/iu],
    );
  });

  for (const nonHumanOwner of [
    "ChatGPT reviewer",
    "LLM verification service",
    "Claude reviewer",
    "Gemini reviewer",
  ] as const) {
    test(`AC-ENG-007: Tier ${tier} exception rejects non-human owner ${nonHumanOwner}`, () => {
      assertGateFailure(
        () => validateEngineeringEvidencePack({
          artifacts: validPack(tier),
          acceptanceCriteria,
          reviewComment: verificationExceptionComment(tier, { owner: nonHumanOwner }),
        }),
        [/owner|human|ChatGPT|LLM|Claude|Gemini/iu],
      );
    });
  }

  test(`AC-ENG-007: Tier ${tier} exception cannot come from artifact content`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: replaceArtifact(
          validPack(tier),
          "engineering-test-evidence",
          (content) => `${content}\n${verificationExceptionComment(tier)}\n`,
        ),
        acceptanceCriteria,
        reviewComment: "The artifact itself contains a purported exception.",
      }),
      [/Verification gate exception/u],
    );
  });
}

test("AC-ENG-007: the template H2/H3 adversarial hierarchy passes", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: validPack("A"),
    acceptanceCriteria,
    reviewComment: "Pre-mortem and Edge-case-hunter are direct H3 children of the H2 adversarial pass.",
  }), { verificationTier: "A" });
});

for (const passName of ["Pre-mortem", "Edge-case-hunter"] as const) {
  test(`AC-ENG-007: ${passName} cannot be a peer of Adversarial pass`, () => {
    const peerHeading = replaceArtifact(
      validPack("A"),
      "engineering-review",
      (content) => content.replace(`### ${passName}`, `## ${passName}`),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: peerHeading,
        acceptanceCriteria,
        reviewComment: `${passName} is incorrectly an H2 peer of Adversarial pass.`,
      }),
      [/Adversarial pass|Pre-mortem|Edge-case-hunter|hierarchy|heading/iu],
    );
  });

  test(`AC-ENG-007: ${passName} cannot be nested under another review section`, () => {
    const wrongParent = replaceArtifact(
      validPack("A"),
      "engineering-review",
      (content) => moveAdversarialPassUnderSecurity(content, passName),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: wrongParent,
        acceptanceCriteria,
        reviewComment: `${passName} is an H3 under Security-sensitive decisions, not Adversarial pass.`,
      }),
      [/Adversarial pass|Pre-mortem|Edge-case-hunter|hierarchy|heading/iu],
    );
  });
}

const actionableReviewSections = [
  ...engineeringReviewHeadings.map((heading, index) => ({
    heading,
    headingLevel: 2,
    findingId: `ENG-REV-${String(index + 1).padStart(3, "0")}`,
  })),
  { heading: "Pre-mortem", headingLevel: 3, findingId: "ENG-ADV-001" },
  { heading: "Edge-case-hunter", headingLevel: 3, findingId: "ENG-ADV-002" },
] as const;

for (const { heading, headingLevel, findingId } of actionableReviewSections) {
  test(`AC-ENG-007: ${heading} rejects a one-line non-none finding`, () => {
    const artifacts = withReviewSectionFinding(
      heading,
      headingLevel,
      "Finding: a deterministic regression remains.",
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `${heading} contains a one-line finding without an actionable contract.`,
      }),
      [new RegExp(`${escapeRegExp(heading)}|ENG-(?:REV|ADV)|severity|evidence|impact|action|owner|status|resolution`, "iu")],
    );
  });

  test(`AC-ENG-007: ${heading} accepts a complete actionable finding contract`, () => {
    const artifacts = withReviewSectionFinding(
      heading,
      headingLevel,
      [
        `ID: ${findingId}`,
        "Severity: Medium",
        "Finding: a deterministic regression was reproduced.",
        `Evidence: docs/engineering-review/${findingId}.md`,
        "Impact: approval accuracy was at risk before remediation.",
        "Action: add the independent regression and enforce the semantic gate.",
        "Owner: Human reviewer Mei Chen",
        "Status: Resolved",
        `Resolution: fixed and independently verified in docs/engineering-review/${findingId}-resolution.md`,
        ...(/security/iu.test(heading) ? [
          "Human decision owner: Mei Chen, Security Lead; remediation closure accepted.",
          `Human decision reference: docs/engineering-review/${findingId}-decision.md`,
        ] : []),
      ].join("\n"),
    );
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: `${findingId} is resolved with actionable evidence.`,
    }), { verificationTier: "A" });
  });
}

const canonicalNoneLensRow = "| none found | N/A | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |";
const canonicalResolvedLensRow = "| ENG-REV-701 | medium | platform/apps/api/checks/engineering-evidence-validator.check.ts :: canonical review table | Canonical review rows could be rejected despite complete evidence. | Preserve canonical table parsing; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-REV-701-resolution.md |";
const canonicalResolvedSecurityRow = "| ENG-REV-710 | medium | docs/security/ENG-REV-710-evidence.md | A security boundary finding was remediated. | Preserve the regression; Human owner: Mei Chen | resolved; Human decision: docs/security/ENG-REV-710-decision.md |";
const canonicalActionOnlyLensRow = "| ENG-REV-720 | medium | platform/apps/api/checks/engineering-evidence-validator.check.ts :: owner contract | Approval accountability would be ambiguous without an owner. | Apply the validation fix before handoff | resolved; Resolution: docs/engineering-review/ENG-REV-720-resolution.md |";
const canonicalActionOnlySecurityRow = "| ENG-REV-721 | medium | docs/security/ENG-REV-721-evidence.md | Security closure would have no accountable human owner. | Apply the validation fix before handoff | resolved; Resolution: docs/security/ENG-REV-721-resolution.md; Human decision: SEC-123 |";
const canonicalOpenLensRow = "| ENG-REV-702 | high | platform/apps/api/checks/engineering-evidence-validator.check.ts :: open blocker | Approval would accept an unresolved regression. | Fix before approval; Owner: Human reviewer Mei Chen | open; Resolution: pending |";
const canonicalMissingEvidenceLensRow = "| ENG-REV-703 | medium |  | Approval evidence is incomplete. | Supply durable evidence; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-REV-703-resolution.md |";
const canonicalResolvedPreMortemRow = "| ENG-ADV-701 | medium | Canonical review-table parsing fails after a format change. | platform/apps/api/checks/engineering-evidence-validator.check.ts :: pre-mortem table | Approval evidence is unavailable. | Preserve and test all canonical columns; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-ADV-701-resolution.md |";
const canonicalResolvedEdgeCaseRow = "| ENG-ADV-702 | medium | A table cell contains punctuation and a durable path; expected behaviour is to preserve column boundaries. | platform/apps/api/checks/engineering-evidence-validator.check.ts :: edge-case table | The canonical row could otherwise be rejected. | Preserve exact column boundaries; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-ADV-702-resolution.md |";
const canonicalMissingFailurePreMortemRow = "| ENG-ADV-703 | medium |  | platform/apps/api/checks/engineering-evidence-validator.check.ts :: missing failure trigger | Approval could accept an incomplete adversarial finding. | Require a concrete plausible failure and trigger; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-ADV-703-resolution.md |";
const canonicalMissingConditionEdgeCaseRow = "| ENG-ADV-704 | medium | N/A | platform/apps/api/checks/engineering-evidence-validator.check.ts :: missing edge condition | Approval could accept an incomplete adversarial finding. | Require a concrete edge condition and expected behaviour; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-ADV-704-resolution.md |";

test("AC-ENG-007: the canonical review tables pass when every lens and adversarial row says none found", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withCanonicalReview(),
    acceptanceCriteria,
    reviewComment: "Every canonical finding table records none found.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007: none-found rows may retain only durable non-actionable Evidence cells", () => {
  const lensRows = Object.fromEntries(engineeringReviewHeadings.map((heading) => [
    heading,
    [
      "| none found | N/A | src/PinyinPractice.test.tsx and npm test 11/11 support the review conclusion | N/A | N/A | not-applicable |",
    ],
  ]));
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withCanonicalReview({
      lensRows,
      preMortemRows: [
        "| none found | N/A | N/A | src/PinyinPractice.test.tsx AC-03/04 and reducer idempotence checks | N/A | N/A | not-applicable |",
      ],
      edgeCaseRows: [
        "| none found | N/A | N/A | src/PinyinPractice.test.tsx AC-01 through AC-06; full suite passed | N/A | N/A | not-applicable |",
      ],
    }),
    acceptanceCriteria,
    reviewComment: "The none-found conclusions retain only durable review evidence.",
  }), { verificationTier: "A" });
});

for (const [label, row] of [
  [
    "severity",
    "| none found | high | src/auth.test.ts | N/A | N/A | not-applicable |",
  ],
  [
    "empty severity",
    "| none found |  | src/auth.test.ts | N/A | N/A | not-applicable |",
  ],
  [
    "impact",
    "| none found | N/A | src/auth.test.ts | Credentials may cross the trust boundary. | N/A | not-applicable |",
  ],
  [
    "required action",
    "| none found | N/A | src/auth.test.ts | N/A | Rotate credentials; Owner: Mei Chen | not-applicable |",
  ],
  [
    "non-canonical none impact",
    "| none found | N/A | src/auth.test.ts | none | N/A | not-applicable |",
  ],
  [
    "non-canonical not-applicable action",
    "| none found | N/A | src/auth.test.ts | N/A | not applicable | not-applicable |",
  ],
  [
    "open status",
    "| none found | N/A | src/auth.test.ts | N/A | N/A | open; remediation pending |",
  ],
  [
    "resolved status",
    "| none found | N/A | src/auth.test.ts | N/A | N/A | resolved |",
  ],
  [
    "prose status",
    "| none found | N/A | src/auth.test.ts | N/A | N/A | reviewed with no finding |",
  ],
] as const) {
  test(`AC-ENG-007: none-found rows cannot hide actionable ${label}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalReview({
          lensRows: { [engineeringReviewHeadings[0]!]: [row] },
        }),
        acceptanceCriteria,
        reviewComment: `The none-found row contains actionable ${label}.`,
      }),
      [/none found|contradict|engineering-review/iu],
    );
  });
}

test("AC-ENG-007/012: a none-found Security row cannot hide a security description outside Evidence", () => {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: {
          [securityHeading]: [
            "| none found | N/A | src/auth.test.ts | Credential exposure remains across the trust boundary. | N/A | not-applicable |",
          ],
        },
      }),
      acceptanceCriteria,
      reviewComment: "A security description is hidden in the Impact cell of a none-found row.",
    }),
    [/none found|Security|contradict|engineering-review/iu],
  );
});

for (const [label, options] of [
  [
    "Pre-mortem failure contract",
    {
      preMortemRows: [
        "| none found | N/A | A parser regression occurs after a template change. | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |",
      ],
    },
  ],
  [
    "Edge-case-hunter condition contract",
    {
      edgeCaseRows: [
        "| none found | N/A | Empty evidence should be rejected. | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |",
      ],
    },
  ],
  [
    "non-canonical Pre-mortem none contract",
    {
      preMortemRows: [
        "| none found | N/A | none | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |",
      ],
    },
  ],
] as const) {
  test(`AC-ENG-007: a none-found adversarial row cannot hide a ${label}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalReview(options),
        acceptanceCriteria,
        reviewComment: `${label} must use an ENG-ADV finding row.`,
      }),
      [/none found|Pre-mortem|Edge-case-hunter|contradict|engineering-review/iu],
    );
  });
}

test("AC-ENG-007: a complete canonical standard-lens actionable row passes", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withCanonicalReview({
      lensRows: { [engineeringReviewHeadings[0]!]: [canonicalResolvedLensRow] },
      summaryRows: [
        "| ENG-REV-701 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-701-resolution.md |",
      ],
    }),
    acceptanceCriteria,
    reviewComment: "ENG-REV-701 is resolved with a complete canonical row.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007/012: a resolved canonical Security row passes with a durable Human decision reference", () => {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withCanonicalReview({
      lensRows: { [securityHeading]: [canonicalResolvedSecurityRow] },
      summaryRows: [
        "| ENG-REV-710 | Security surface | medium | resolved | docs/security/ENG-REV-710-decision.md |",
      ],
    }),
    acceptanceCriteria,
    reviewComment: "ENG-REV-710 is resolved by the human security owner with durable evidence.",
  }), { verificationTier: "A" });
});

test("AC-ENG-007: a canonical standard-lens action without an owner is rejected", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: { [engineeringReviewHeadings[0]!]: [canonicalActionOnlyLensRow] },
        summaryRows: [
          "| ENG-REV-720 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-720-resolution.md |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "ENG-REV-720 records an action but no accountable owner.",
    }),
    [/ENG-REV-720|action|owner|accountable/iu],
  );
});

test("AC-ENG-007/012: a canonical Security action without a non-Agent human owner is rejected", () => {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: { [securityHeading]: [canonicalActionOnlySecurityRow] },
        summaryRows: [
          "| ENG-REV-721 | Security surface | medium | resolved | docs/security/ENG-REV-721-resolution.md; SEC-123 |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "ENG-REV-721 has resolution evidence but no accountable human security owner.",
    }),
    [/ENG-REV-721|Security|action|owner|human/iu],
  );
});

for (const [method, row, summaryId] of [
  ["Pre-mortem", canonicalResolvedPreMortemRow, "ENG-ADV-701"],
  ["Edge-case-hunter", canonicalResolvedEdgeCaseRow, "ENG-ADV-702"],
] as const) {
  test(`AC-ENG-007: a complete canonical ${method} actionable row passes`, () => {
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        ...(method === "Pre-mortem" ? { preMortemRows: [row] } : { edgeCaseRows: [row] }),
        summaryRows: [
          `| ${summaryId} | ${method} | medium | resolved | docs/engineering-review/${summaryId}-resolution.md |`,
        ],
      }),
      acceptanceCriteria,
      reviewComment: `${summaryId} is resolved with a complete canonical adversarial row.`,
    }), { verificationTier: "A" });
  });
}

for (const [method, row, summaryId] of [
  ["Pre-mortem", canonicalMissingFailurePreMortemRow, "ENG-ADV-703"],
  ["Edge-case-hunter", canonicalMissingConditionEdgeCaseRow, "ENG-ADV-704"],
] as const) {
  test(`AC-ENG-007: canonical ${method} rejects a missing failure or edge-condition contract`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalReview({
          ...(method === "Pre-mortem" ? { preMortemRows: [row] } : { edgeCaseRows: [row] }),
          summaryRows: [
            `| ${summaryId} | ${method} | medium | resolved | docs/engineering-review/${summaryId}-resolution.md |`,
          ],
        }),
        acceptanceCriteria,
        reviewComment: `${summaryId} omits the method-specific failure or edge-condition contract.`,
      }),
      [new RegExp(`${summaryId}|${method}|failure|trigger|edge condition|expected behaviour|field`, "iu")],
    );
  });
}

test("AC-ENG-007: a canonical actionable row with a missing field is rejected", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: { [engineeringReviewHeadings[0]!]: [canonicalMissingEvidenceLensRow] },
        summaryRows: [
          "| ENG-REV-703 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-703-resolution.md |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "ENG-REV-703 has no Evidence cell.",
    }),
    [/ENG-REV-703|Evidence|field|canonical|engineering-review/iu],
  );
});

test("AC-ENG-007: a canonical open blocker is rejected", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: { [engineeringReviewHeadings[0]!]: [canonicalOpenLensRow] },
        summaryRows: [
          "| ENG-REV-702 | Behaviour preservation | high | open | pending |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "ENG-REV-702 remains open.",
    }),
    [/ENG-REV-702|open|block|resolved|engineering-review/iu],
  );
});

for (const [label, rows] of [
  ["a second critical open row", [canonicalResolvedLensRow, "| ENG-REV-704 | critical | platform/apps/api/checks/engineering-evidence-validator.check.ts :: second row | A data-loss regression remains. | Fix before approval; Owner: Human reviewer Mei Chen | open; Resolution: pending |"]],
  ["a second row missing evidence", [canonicalResolvedLensRow, "| ENG-REV-705 | medium |  | A second row lacks evidence. | Supply evidence; Owner: Human reviewer Mei Chen | resolved; Resolution: docs/engineering-review/ENG-REV-705-resolution.md |"]],
] as const) {
  test(`AC-ENG-007: a canonical lens rejects ${label} after a resolved first row`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withCanonicalReview({
          lensRows: { [engineeringReviewHeadings[0]!]: rows },
          summaryRows: [
            "| ENG-REV-701 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-701-resolution.md |",
            label.includes("critical")
              ? "| ENG-REV-704 | Behaviour preservation | critical | open | pending |"
              : "| ENG-REV-705 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-705-resolution.md |",
          ],
        }),
        acceptanceCriteria,
        reviewComment: `The second canonical row has ${label}.`,
      }),
      [/ENG-REV-704|ENG-REV-705|critical|open|Evidence|field|engineering-review/iu],
    );
  });
}

test("AC-ENG-007: a non-security lens cannot mix none found with an actionable row", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: {
          [engineeringReviewHeadings[0]!]: [canonicalNoneLensRow, canonicalResolvedLensRow],
        },
        summaryRows: [
          "| ENG-REV-701 | Behaviour preservation | medium | resolved | docs/engineering-review/ENG-REV-701-resolution.md |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "The lens contradicts none found with an actionable row.",
    }),
    [/none found|ENG-REV-701|contradict|engineering-review/iu],
  );
});

test("AC-ENG-007: a none-found first row cannot hide a malformed second finding ID", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: {
          [engineeringReviewHeadings[0]!]: [
            canonicalNoneLensRow,
            "| ENG-REV-X | critical | src/auth.ts | A data-loss path remains open. | no owner | open |",
          ],
        },
      }),
      acceptanceCriteria,
      reviewComment: "The malformed second row follows a none-found row.",
    }),
    [/none found|ENG-REV-X|Finding ID|critical|open|engineering-review/iu],
  );
});

test("AC-ENG-007/012: Security surface rejects an open second canonical row", () => {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: {
          [securityHeading]: [
            "| ENG-REV-710 | medium | docs/security/ENG-REV-710-evidence.md | A remediated boundary risk. | Remediation accepted; Human owner: Mei Chen | resolved; Human decision: docs/security/ENG-REV-710-decision.md |",
            "| ENG-REV-711 | high | docs/security/ENG-REV-711-evidence.md | Credential exposure remains. | Fix before approval; Human owner: Mei Chen | open; Resolution: pending |",
          ],
        },
        summaryRows: [
          "| ENG-REV-710 | Security surface | medium | resolved | docs/security/ENG-REV-710-decision.md |",
          "| ENG-REV-711 | Security surface | high | open | pending |",
        ],
      }),
      acceptanceCriteria,
      reviewComment: "ENG-REV-711 is the open second security row.",
    }),
    [/ENG-REV-711|Security|high|open|human/iu],
  );
});

test("AC-ENG-007/012: Security surface cannot hide an open finding behind a none-found ID", () => {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withCanonicalReview({
        lensRows: {
          [securityHeading]: [
            "| none found | critical | src/auth.ts | credential exposure remains open | no owner | open |",
          ],
        },
      }),
      acceptanceCriteria,
      reviewComment: "The none-found ID contradicts critical open security cells.",
    }),
    [/none found|Security|critical|open|contradict/iu],
  );
});

for (const [severity, terminalState, findingId] of [
  ["HIGH", "Resolved", "ENG-REV-901"],
  ["CRITICAL", "Closed", "ENG-REV-902"],
] as const) {
  test(`AC-ENG-007/012: ${severity} security finding passes only with ${terminalState}, human decision, and durable reference`, () => {
    const artifacts = withSecurityFinding([
      `ID: ${findingId}`,
      `Severity: ${severity}`,
      `Finding: ${severity} credential exposure was remediated.`,
      `Evidence: docs/security/reviews/${findingId}-evidence.md`,
      "Impact: credentials could have crossed the approved trust boundary.",
      "Action: rotate the credential and add the independent boundary regression.",
      "Owner: Human security reviewer Mei Chen",
      `Status: ${terminalState}`,
      `Resolution: remediated and independently verified in docs/security/reviews/${findingId}-resolution.md`,
      "Human decision owner: Mei Chen, Security Lead; remediation closure accepted.",
      `Human decision reference: docs/security/reviews/${findingId}-decision.md`,
    ].join("\n"));
    assert.deepEqual(validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: `Human Security Lead closed the ${severity} finding with durable review evidence.`,
    }), { verificationTier: "A" });
  });
}

for (const [label, finding] of [
  [
    "resolved without a human decision",
    [
      "ID: ENG-REV-911",
      "Severity: HIGH",
      "Finding: HIGH credential exposure was remediated.",
      "Evidence: docs/security/reviews/ENG-REV-911-evidence.md",
      "Impact: credentials could have crossed the approved trust boundary.",
      "Action: rotate the credential and add the independent boundary regression.",
      "Owner: Human security reviewer Mei Chen",
      "Status: Resolved",
      "Resolution: remediated and independently verified in docs/security/reviews/ENG-REV-911-resolution.md",
    ].join("\n"),
  ],
  [
    "resolved without a durable decision reference",
    [
      "ID: ENG-REV-912",
      "Severity: HIGH",
      "Finding: HIGH credential exposure was remediated.",
      "Evidence: docs/security/reviews/ENG-REV-912-evidence.md",
      "Impact: credentials could have crossed the approved trust boundary.",
      "Action: rotate the credential and add the independent boundary regression.",
      "Owner: Human security reviewer Mei Chen",
      "Status: Resolved",
      "Resolution: remediated and independently verified in docs/security/reviews/ENG-REV-912-resolution.md",
      "Human decision owner: Mei Chen, Security Lead; remediation closure accepted.",
    ].join("\n"),
  ],
  [
    "not resolved despite human metadata",
    [
      "ID: ENG-REV-913",
      "Severity: HIGH",
      "Finding: HIGH credential exposure still exists.",
      "Evidence: docs/security/reviews/ENG-REV-913-evidence.md",
      "Impact: credentials can still cross the approved trust boundary.",
      "Action: rotate the credential before approval.",
      "Owner: Human security reviewer Mei Chen",
      "Status: Not resolved",
      "Resolution: remediation is not complete.",
      "Human decision owner: Mei Chen, Security Lead; remediation remains required.",
      "Human decision reference: docs/security/reviews/ENG-REV-913-decision.md",
    ].join("\n"),
  ],
  [
    "none-found prefix followed by an open high finding",
    [
      "ID: ENG-REV-914",
      "Severity: HIGH",
      "Finding: none found; however HIGH credential exposure remains open.",
      "Evidence: docs/security/reviews/ENG-REV-914-evidence.md",
      "Impact: credentials can still cross the approved trust boundary.",
      "Action: rotate the credential before approval.",
      "Owner: Human security reviewer Mei Chen",
      "Status: Open",
      "Resolution: the high finding remains open.",
      "Human decision owner: Mei Chen, Security Lead; closure was not accepted.",
      "Human decision reference: docs/security/reviews/ENG-REV-914-decision.md",
    ].join("\n"),
  ],
] as const) {
  test(`AC-ENG-007/012: security finding is rejected when ${label}`, () => {
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withSecurityFinding(finding),
        acceptanceCriteria,
        reviewComment: `Security evidence is ${label}.`,
      }),
      [/security|HIGH|resolved|closed|human|reference|open/iu],
    );
  });
}

test("AC-ENG-007/012: a none-found prefix cannot hide an open MEDIUM security finding", () => {
  const artifacts = withSecurityFinding([
    "ID: ENG-REV-915",
    "Severity: MEDIUM",
    "Finding: none found; however MEDIUM credential exposure remains open.",
    "Evidence: docs/security/reviews/ENG-REV-915-evidence.md",
    "Impact: credentials can still cross the approved trust boundary.",
    "Action: rotate the credential before approval.",
    "Owner: Human security reviewer Mei Chen",
    "Status: Open",
    "Resolution: the medium finding remains open.",
    "Human decision owner: Mei Chen, Security Lead; closure was not accepted.",
    "Human decision reference: docs/security/reviews/ENG-REV-915-decision.md",
  ].join("\n"));
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "A MEDIUM security finding remains open despite the none-found prefix.",
    }),
    [/Security|MEDIUM|open|resolved|closed/iu],
  );
});

test("AC-ENG-007/012: seven lenses, adversarial pass, and human-owned security decisions are mandatory", () => {
  const firstHeading = engineeringReviewHeadings[0]!;
  const withoutLens = replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => content.replace(
      new RegExp(`## ${escapeRegExp(firstHeading)}\\n\\n[^#]+`, "u"),
      "",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withoutLens,
      acceptanceCriteria,
      reviewComment: "A required review lens was omitted.",
    }),
    [new RegExp(escapeRegExp(firstHeading), "iu")],
  );

  const withoutAdversarial = replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => content.replace(/## Adversarial pass[\s\S]*?## Security-sensitive decisions/u, "## Security-sensitive decisions"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withoutAdversarial,
      acceptanceCriteria,
      reviewComment: "No adversarial review was supplied.",
    }),
    [/adversarial/iu],
  );

  for (const missingPass of ["Pre-mortem", "Edge-case-hunter"] as const) {
    const withoutOnePass = replaceArtifact(
      validPack("A"),
      "engineering-review",
      (content) => content.replace(
        new RegExp(`### ${escapeRegExp(missingPass)}[\\s\\S]*?(?=### |## Security-sensitive decisions)`, "u"),
        "",
      ),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts: withoutOnePass,
        acceptanceCriteria,
        reviewComment: `${missingPass} was omitted.`,
      }),
      [new RegExp(escapeRegExp(missingPass), "iu")],
    );
  }

  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading))!;
  const selfApprovedSecurity = replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => content.replace(
      `## ${securityHeading}\n\nFinding: none found`,
      `## ${securityHeading}\n\nFinding: high severity credential exposure; the Software Engineer accepted the risk.`,
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: selfApprovedSecurity,
      acceptanceCriteria,
      reviewComment: "The engineer accepted the security risk.",
    }),
    [/security|risk acceptance|human/iu],
  );

  const criticalOpenFinding = replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => content.replace(
      `## ${firstHeading}\n\nFinding: none found`,
      `## ${firstHeading}\n\nFinding: CRITICAL data-loss path remains open; Status: Open; Owner: Software Engineer.`,
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: criticalOpenFinding,
      acceptanceCriteria,
      reviewComment: "A critical finding is still open.",
    }),
    [/critical|open|engineering-review/iu],
  );
});

test("AC-ENG-011: REMOVED: None is valid only with a concrete REMOVED audit", () => {
  const withoutAudit = replaceArtifact(
    validPack("A"),
    "implementation-plan",
    (content) => content.replace(/## REMOVED audit[\s\S]*?## Risk note/u, "## Risk note"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withoutAudit,
      acceptanceCriteria,
      reviewComment: "The removal audit is absent.",
    }),
    [/REMOVED audit/u],
  );
});

test("AC-ENG-007: lowercase tbd remains an unresolved placeholder", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content.replace("Review: engineering-review.md", "Review: tbd"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The provenance review reference is unresolved lowercase tbd.",
    }),
    [/engineering-provenance|placeholder|unresolved|tbd/iu],
  );
});

test("AC-ENG-007: an inline-code mustache TODO remains an unresolved placeholder", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "implementation-plan",
    (content) => content.replace(
      "Legacy definitions could fail approval unless the loader injects compatible paths.",
      "Legacy compatibility evidence: `{{TODO}}`",
    ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "Inline code formatting cannot suppress a TODO placeholder.",
    }),
    [/implementation-plan|placeholder|unresolved|TODO/iu],
  );
});

test("AC-ENG-012: honest release-approval negation does not create a false authority claim", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => `${content}\nSoftware Engineer did not approve release.\n`,
  );
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts,
    acceptanceCriteria,
    reviewComment: "The provenance truthfully records that release approval was not performed.",
  }), { verificationTier: "A" });
});

test("AC-ENG-012: Markdown-bold publication boundaries preserve the explicit No disposition", () => {
  assert.deepEqual(validateEngineeringEvidencePack({
    artifacts: withMarkdownBoldPublicationBoundary("No"),
    acceptanceCriteria,
    reviewComment: "Bold canonical labels still state that publication and release actions were not performed.",
  }), { verificationTier: "A" });
});

test("AC-ENG-012: Markdown-bold publication boundaries still reject an explicit Yes", () => {
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: withMarkdownBoldPublicationBoundary("Yes"),
      acceptanceCriteria,
      reviewComment: "Bold formatting cannot hide Software Engineer publication authority.",
    }),
    [/provenance|publish|merge|release|human-owned/iu],
  );
});

test("AC-ENG-012: provenance requires the explicit PR creation or opening boundary", () => {
  const artifacts = replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content.replace("PR created or opened by Software Engineer: No\n", ""),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts,
      acceptanceCriteria,
      reviewComment: "The PR creation/opening human boundary is missing.",
    }),
    [/engineering-provenance|PR creation\/opening|Software Engineer/iu],
  );
});

for (const [field, validReference] of [
  ["Spec", "docs/product/change-contract.md"],
  ["Session log", "engineering-session-log.md"],
  ["Tests", "engineering-test-evidence.md"],
  ["Review", "engineering-review.md"],
] as const) {
  test(`AC-ENG-007/012: provenance ${field} rejects a bare engineering- pseudo-reference`, () => {
    const artifacts = replaceArtifact(
      validPack("A"),
      "engineering-provenance",
      (content) => content.replace(`${field}: ${validReference}`, `${field}: engineering-`),
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: `${field} must identify its corresponding durable artifact, path, or URL.`,
      }),
      [new RegExp(`${escapeRegExp(field)}|provenance|reference|artifact|path|URL`, "iu")],
    );
  });
}

test("AC-ENG-007/012: provenance must be complete and cannot claim merge or release authority", () => {
  const placeholderCommit = replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content.replace("Review: engineering-review.md", "Review: TBD"),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: placeholderCommit,
      acceptanceCriteria,
      reviewComment: "The head commit is unresolved.",
    }),
    [/engineering-provenance|Review|placeholder|TBD|unresolved/iu],
  );

  const unauthorizedDecision = replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content
      .replace(
        [
          "PR published by Software Engineer: No",
          "Merge decision: Human-owned; not performed.",
          "Release decision: Human-owned; not performed.",
        ].join("\n"),
        [
          "PR published by Software Engineer: Yes",
          "Merge decision: Approved by Software Engineer.",
          "Release decision: Approved by Software Engineer.",
        ].join("\n"),
      ),
  );
  assertGateFailure(
    () => validateEngineeringEvidencePack({
      artifacts: unauthorizedDecision,
      acceptanceCriteria,
      reviewComment: "The engineer claims decision authority.",
    }),
    [/merge|release|human-owned/iu],
  );
});

for (const contradictoryPublication of [
  "PR created or opened by Software Engineer: Yes",
  "PR published by Software Engineer: Yes",
  "Merge/deploy/release performed by Software Engineer: Yes",
  "Merge performed by Software Engineer: Yes",
  "Deploy performed by Software Engineer: Yes",
  "Release performed by Software Engineer: Yes",
  "The Software Engineer merged and released the change.",
] as const) {
  test(`AC-ENG-012: retained No provenance cannot be contradicted by "${contradictoryPublication}"`, () => {
    const artifacts = replaceArtifact(
      validPack("A"),
      "engineering-provenance",
      (content) => `${content}\n${contradictoryPublication}\n`,
    );
    assertGateFailure(
      () => validateEngineeringEvidencePack({
        artifacts,
        acceptanceCriteria,
        reviewComment: "The provenance contains contradictory publication claims.",
      }),
      [/provenance|publish|merge|deploy|release|Software Engineer/iu],
    );
  });
}

function validPack(tier: "A" | "B" | "C" | "Limited") {
  return [
    {
      artifactKey: "implementation-notes",
      content: [
        "# Implementation index",
        "",
        "## Status",
        "Ready for verification",
        "",
        "## Evidence index",
        "- implementation-plan: implementation-plan.md",
        "- implementation-tasks: implementation-tasks.md",
        "- engineering-session-log: engineering-session-log.md",
        "- engineering-test-evidence: engineering-test-evidence.md",
        "- engineering-review: engineering-review.md",
        "- engineering-provenance: engineering-provenance.md",
        "",
        "## Contract and active clearances",
        "Change Contract CC-AC-001 and CC-AC-002; Product, Design, and Architecture are cleared.",
        "",
        "## Implemented scope",
        "Implemented the registered evidence validation boundary in confirmed scope.",
        "",
        "## Changes",
        "Added seven registered outputs and the approval validator.",
        "",
        "## Impact-check deviations",
        "No deviations from Product, Design, or Architecture clearance were introduced.",
        "",
        "## Verification, regression, and risks",
        "Independent checks passed; the six-phase workflow remains the regression boundary.",
        "",
        "## Handoff",
        "Tester receives the index, independent-test evidence, and engineering review.",
      ].join("\n"),
    },
    {
      artifactKey: "implementation-plan",
      content: [
        "# Implementation plan",
        "",
        "## Change classification",
        "Brownfield change to an existing six-phase workflow.",
        "",
        "## Preserved behaviour",
        "Keep the fixed six-phase order, artifact ownership, and human approval boundary.",
        "",
        "## ADDED",
        "Add the evidence validation gate.",
        "",
        "## MODIFIED",
        "Extend the implementation phase with task-scoped evidence outputs.",
        "",
        "## REMOVED",
        "None",
        "",
        "## REMOVED audit",
        "Compared the registered artifacts and six phases; no phase, role, artifact, or gate is deleted.",
        "",
        "## Risk note",
        "Legacy definitions could fail approval unless the loader injects compatible paths.",
        "",
        "## Acceptance coverage plan",
        "CC-AC-001 and CC-AC-002 are assigned to implementation and verification tasks.",
      ].join("\n"),
    },
    {
      artifactKey: "implementation-tasks",
      content: [
        "# Implementation tasks",
        "",
        "## Task ledger",
        "- [x] ENG-TASK-001 — load the role policy, config, and workflow while preserving human decisions.",
        "- [x] ENG-TASK-002 — scaffold exactly one native Agent and the complete role pack.",
        "",
        "## Acceptance coverage",
        "- CC-AC-001 — ENG-TASK-001 and independent role-pack check.",
        "- CC-AC-002 — ENG-TASK-002 and independent scaffold check.",
      ].join("\n"),
    },
    {
      artifactKey: "engineering-session-log",
      content: [
        "# Engineering session log",
        "",
        "## Task contract",
        "Implement CC-AC-001 and CC-AC-002 without changing phase ownership.",
        "",
        "## Context loaded",
        "Loaded the approved delta and repository testing conventions.",
        "",
        "## Ordered action log",
        "2026-08-19T09:00:00Z — implemented the registered evidence boundary.",
        "",
        "## Change inventory",
        "Added the evidence validator and repository-conventional checks.",
        "",
        "## Rejected alternatives",
        "Rejected duplicating the Software Engineer as a client-specific Skill.",
        "",
        "## Verification gates",
        "- Command: npm test",
        "- Result: passed with exit code 0.",
        "",
        "## Outcome",
        "The evidence pack is ready for independent verification.",
      ].join("\n"),
    },
    {
      artifactKey: "engineering-test-evidence",
      content: canonicalTableTestEvidence({ tier }),
    },
    {
      artifactKey: "engineering-review",
      content: engineeringReview(),
    },
    {
      artifactKey: "engineering-provenance",
      content: [
        "# PR provenance",
        "",
        "## Tool/model",
        "Codex gpt-5.6-sol with high reasoning.",
        "",
        "## Context loaded",
        "Approved delta, AGENTS.md, and testing conventions.",
        "",
        "## Verification gates",
        "npm test; yarn typecheck; yarn test; yarn build all exited 0.",
        "",
        "## Human decisions",
        "Human review remains required; the engineer made no architecture, scope, security, merge, or release decision.",
        "",
        "## Known limitations",
        "No known verification limitation remains.",
        "",
        "## Session duration",
        "42 minutes.",
        "",
        "## SDD approach",
        "Delta-driven smallest complete vertical slice with frozen independent tests.",
        "",
        "## Evidence links",
        "Spec: docs/product/change-contract.md",
        "Session log: engineering-session-log.md",
        "Tests: engineering-test-evidence.md",
        "Review: engineering-review.md",
        "Repository: create-ai-native-sdlc",
        "Branch: feature/evidence-gate",
        "Base commit: 1111111111111111111111111111111111111111",
        "Head commit: 2222222222222222222222222222222222222222",
        "Pull request: https://github.example/create-ai-native-sdlc/pull/42",
        "",
        "## Publication boundary",
        "PR created or opened by Software Engineer: No",
        "PR published by Software Engineer: No",
        "Merge decision: Human-owned; not performed.",
        "Release decision: Human-owned; not performed.",
      ].join("\n"),
    },
  ] as ReadonlyArray<{ artifactKey: string; content: string }>;
}

function engineeringReview(): string {
  return [
    "# Seven-lens engineering review",
    "",
    ...engineeringReviewHeadings.flatMap((heading) => [
      `## ${heading}`,
      "",
      "Finding: none found",
      "",
    ]),
    "## Adversarial pass",
    "",
    "### Pre-mortem",
    "",
    "Finding: none found",
    "",
    "### Edge-case-hunter",
    "",
    "Finding: none found",
    "",
    "## Security-sensitive decisions",
    "",
    "No security-sensitive decision was made; risk acceptance remains human-owned.",
  ].join("\n");
}

function replaceArtifact(
  artifacts: ReadonlyArray<{ artifactKey: string; content: string }>,
  artifactKey: string,
  replace: (content: string) => string,
) {
  return artifacts.map((artifact) => artifact.artifactKey === artifactKey
    ? { ...artifact, content: replace(artifact.content) }
    : artifact);
}

function withMarkdownBoldPublicationBoundary(disposition: "No" | "Yes") {
  return replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content.replace(
      [
        "PR created or opened by Software Engineer: No",
        "PR published by Software Engineer: No",
        "Merge decision: Human-owned; not performed.",
        "Release decision: Human-owned; not performed.",
      ].join("\n"),
      [
        `**PR created or opened by Software Engineer:** ${disposition}`,
        `**PR published by Software Engineer:** ${disposition}`,
        `**Merge/deploy/release performed by Software Engineer:** ${disposition}`,
      ].join("\n"),
    ),
  );
}

function addTopLevelState(content: string, state: "Failed" | "Blocked"): string {
  return content.replace("\n", `\n\nState: ${state}`);
}

function replaceCanonicalCoverageResult(
  content: string,
  traceId: string,
  result: string,
): string {
  return content.split("\n").map((line) => line.startsWith(`| ${traceId} |`)
    ? line.replace(/\| [^|]* \|$/u, `| ${result} |`)
    : line).join("\n");
}

function replaceCanonicalCommandResult(
  content: string,
  command: "npm test" | "yarn test",
  result: string,
): string {
  return content.split("\n").map((line) => line.includes(`| \`${command}\` |`)
    ? line.replace("| exit code 0; Pass |", `| ${result} |`)
    : line).join("\n");
}

function replaceCanonicalIsolationField(
  content: string,
  field: string,
  evidence: string,
): string {
  return content.split("\n").map((line) => line.startsWith(`| ${field} |`)
    ? `| ${field} | ${evidence} |`
    : line).join("\n");
}

function withCanonicalReview(options: {
  lensRows?: Readonly<Record<string, readonly string[]>>;
  preMortemRows?: readonly string[];
  edgeCaseRows?: readonly string[];
  summaryRows?: readonly string[];
} = {}) {
  return replaceArtifact(
    validPack("A"),
    "engineering-review",
    () => canonicalTableReview(options),
  );
}

function canonicalTableReview(options: {
  lensRows?: Readonly<Record<string, readonly string[]>>;
  preMortemRows?: readonly string[];
  edgeCaseRows?: readonly string[];
  summaryRows?: readonly string[];
} = {}): string {
  const lensSections = engineeringReviewHeadings.flatMap((heading) => [
    `## ${heading}`,
    "",
    "| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |",
    "|---|---|---|---|---|---|",
    ...(options.lensRows?.[heading] ?? [canonicalNoneLensRow]),
    "",
    ...(/security/iu.test(heading) ? [
      "Any security-class finding is blocking until remediation evidence and the human-owned decision are recorded. The Agent does not accept security risk.",
      "",
    ] : []),
  ]);
  return [
    "# Engineering Review: Canonical table compatibility",
    "",
    "## Verdict",
    "",
    "**State:** Pass",
    "**Run:** 550e8400-e29b-41d4-a716-446655440000",
    `**Implementation revision:** ${"2".repeat(40)}`,
    "**Reviewer/session:** Human reviewer Mei Chen; review-session-2026-08-19-001",
    "**Relationship to implementation author:** independent",
    "**Blocking finding IDs:** None",
    "",
    ...lensSections,
    "## Adversarial pass",
    "",
    "### Pre-mortem",
    "",
    "| Finding ID | Severity | Plausible failure and trigger | Evidence / detection | Impact | Required action / owner | Status / resolution evidence |",
    "|---|---|---|---|---|---|---|",
    ...(options.preMortemRows ?? [
      "| none found | N/A | N/A | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |",
    ]),
    "",
    "### Edge-case-hunter",
    "",
    "| Finding ID | Severity | Edge condition and expected behaviour | Evidence / result | Impact | Required action / owner | Status / resolution evidence |",
    "|---|---|---|---|---|---|---|",
    ...(options.edgeCaseRows ?? [
      "| none found | N/A | N/A | platform/apps/api/checks/engineering-evidence-validator.check.ts | N/A | N/A | not-applicable |",
    ]),
    "",
    "## Finding summary",
    "",
    "| Finding ID | Lens / method | Severity | Final status | Resolution or human decision reference |",
    "|---|---|---|---|---|",
    ...(options.summaryRows ?? ["| None | All lenses and methods | N/A | not-applicable | N/A |"]),
    "",
    "The review recommends readiness but does not publish or approve a PR, merge, deploy, accept material risk, change scope, or approve an architecture/security exception.",
  ].join("\n");
}

type CanonicalTestEvidenceOptions = {
  tier: "A" | "B" | "C" | "Limited";
  omitIsolationField?: string;
  implementationVisible?: string;
  testAuthoringSession?: string;
  testPathAndName?: string;
  resultEvidence?: string;
  acceptanceGate?: string;
  projectCheckGate?: string;
  readyForReview?: string;
};

function withCanonicalTestEvidence(options: CanonicalTestEvidenceOptions) {
  return replaceArtifact(
    validPack(options.tier),
    "engineering-test-evidence",
    () => canonicalTableTestEvidence(options),
  );
}

function canonicalTableTestEvidence(options: CanonicalTestEvidenceOptions): string {
  const testPathAndName = options.testPathAndName
    ?? "platform/apps/api/checks/engineering-evidence-validator.check.ts :: canonical coverage row";
  const resultEvidence = options.resultEvidence
    ?? "artifacts/test-results/engineering-evidence-validator.tap";
  const isolationRows = [
    ["Tier", options.tier],
    [
      "Test-authoring model/session",
      options.testAuthoringSession ?? "Independent human test author Mei Chen; session QA-2026-08-19-001",
    ],
    [
      "Requirements visible while authoring",
      "docs/product/change-contract.md#acceptance-criteria",
    ],
    [
      "Implementation visible while authoring",
      options.implementationVisible ?? (["A", "B"].includes(options.tier)
        ? "No"
        : "Yes; exact source and diff exposure recorded after frozen intent"),
    ],
    ["Test intent frozen at", "docs/testing/frozen-test-intent.md#revision-1"],
    ["Later implementation access", "None"],
    ["Human waiver", "None"],
  ].filter(([field]) => field !== options.omitIsolationField);
  return [
    "# Engineering Test Evidence: Canonical table compatibility",
    "",
    "## Status",
    "",
    "**State:** Pass",
    "**Run:** 550e8400-e29b-41d4-a716-446655440000",
    `**Implementation revision:** ${"2".repeat(40)}`,
    "**Updated:** 2026-08-19",
    "",
    "## Isolation",
    "",
    "| Field | Evidence |",
    "|---|---|",
    ...isolationRows.map(([field, evidence]) => `| ${field} | ${evidence} |`),
    "",
    "## Acceptance coverage",
    "",
    "| Trace ID | Source ID / position | Observable criterion or regression | Test path and test ID/name | Evidence | Result |",
    "|---|---|---|---|---|---|",
    `| CC-AC-001 | Change Contract criterion 1 | Canonical role workflow is loaded. | ${testPathAndName} | ${resultEvidence} | Pass |`,
    `| CC-AC-002 | Change Contract criterion 2 | Complete role pack is initialized. | ${testPathAndName} | ${resultEvidence} | Pass |`,
    "",
    "## Test changes",
    "",
    "| Test path | Added / Modified / Removed | Trace IDs | Independent intent | Reason |",
    "|---|---|---|---|---|",
    "| platform/apps/api/checks/engineering-evidence-validator.check.ts | Added | CC-AC-001, CC-AC-002 | challenge canonical evidence parsing | freeze the public template contract |",
    "",
    "## Commands and results",
    "",
    "| Sequence | Working directory | Exact command | Check type | Exit/result | Evidence / notes |",
    "|---|---|---|---|---|---|",
    "| 1 | repository root | `npm test` | focused | exit code 0; Pass | artifacts/test-results/root-test.tap |",
    "| 2 | platform | `yarn test` | regression | exit code 0; Pass | artifacts/test-results/platform-test.tap |",
    "",
    "| Check | Reason not run | Owner | Release / verification impact | Status |",
    "|---|---|---|---|---|",
    "| None | N/A | N/A | N/A | not-applicable |",
    "",
    "## Failure classification",
    "",
    "| Failure ID | Failing test/check | Classification | Contract evidence | Action and owner | Retest evidence |",
    "|---|---|---|---|---|---|",
    "| None | N/A | N/A | N/A | N/A | N/A |",
    "",
    "## Coverage gaps",
    "",
    "- None",
    "",
    "## Conclusion",
    "",
    "- **Isolation gate:** Pass; Tier metadata is complete.",
    `- **Acceptance gate:** ${options.acceptanceGate ?? "Pass; CC-AC-001 and CC-AC-002 are covered."}`,
    "- **Regression gate:** Pass; repository regression checks passed.",
    `- **Project-check gate:** ${options.projectCheckGate ?? "Pass; all required checks exited 0."}`,
    `- **Ready for review:** ${options.readyForReview ?? "Yes"}`,
  ].join("\n");
}

function withCanonicalSessionGates(
  projectChecksResult: "Pass" | "Blocked",
  blockerOrWaiver: string,
) {
  const table = [
    "## Verification gates",
    "",
    "| Gate | Evidence | Result | Blocker / waiver |",
    "|---|---|---|---|",
    "| Upstream clearances current | artifact:change-contract@rev-1 | Pass | None |",
    `| Real implementation present | platform/apps/api/checks/engineering-evidence-validator.check.ts; diff:${"2".repeat(40)} | Pass | None |`,
    "| Independent tests | artifact:engineering-test-evidence@rev-1 | Pass | Tier A |",
    `| Project checks | artifacts/test-results/platform-test.tap | ${projectChecksResult} | ${blockerOrWaiver} |`,
    "| Seven-lens review | artifact:engineering-review@rev-1 | Pass | None |",
    "| Provenance complete | artifact:engineering-provenance@rev-1 | Pass | None |",
    "",
    "## Outcome",
  ].join("\n");
  return replaceArtifact(
    validPack("A"),
    "engineering-session-log",
    (content) => content
      .replace("\n", "\n\n## Status\n\n**State:** Complete")
      .replace(/## Verification gates[\s\S]*?## Outcome/u, table),
  );
}

function withTesterDeferredSessionGate(result: string, blockerOrWaiver: string) {
  return replaceArtifact(
    withCanonicalSessionGates("Pass", "None"),
    "engineering-session-log",
    (content) => content.replace(
      "| Provenance complete | artifact:engineering-provenance@rev-1 | Pass | None |",
      [
        "| Provenance complete | artifact:engineering-provenance@rev-1 | Pass | None |",
        `| B-04 browser/accessibility validation | artifact:design-spec@rev-1 | ${result} | ${blockerOrWaiver} |`,
      ].join("\n"),
    ),
  );
}

function withCanonicalProvenanceGates(
  projectChecksResult: "Blocked" | "Failed" | "Pending" | "Untested" | "Skipped",
) {
  const table = [
    "## Verification gates",
    "",
    "| Gate | Evidence | Result |",
    "|---|---|---|",
    "| Acceptance and regression coverage | artifact:engineering-test-evidence@rev-1 | Pass |",
    "| Isolation | Tier A; docs/testing/frozen-test-intent.md | Pass |",
    `| Project checks | artifacts/test-results/platform-test.tap | ${projectChecksResult} |`,
    "| Seven-lens plus adversarial review | artifact:engineering-review@rev-1 | Pass |",
    "",
    "## Human decisions",
  ].join("\n");
  return replaceArtifact(
    validPack("A"),
    "engineering-provenance",
    (content) => content
      .replace("\n", "\n\n## Status\n\n**State:** Complete")
      .replace(/## Verification gates[\s\S]*?## Human decisions/u, table),
  );
}

function withReviewSectionFinding(
  heading: string,
  headingLevel: number,
  finding: string,
) {
  const headingMarker = `${"#".repeat(headingLevel)} ${heading}\n\nFinding: none found`;
  return replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => {
      assert.ok(content.includes(headingMarker), `${heading} fixture block must exist`);
      return content.replace(
        headingMarker,
        `${"#".repeat(headingLevel)} ${heading}\n\n${finding}`,
      );
    },
  );
}

function withSecurityFinding(finding: string) {
  const securityHeading = engineeringReviewHeadings.find((heading) => /security/iu.test(heading));
  assert.ok(securityHeading, "security review heading must exist");
  return replaceArtifact(
    validPack("A"),
    "engineering-review",
    (content) => content.replace(
      `## ${securityHeading}\n\nFinding: none found`,
      `## ${securityHeading}\n\n${finding}`,
    ),
  );
}

function moveAdversarialPassUnderSecurity(
  content: string,
  passName: "Pre-mortem" | "Edge-case-hunter",
): string {
  const passPattern = new RegExp(
    `### ${escapeRegExp(passName)}\\n\\n(Finding:[^\\n]+)\\n\\n`,
    "u",
  );
  const match = content.match(passPattern);
  assert.ok(match?.[1], `${passName} fixture block must exist`);
  return content
    .replace(passPattern, "")
    .replace(
      "## Security-sensitive decisions\n\n",
      `## Security-sensitive decisions\n\n### ${passName}\n\n${match[1]}\n\n`,
    );
}

function verificationExceptionComment(
  tier: "C" | "Limited",
  options: {
    omit?: (typeof verificationExceptionFields)[number];
    owner?: string;
  } = {},
): string {
  const fields: ReadonlyArray<[
    (typeof verificationExceptionFields)[number],
    string,
  ]> = [
    ["owner", `Verification exception owner: ${options.owner ?? "Human QA lead Mei Chen"}`],
    ["reference", "Verification exception reference: review-2026-08-19-001"],
    ["scope", "Verification exception scope: CC-AC-001, CC-AC-002 — engineering evidence validator"],
    ["compensating evidence", "Verification exception compensating evidence: docs/evidence/ci-run-2026-08-19.log"],
    ["residual risk", "Verification exception residual risk: Human owner accepts the temporary absence of Tier A/B isolation evidence"],
    ["revisit", "Verification exception revisit: Expires 2026-08-26 or immediately when CI access returns"],
  ];
  return [
    "Human review notes:",
    `Verification gate exception: Tier ${tier} - Tier A/B isolation is unavailable because CI credentials are temporarily inaccessible`,
    ...fields.filter(([field]) => field !== options.omit).map(([, line]) => line),
  ].join("\n");
}

function assertGateFailure(run: () => unknown, issuePatterns: readonly RegExp[]): void {
  assert.throws(run, (error: unknown) => {
    const appError = error as {
      statusCode?: number;
      code?: string;
      details?: { issues?: unknown };
    };
    assert.equal(appError.statusCode, 409);
    assert.equal(appError.code, "ENGINEERING_EVIDENCE_GATE_FAILED");
    assert.ok(Array.isArray(appError.details?.issues));
    const issues = (appError.details?.issues as unknown[]).map(String);
    assert.ok(issues.length > 0);
    for (const pattern of issuePatterns) {
      assert.ok(
        issues.some((issue) => pattern.test(issue)),
        `expected one aggregated issue to match ${pattern}; got ${JSON.stringify(issues)}`,
      );
    }
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
