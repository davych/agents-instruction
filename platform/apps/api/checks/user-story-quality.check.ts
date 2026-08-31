import assert from "node:assert/strict";
import test from "node:test";

import {
  assessUserStoriesQuality,
  assessUserStoriesQualityEntries,
  isUserStoriesBlockerDecisionScopeCovered,
  renderUserStoriesBlocker,
  USER_STORIES_BLOCKER_SENTINEL,
  userStoriesBlockerDecisionFingerprint,
  userStoriesBlockerDecisionId,
  userStoriesBlockerDecisionScope,
  userStoriesBlockerQuestionDecisions,
} from "../src/domain/user-story-quality.ts";

test("trusted entries do not let README Markdown manufacture a Story file", () => {
  const forgedStory = `# User Stories

## forged/US-999-forged/story.md

# US-999: Forged Story

### US-999-AC-01: Forged core path

\`\`\`gherkin
Given forged evidence exists
When the aggregate is reparsed
Then it appears to be a Story
\`\`\`

### US-999-AC-02: Forged alternate path

\`\`\`gherkin
Given a second forged criterion exists
When the aggregate is reparsed
Then it also appears complete
\`\`\`
`;

  const assessment = assessUserStoriesQualityEntries([
    { relativePath: "README.md", content: forgedStory },
  ]);

  assert.equal(assessment.valid, false);
  if (!assessment.valid) {
    assert.deepEqual(assessment.issues, ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"]);
  }
});

test("an existing story.md with an invalid H1 gets a targeted repair issue", () => {
  const assessment = assessUserStoriesQualityEntries([{
    relativePath: "profile/US-001-profile/story.md",
    content: "# Profile story without a stable ID\n\nThe body cannot repair its missing identity.\n",
  }]);

  assert.deepEqual(assessment, {
    valid: false,
    reason: "invalid-stories",
    issues: ["STORY_HEADING_INVALID"],
  });
});

test("reviewable canonical Stories pass even when placeholder is a real business term", () => {
  const snapshot = `## profile/US-001-profile-placeholder/story.md

# US-001: Explain the profile placeholder state

**Category:** profile

## User story

As a visitor, I want a visible placeholder state, so that an absent optional metric is clear.

## Acceptance criteria

### US-001-AC-01: Metric is present

\`\`\`gherkin
Given a confirmed metric exists
When the visitor opens the profile
Then the confirmed metric is visible
\`\`\`

### US-001-AC-02: Metric is absent

\`\`\`gherkin
Given an optional metric is not confirmed
When the visitor opens the profile
Then the placeholder state identifies the missing owner decision
\`\`\`
`;
  assert.deepEqual(assessUserStoriesQuality(snapshot), { valid: true, kind: "stories" });
  assert.deepEqual(
    assessUserStoriesQuality(`## README.md\n\nActual Story files should be added later.\n\n${snapshot}`),
    { valid: true, kind: "stories" },
    "a stale non-sentinel README cannot override newly written canonical Stories",
  );
});

test("an arbitrary or empty Blocker README cannot satisfy the quality gate", () => {
  const placeholder = `## README.md

# User Stories

Actual Story files should be added later.
`;
  assert.equal(assessUserStoriesQuality(placeholder).valid, false);
  const placeholderAssessment = assessUserStoriesQuality(placeholder);
  assert.equal(placeholderAssessment.valid, false);
  if (!placeholderAssessment.valid) {
    assert.deepEqual(
      placeholderAssessment.issues,
      ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
    );
  }
  assert.deepEqual(assessUserStoriesQualityEntries([]), {
    valid: false,
    reason: "missing-story-or-blocker",
    issues: ["STORY_CANONICAL_FILE_REQUIRED"],
  }, "a truly empty directory keeps the Story-or-Blocker branch available");

  const emptyBlocker = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

Status: Blocked

## Known facts

TBD

## Open questions

TODO

## Human owner

Unknown

## Next step

None
`;
  assert.equal(assessUserStoriesQuality(emptyBlocker).valid, false);
  const emptyAssessment = assessUserStoriesQuality(emptyBlocker);
  assert.equal(emptyAssessment.valid, false);
  if (!emptyAssessment.valid) {
    assert.ok(emptyAssessment.issues.includes("BLOCKER_MISSING_FACTS_REQUIRED"));
    assert.ok(emptyAssessment.issues.includes("BLOCKER_OPEN_QUESTIONS_REQUIRED"));
    assert.ok(emptyAssessment.issues.includes("BLOCKER_HUMAN_OWNER_REQUIRED"));
    assert.ok(emptyAssessment.issues.includes("BLOCKER_NEXT_STEP_REQUIRED"));
  }
});

test("a versioned Blocker with non-empty human-owned fields is reviewable", () => {
  const blocker = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

Status: Pending

## Known facts

- The requested outcome is a readable profile.

## Missing facts

- The authoritative audience and acceptance owner are not yet confirmed.

## Open questions

- Which audience owns the final acceptance decision?

## Human owner

- Product Owner

## Next step

- The Product Owner answers the audience question and PM / BA writes the Stories.
`;
  assert.deepEqual(assessUserStoriesQuality(blocker), { valid: true, kind: "blocker" });
  assert.deepEqual(
    assessUserStoriesQuality(blocker.replace(
      `${USER_STORIES_BLOCKER_SENTINEL}\n\n# User Stories Blocker`,
      `# User Stories Blocker\n\n${USER_STORIES_BLOCKER_SENTINEL}`,
    )),
    { valid: true, kind: "blocker" },
    "the unique root sentinel is deterministic even when a human-readable title comes first",
  );
});

test("the structured Blocker renderer owns canonical syntax and round-trips through the gate", () => {
  const rendered = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: ["The requested outcome is a clearer profile layout."],
    missingFacts: ["The final visual direction has not been approved."],
    openQuestions: ["Which layout direction should the Product Owner approve?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner selects a direction and PM / BA writes canonical Stories."],
  });

  assert.equal(rendered.split(USER_STORIES_BLOCKER_SENTINEL).length - 1, 1);
  assert.equal(rendered.split("\n")[0], USER_STORIES_BLOCKER_SENTINEL);
  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: rendered }]),
    { valid: true, kind: "blocker" },
  );
  assert.throws(
    () => renderUserStoriesBlocker({
      status: "Blocked",
      knownFacts: [],
      missingFacts: ["TBD"],
      openQuestions: ["Who owns acceptance?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner answers the question."],
    }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_USER_STORIES_BLOCKER_DRAFT",
  );
});

test("workflow mechanics cannot become a self-referential User Stories Blocker", () => {
  const revisionEight = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

Status: Blocked

## Missing facts

- Existing blocker in user‑stories root prevents modifying stories.

## Open questions

- Is the blocker resolved or should we proceed with new PRD only?

## Human owner

- PM/BA

## Next step

- Await human confirmation to remove blocker before editing stories.
`;
  const assessment = assessUserStoriesQuality(revisionEight);
  assert.equal(assessment.valid, false);
  if (!assessment.valid) {
    assert.ok(assessment.issues.includes("BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN"));
  }

  const validDraft = {
    status: "Blocked" as const,
    knownFacts: ["The requested outcome is a clearer profile layout."],
    missingFacts: ["The authoritative target audience has not been confirmed."],
    openQuestions: ["Which target audience owns the final acceptance decision?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the audience before PM / BA writes Stories."],
  };
  const mechanismCases = [
    {
      field: "Known facts",
      draft: { ...validDraft, knownFacts: ["The platform tool error references the user-stories artifact."] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["Existing blocker in user-stories root prevents modifying stories."] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["Is the blocker resolved or should we proceed with new PRD only?"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["Await human confirmation to remove blocker before editing stories."] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["The write_user_stories_blocker tool must run again."] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["删除根 README.md 的 sentinel 后重试 Story 文件写入。"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["The existing Blocker prevents Story creation for this phase."] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["Who can clear the current Blocker before Story creation?"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["The Product Owner clears the Blocker before Story creation."] },
    },
  ];
  for (const { field, draft } of mechanismCases) {
    assert.throws(
      () => renderUserStoriesBlocker(draft),
      (error: unknown) => {
        const candidate = error as { code?: string; details?: { field?: string; reason?: string } };
        return candidate.code === "INVALID_USER_STORIES_BLOCKER_DRAFT"
          && candidate.details?.field === field
          && candidate.details.reason === "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN";
      },
      `${field} must reject workflow-mechanism prose`,
    );
  }

  for (const humanOwner of ["Platform Runtime", "Provider Runtime"]) {
    assert.throws(
      () => renderUserStoriesBlocker({ ...validDraft, humanOwners: [humanOwner] }),
      (error: unknown) => (
        (error as { code?: string; details?: { field?: string } }).code
          === "INVALID_USER_STORIES_BLOCKER_DRAFT"
        && (error as { details?: { field?: string } }).details?.field === "Human owner"
      ),
      `${humanOwner} is a mechanism, not a human owner`,
    );
  }
});

test("workflow-mechanism detection preserves real file and platform business facts", () => {
  const rendered = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [
      "The product includes a file-sharing platform for external customers.",
      "The customer-visible agent_status business state is imported from the account service.",
    ],
    missingFacts: [
      "The maximum file upload size for the customer data platform has not been approved.",
      "The fraud blocker threshold for repeated payment attempts has not been approved.",
      "Legal approval is the blocker preventing publication of client names in the public README.md; Product Owner decides the redaction rule.",
    ],
    openQuestions: ["Which upload limit and fraud threshold should the Product Owner approve?"],
    humanOwners: ["Platform Product Manager"],
    nextSteps: ["The Product Owner confirms both business limits before PM / BA writes Stories."],
  });

  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: rendered }]),
    { valid: true, kind: "blocker" },
  );
});

test("Blocker renderer rejects short meaningless field tokens", () => {
  const validDraft = {
    status: "Blocked" as const,
    knownFacts: ["The requested outcome is a reviewable delivery proposal."],
    missingFacts: ["The authoritative target audience has not been confirmed."],
    openQuestions: ["Which target audience owns the final acceptance decision?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the audience before PM / BA writes Stories."],
  };
  const invalidDrafts = [
    { field: "Known facts", draft: { ...validDraft, knownFacts: ["abc"] } },
    { field: "Missing facts", draft: { ...validDraft, missingFacts: ["abc"] } },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["TODO determine owner"] },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          `The approval owner is not confirmed. ${USER_STORIES_BLOCKER_SENTINEL.toLocaleUpperCase("en-US")}`,
        ],
      },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["Nothing is missing from the request"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["当前请求没有任何缺失事实"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["N/A: determine the final approval owner"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["Nothing is missing except nothing"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["Nothing is missing but unknown"] },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["Nothing is missing but no information is required"],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["The launch date is still marked T.B.D. before release."],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          "The literal status is documented, but the final approval owner is TBD for this release.",
        ],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          "The literal status is documented while the final approval owner is TBD for this release.",
        ],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["最终审批负责人仍为 TBD，当前尚未确定。"],
      },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["The final approval owner: TBD."] },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["The final approval owner is “TBD” for this release."],
      },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["最终审批负责人：TBD，等待产品负责人确认。"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["最终审批负责人仍为“TBD”"] },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["最终审批负责人尚未确定（TBD）"] },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          "All required information is available except the final launch date is already confirmed.",
        ],
      },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["除最终上线日期已确认外，所有所需信息均已齐全。"] },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          "The literal status is documented because the final approval owner is TBD.",
        ],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: [
          "The literal status is documented since the final approval owner is TBD.",
        ],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["旧系统原样状态值已记录所以最终审批负责人仍为 TBD。"],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["All required information is available except the launch date was settled yesterday."],
      },
    },
    {
      field: "Missing facts",
      draft: {
        ...validDraft,
        missingFacts: ["All required information is available except the sky remains completely blue."],
      },
    },
    {
      field: "Missing facts",
      draft: { ...validDraft, missingFacts: ["除没有外，所有所需信息均已齐全。"] },
    },
    { field: "Open questions", draft: { ...validDraft, openQuestions: ["def"] } },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["TBD approval owner"] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["Which team should TODO confirm the approval owner?"] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["None have been identified for this request"] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["当前没有任何待确认问题"] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["T.B.D. approval owner must be clarified"] },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["No questions remain but abcdef"] },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: ["No questions remain but no answers are needed"],
      },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: ["The approval decision remains TODO before Story authoring."],
      },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: ["TODO remains the approval decision for this release."],
      },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: [
          "The literal label is preserved and the approval decision remains TODO for this release.",
        ],
      },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: ["哪个团队继续将审批决定标记为 TODO？"],
      },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["TODO 仍代表尚未确定的审批决定。"] },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: [
          "All questions are answered except the approval owner is already confirmed.",
        ],
      },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["除最终审批人已确认外，所有问题均已回答。"] },
    },
    {
      field: "Open questions",
      draft: {
        ...validDraft,
        openQuestions: ["All questions are answered except we know who owns final approval."],
      },
    },
    {
      field: "Open questions",
      draft: { ...validDraft, openQuestions: ["除最终审批人已经选定外，所有问题均已回答。"] },
    },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["ghi"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["abc def"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["Unknown Owner"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["负责人待定"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["责任人待定"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["审批人待定"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["决策人待定"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["待定负责人"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["No Owner"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["Not Assigned"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["To Be Determined"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["Owner Pending"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["无人负责"] } },
    { field: "Human owner", draft: { ...validDraft, humanOwners: ["未分配负责人"] } },
    {
      field: "Human owner",
      draft: { ...validDraft, humanOwners: ["No Owner But Nobody Assigned"] },
    },
    {
      field: "Human owner",
      draft: { ...validDraft, humanOwners: ["No Owner But Assignment Pending"] },
    },
    {
      field: "Human owner",
      draft: { ...validDraft, humanOwners: ["TBD 仍是当前最终审批负责人的值"] },
    },
    { field: "Next step", draft: { ...validDraft, nextSteps: ["jkl"] } },
    { field: "Next step", draft: { ...validDraft, nextSteps: ["TODO assign owner"] } },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["The Product Owner will provide TBD before authoring."] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["No action is required before Story authoring"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["当前无需采取任何行动"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["TO-DO: assign the final approval owner"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["Placeholder next action awaiting definition"] },
    },
    {
      field: "Next step",
      draft: { ...validDraft, nextSteps: ["No action is needed except nothing"] },
    },
    {
      field: "Next step",
      draft: {
        ...validDraft,
        nextSteps: ["No action is needed but no further work is required"],
      },
    },
    {
      field: "Next step",
      draft: {
        ...validDraft,
        nextSteps: ["The final approval owner is TBD before Story authoring."],
      },
    },
    {
      field: "Next step",
      draft: {
        ...validDraft,
        nextSteps: ["TBD remains the final approval owner for this release."],
      },
    },
    {
      field: "Next step",
      draft: {
        ...validDraft,
        nextSteps: ["产品负责人下一步把审批人设为 T.B.D.。"],
      },
    },
    {
      field: "Next step",
      draft: {
        ...validDraft,
        nextSteps: ["No action is needed but the release is already complete."],
      },
    },
  ];

  for (const { field, draft } of invalidDrafts) {
    assert.throws(
      () => renderUserStoriesBlocker(draft),
      (error: unknown) => (
        (error as { code?: string; details?: { field?: string } }).code
          === "INVALID_USER_STORIES_BLOCKER_DRAFT"
        && (error as { details?: { field?: string } }).details?.field === field
      ),
      `${field} must reject a short meaningless token`,
    );
  }
});

test("Blocker final quality gate rejects short tokens and every invalid bullet", () => {
  const shortTokenBlocker = `${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

Status: Blocked

## Missing facts

- abc

## Open questions

- def

## Human owner

- ghi

## Next step

- jkl
`;
  const assessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: shortTokenBlocker,
  }]);
  assert.equal(assessment.valid, false);
  if (!assessment.valid) {
    assert.deepEqual(assessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_HUMAN_OWNER_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const mixedMissingFacts = shortTokenBlocker
    .replace("- abc", "- The authoritative target audience is not confirmed.\n- abc")
    .replace("- def", "- Which audience owns the final acceptance decision?")
    .replace("- ghi", "- Product Owner")
    .replace("- jkl", "- The Product Owner confirms the target audience before Story authoring.");
  const mixedAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: mixedMissingFacts,
  }]);
  assert.equal(mixedAssessment.valid, false);
  if (!mixedAssessment.valid) {
    assert.deepEqual(mixedAssessment.issues, ["BLOCKER_MISSING_FACTS_REQUIRED"]);
  }

  const meaninglessMultiWordOwner = mixedMissingFacts
    .replace("- abc", "- The authoritative approval policy is not confirmed.")
    .replace("- Product Owner", "- abc def");
  const ownerAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: meaninglessMultiWordOwner,
  }]);
  assert.equal(ownerAssessment.valid, false);
  if (!ownerAssessment.valid) {
    assert.deepEqual(ownerAssessment.issues, ["BLOCKER_HUMAN_OWNER_REQUIRED"]);
  }

  const embeddedPlaceholderBlocker = shortTokenBlocker
    .replace("- abc", "- TODO determine owner")
    .replace("- def", "- TBD approval owner")
    .replace("- ghi", "- Unknown Owner")
    .replace("- jkl", "- TODO assign owner");
  const embeddedAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: embeddedPlaceholderBlocker,
  }]);
  assert.equal(embeddedAssessment.valid, false);
  if (!embeddedAssessment.valid) {
    assert.deepEqual(embeddedAssessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_HUMAN_OWNER_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const contradictoryEnglishBlocker = shortTokenBlocker
    .replace("- abc", "- Nothing is missing from the request")
    .replace("- def", "- None have been identified for this request")
    .replace("- ghi", "- No Owner")
    .replace("- jkl", "- No action is required before Story authoring");
  const contradictoryEnglishAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: contradictoryEnglishBlocker,
  }]);
  assert.equal(contradictoryEnglishAssessment.valid, false);
  if (!contradictoryEnglishAssessment.valid) {
    assert.deepEqual(contradictoryEnglishAssessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_HUMAN_OWNER_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const contradictoryChineseBlocker = shortTokenBlocker
    .replace("- abc", "- 当前请求没有任何缺失事实")
    .replace("- def", "- 当前没有任何待确认问题")
    .replace("- ghi", "- 无人负责")
    .replace("- jkl", "- 当前无需采取任何行动");
  const contradictoryChineseAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: contradictoryChineseBlocker,
  }]);
  assert.equal(contradictoryChineseAssessment.valid, false);
  if (!contradictoryChineseAssessment.valid) {
    assert.deepEqual(contradictoryChineseAssessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_HUMAN_OWNER_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const markerVariantBlocker = shortTokenBlocker
    .replace("- abc", "- N/A: determine the final approval owner")
    .replace("- def", "- T.B.D. approval owner must be clarified")
    .replace("- ghi", "- Not Assigned")
    .replace("- jkl", "- TO-DO: assign the final approval owner");
  const markerVariantAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: markerVariantBlocker,
  }]);
  assert.equal(markerVariantAssessment.valid, false);
  if (!markerVariantAssessment.valid) {
    assert.deepEqual(markerVariantAssessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_HUMAN_OWNER_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const emptyExceptionBlocker = shortTokenBlocker
    .replace("- abc", "- Nothing is missing except nothing")
    .replace("- def", "- No questions remain but abcdef")
    .replace("- ghi", "- Product Owner")
    .replace("- jkl", "- No action is needed except nothing");
  const emptyExceptionAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: emptyExceptionBlocker,
  }]);
  assert.equal(emptyExceptionAssessment.valid, false);
  if (!emptyExceptionAssessment.valid) {
    assert.deepEqual(emptyExceptionAssessment.issues, [
      "BLOCKER_MISSING_FACTS_REQUIRED",
      "BLOCKER_OPEN_QUESTIONS_REQUIRED",
      "BLOCKER_NEXT_STEP_REQUIRED",
    ]);
  }

  const emptyChineseException = emptyExceptionBlocker.replace(
    "- Nothing is missing except nothing",
    "- 除没有外，所有所需信息均已齐全。",
  );
  const emptyChineseExceptionAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: emptyChineseException,
  }]);
  assert.equal(emptyChineseExceptionAssessment.valid, false);
  if (!emptyChineseExceptionAssessment.valid) {
    assert.ok(emptyChineseExceptionAssessment.issues.includes("BLOCKER_MISSING_FACTS_REQUIRED"));
  }
});

test("Blocker renderer preserves explicit short human-role abbreviations", () => {
  for (const humanOwner of [
    "PM",
    "PO",
    "BA",
    "QA",
    "PM / BA",
    "Product Owner",
    "product owner",
    "Jane Doe",
    "产品负责人",
  ]) {
    const rendered = renderUserStoriesBlocker({
      status: "Pending",
      knownFacts: [],
      missingFacts: ["The authoritative target audience has not been confirmed."],
      openQuestions: ["Which target audience owns the final acceptance decision?"],
      humanOwners: [humanOwner],
      nextSteps: ["The assigned human owner confirms the audience before Story authoring."],
    });
    assert.deepEqual(
      assessUserStoriesQualityEntries([{ relativePath: "README.md", content: rendered }]),
      { valid: true, kind: "blocker" },
      `${humanOwner} remains a valid explicit human role`,
    );
  }
});

test("Blocker placeholder detection preserves substantive business use of similar words", () => {
  const rendered = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: ["The existing UI displays placeholder copy for an unknown account state."],
    missingFacts: ["Placeholder copy for the empty state has not been approved."],
    openQuestions: ["Which TODO-list behavior must remain compatible with existing filters?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner documents how the UI displays an unknown account state."],
  });

  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: rendered }]),
    { valid: true, kind: "blocker" },
  );

  const markerBusinessTerms = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: ["T.B.D. is the literal status imported from legacy records."],
    missingFacts: ["N/A handling for optional profile fields has not been approved."],
    openQuestions: ["TO-DO labels should retain which legacy filtering behavior?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the legacy status and filtering behavior."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: markerBusinessTerms }]),
    { valid: true, kind: "blocker" },
  );

  const reverseLiteralMarkerBusinessTerms = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [
      "The literal status imported from legacy records is T.B.D.",
      "The literal legacy status remains T.B.D. by design.",
    ],
    missingFacts: ["N/A handling for optional profile fields has not been approved."],
    openQuestions: ["Which legacy status should replace the imported literal value?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the legacy status replacement behavior."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{
      relativePath: "README.md",
      content: reverseLiteralMarkerBusinessTerms,
    }]),
    { valid: true, kind: "blocker" },
  );

  const chineseLiteralMarkerBusinessTerms = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: ["旧系统原样状态值为 T.B.D.，导入时必须保留。"],
    missingFacts: ["可替代旧状态的新状态值尚未获批。"],
    openQuestions: ["产品负责人应批准哪个新状态值？"],
    humanOwners: ["产品负责人"],
    nextSteps: ["产品负责人确认替代状态后，PM / BA 更新 Stories。"],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{
      relativePath: "README.md",
      content: chineseLiteralMarkerBusinessTerms,
    }]),
    { valid: true, kind: "blocker" },
  );

  const quotedLiteralMarkerBusinessTerms = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [
      "The literal legacy status is “T.B.D.” and must remain byte-for-byte.",
      "旧系统原样状态值为“T.B.D.”，导入时必须保留。",
      "The literal status for migrated records is T.B.D.",
      "The UI displays the literal status value “TBD” for migrated records.",
      "The importer stores “TBD” as the literal legacy status value.",
      "旧系统需保留字面状态值“T.B.D.”。",
    ],
    missingFacts: ["The replacement status has not been approved."],
    openQuestions: ["Which replacement status should the Product Owner approve?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the replacement status before Story authoring."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{
      relativePath: "README.md",
      content: quotedLiteralMarkerBusinessTerms,
    }]),
    { valid: true, kind: "blocker" },
  );

  const actionableException = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["All required information is available except the final launch date."],
    openQuestions: ["All questions are answered except who owns final approval."],
    humanOwners: ["Product Owner"],
    nextSteps: ["No action is needed except the Product Owner must confirm the launch date."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: actionableException }]),
    { valid: true, kind: "blocker" },
  );

  const exceptionBearingFacts = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["All required information is available except the final launch date."],
    openQuestions: ["All questions are answered except who owns final approval."],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the launch date and approval owner."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{ relativePath: "README.md", content: exceptionBearingFacts }]),
    { valid: true, kind: "blocker" },
  );

  const chineseExceptionBearingFacts = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["除最终上线日期外，所有所需信息均已齐全。"],
    openQuestions: ["除最终审批人外，所有问题均已回答。"],
    humanOwners: ["产品负责人"],
    nextSteps: ["产品负责人确认最终上线日期和审批人。"],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{
      relativePath: "README.md",
      content: chineseExceptionBearingFacts,
    }]),
    { valid: true, kind: "blocker" },
  );

  const negativeButMeaningfulMissingFact = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["No budget has been approved for the requested delivery scope."],
    openQuestions: ["Which budget owner can approve the requested delivery scope?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner obtains a budget decision before Story authoring."],
  });
  assert.deepEqual(
    assessUserStoriesQualityEntries([{
      relativePath: "README.md",
      content: negativeButMeaningfulMissingFact,
    }]),
    { valid: true, kind: "blocker" },
  );
});

test("a Blocker sentinel must be a standalone root README line", () => {
  const rendered = renderUserStoriesBlocker({
    status: "Blocked",
    knownFacts: [],
    missingFacts: ["The final audience is not confirmed."],
    openQuestions: ["Who is the primary audience?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the primary audience."],
  });
  const inlineOnly = rendered.replace(
    USER_STORIES_BLOCKER_SENTINEL,
    `The marker is \`${USER_STORIES_BLOCKER_SENTINEL}\`.`,
  );
  const assessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: inlineOnly,
  }]);
  assert.equal(assessment.valid, false);
  if (!assessment.valid) {
    assert.ok(assessment.issues.includes("BLOCKER_SENTINEL_MUST_BE_UNIQUE"));
  }

  const caseVariantDuplicate = rendered.replace(
    "- The final audience is not confirmed.",
    `- The final audience is not confirmed.\n- ${USER_STORIES_BLOCKER_SENTINEL.toLocaleUpperCase("en-US")}`,
  );
  const caseVariantAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: caseVariantDuplicate,
  }]);
  assert.equal(caseVariantAssessment.valid, false);
  if (!caseVariantAssessment.valid) {
    assert.ok(caseVariantAssessment.issues.includes("BLOCKER_SENTINEL_MUST_BE_UNIQUE"));
  }

  const caseVariantOnlyAssessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: rendered.replace(
      USER_STORIES_BLOCKER_SENTINEL,
      USER_STORIES_BLOCKER_SENTINEL.toLocaleUpperCase("en-US"),
    ),
  }]);
  assert.equal(caseVariantOnlyAssessment.valid, false);
  if (!caseVariantOnlyAssessment.valid) {
    assert.ok(caseVariantOnlyAssessment.issues.includes("BLOCKER_SENTINEL_MUST_BE_UNIQUE"));
  }
});

test("a Blocker contract is unique, rooted, and cannot be bypassed by a stale Story", () => {
  const validStory = `## profile/US-001-profile-placeholder/story.md

# US-001: Explain the profile placeholder state

## Acceptance criteria

### US-001-AC-01: Metric is present

\`\`\`gherkin
Given a confirmed metric exists
When the visitor opens the profile
Then the confirmed metric is visible
\`\`\`

### US-001-AC-02: Metric is absent

\`\`\`gherkin
Given an optional metric is not confirmed
When the visitor opens the profile
Then the missing owner decision is visible
\`\`\`
`;
  const invalidBlocker = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

Status: Blocked / Pending human input

## Missing facts

- The audience is unknown.

## Open questions

- Who owns acceptance?

## Human owner

- Product Owner

## Next step

- Answer the question.

${validStory}`;
  assert.equal(
    assessUserStoriesQuality(invalidBlocker).valid,
    false,
    "an invalid sentinel Blocker takes priority over stale valid Story files",
  );
  const invalidBlockerAssessment = assessUserStoriesQuality(invalidBlocker);
  assert.equal(invalidBlockerAssessment.valid, false);
  if (!invalidBlockerAssessment.valid) {
    assert.ok(invalidBlockerAssessment.issues.includes("BLOCKER_STATUS_MUST_BE_EXACT"));
  }

  const noSentinel = invalidBlocker.replace(`${USER_STORIES_BLOCKER_SENTINEL}\n\n`, "")
    .replace("Status: Blocked / Pending human input", "Status: Blocked");
  assert.equal(
    assessUserStoriesQuality(noSentinel).valid,
    false,
    "an attempted Blocker without its versioned sentinel cannot use a stale Story as a bypass",
  );

  const duplicateSentinel = invalidBlocker
    .replace("Status: Blocked / Pending human input", "Status: Blocked")
    .replace("# User Stories Blocker", `${USER_STORIES_BLOCKER_SENTINEL}\n\n# User Stories Blocker`);
  assert.equal(assessUserStoriesQuality(duplicateSentinel).valid, false);
  const duplicateAssessment = assessUserStoriesQuality(duplicateSentinel);
  assert.equal(duplicateAssessment.valid, false);
  if (!duplicateAssessment.valid) {
    assert.ok(duplicateAssessment.issues.includes("BLOCKER_SENTINEL_MUST_BE_UNIQUE"));
  }

  const caseVariantAssessment = assessUserStoriesQualityEntries([
    {
      relativePath: "notes.md",
      content: USER_STORIES_BLOCKER_SENTINEL.toLocaleUpperCase("en-US"),
    },
    {
      relativePath: "profile/US-001-profile-placeholder/story.md",
      content: validStory.replace(/^##[^\n]+\n\n/u, ""),
    },
  ]);
  assert.equal(caseVariantAssessment.valid, false);
  if (!caseVariantAssessment.valid) {
    assert.deepEqual(caseVariantAssessment.issues, ["BLOCKER_ROOT_README_REQUIRED"]);
  }
});

test("Blocker required sections are unique and contain substantive bullets", () => {
  const valid = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

**Status:** Pending

## Missing facts

- The authoritative audience is not confirmed.

## Open questions

- PROD-Q-01: Which audience owns final acceptance?

## Human owner

- Product Owner

## Next step

- Product Owner answers PROD-Q-01; PM / BA then writes the Stories.
`;
  for (const placeholder of ["TBD", "TODO", "Unknown", "None", "placeholder", "待补充"]) {
    assert.equal(
      assessUserStoriesQuality(valid.replace("The authoritative audience is not confirmed.", placeholder)).valid,
      false,
      `Missing facts cannot be ${placeholder}`,
    );
  }
  assert.equal(
    assessUserStoriesQuality(valid.replace(
      "## Next step",
      "## Next step\n\n- First action.\n\n## Next step",
    )).valid,
    false,
    "duplicate required sections are ambiguous",
  );
  assert.equal(
    assessUserStoriesQuality(`${valid}\n## README.md\n\n# Duplicate root README\n`).valid,
    false,
    "the aggregate may contain exactly one root README",
  );
});

test("Story quality binds two unique ACs to their own complete Gherkin scenarios", () => {
  const canonical = `## review/US-002-review/story.md

# US-002: Review a proposal

## Acceptance criteria

### US-002-AC-01: Core path

\`\`\`gherkin
Given a proposal exists
When a reviewer opens it
Then its scope is visible
\`\`\`

### US-002-AC-02: Revision path

\`\`\`gherkin
Given a proposal needs revision
When a reviewer requests changes
Then the requested change is recorded
\`\`\`
`;
  assert.equal(assessUserStoriesQuality(canonical).valid, true);
  assert.equal(
    assessUserStoriesQuality(canonical.replace("US-002-AC-02", "US-002-AC-01")).valid,
    false,
    "duplicate AC IDs cannot satisfy the count",
  );
  assert.equal(
    assessUserStoriesQuality(canonical.replace(
      "### US-002-AC-01: Core path\n\n\`\`\`gherkin\nGiven a proposal exists\nWhen a reviewer opens it\nThen its scope is visible\n\`\`\`",
      "### US-002-AC-01: Core path\n\nThe scenario is not written yet.",
    )).valid,
    false,
    "two scenarios under the full document cannot compensate for an AC without its own scenario",
  );
  assert.equal(
    assessUserStoriesQuality(canonical.replace(
      "# US-002: Review a proposal",
      "# US-002: Review a proposal\n\n**PRD:** [PRD]({relative-path-from-story-to-prd.md})",
    )).valid,
    false,
    "the canonical single-brace template token is not product evidence",
  );
  const templateAssessment = assessUserStoriesQuality(canonical.replace(
    "# US-002: Review a proposal",
    "# US-002: Review a proposal\n\n**PRD:** [PRD]({relative-path-from-story-to-prd.md})",
  ));
  assert.equal(templateAssessment.valid, false);
  if (!templateAssessment.valid) {
    assert.ok(templateAssessment.issues.includes("STORY_TEMPLATE_TOKEN_PRESENT"));
  }

  const legacyStory = `## legacy/US-001-legacy/story.md

# US-001: Preserve an older Story

## Acceptance criteria

### US-001-AC-01: Existing behavior

\`\`\`gherkin
Given an older Story exists
When a partial update runs
Then its content remains unchanged
\`\`\`
`;
  assert.equal(
    assessUserStoriesQuality(`${legacyStory}\n${canonical}`).valid,
    true,
    "one newly reviewable Story is enough to distinguish a partial update from placeholder-only output",
  );
  assert.equal(
    assessUserStoriesQuality(canonical
      .replace("# US-002: Review a proposal", "# US-002 — Review a proposal")
      .replace("### US-002-AC-01: Core path", "### US-002-AC-01 - Core path")
      .replace("### US-002-AC-02: Revision path", "### US-002-AC-02 — Revision path")
      .replaceAll("Given ", "  Given ")
      .replaceAll("When ", "  When ")
      .replaceAll("Then ", "  Then ")).valid,
    true,
    "H1 and AC delimiters plus indented Gherkin tolerate common Provider Markdown",
  );
});

test("Blocker decision fingerprints bind only Missing facts and concrete Open questions", () => {
  const baseline = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: ["The profile content already exists."],
    missingFacts: ["The final visual theme has not been confirmed."],
    openQuestions: ["Should the profile use the red or blue visual theme?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner selects one theme."],
  });
  const administrativeRevision = renderUserStoriesBlocker({
    status: "Blocked",
    knownFacts: ["The existing profile content will be retained."],
    missingFacts: ["  The final visual theme has not been confirmed.  "],
    openQuestions: ["SHOULD THE PROFILE USE THE RED OR BLUE VISUAL THEME?"],
    humanOwners: ["Design Director"],
    nextSteps: ["The Design Director records the selected theme before PM / BA continues."],
  });
  const newDecision = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["The final project-card density has not been confirmed."],
    openQuestions: ["Should project cards use compact or spacious density?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner selects one density."],
  });

  assert.equal(
    userStoriesBlockerDecisionFingerprint(baseline),
    userStoriesBlockerDecisionFingerprint(administrativeRevision),
    "status, known facts, owner, and next-step edits must not create a new decision occurrence",
  );
  assert.notEqual(
    userStoriesBlockerDecisionFingerprint(baseline),
    userStoriesBlockerDecisionFingerprint(newDecision),
    "a different missing fact and question must remain a new decision",
  );
  assert.match(
    userStoriesBlockerDecisionId(baseline) ?? "",
    /^PRODUCT-STORIES-BLOCKER-V2-[a-f0-9]{24}$/u,
  );
});

test("multi-question Blocker decision identities are per-question and stable across ordering", () => {
  const draft = {
    status: "Pending" as const,
    knownFacts: ["The current profile sections remain available."],
    missingFacts: [
      "The AI SDLC presentation format has not been selected.",
      "The repository-link policy has not been selected.",
    ],
    openQuestions: [
      "Should AI SDLC experience use cards or a table?",
      "Should project entries include repository links?",
      "Which AI SDLC experiences should be highlighted?",
    ],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner answers every question before Story authoring."],
  };
  const baseline = renderUserStoriesBlocker(draft);
  const reordered = renderUserStoriesBlocker({
    ...draft,
    missingFacts: [...draft.missingFacts].reverse(),
    openQuestions: [...draft.openQuestions].reverse(),
  });
  const decisions = userStoriesBlockerQuestionDecisions(baseline);
  const reorderedDecisions = userStoriesBlockerQuestionDecisions(reordered);

  assert.equal(decisions.length, 3);
  assert.equal(new Set(decisions.map(({ decisionId }) => decisionId)).size, 3);
  assert.ok(decisions.every(({ decisionId }) => (
    /^PRODUCT-STORIES-QUESTION-V3-[a-f0-9]{24}$/u.test(decisionId)
  )));
  assert.deepEqual(
    decisions.map(({ decisionId }) => decisionId).sort(),
    reorderedDecisions.map(({ decisionId }) => decisionId).sort(),
    "question and missing-fact reordering must not change content identities",
  );

  const changedContext = renderUserStoriesBlocker({
    ...draft,
    missingFacts: ["The exact AI SDLC project names have not been selected."],
  });
  assert.notDeepEqual(
    decisions.map(({ decisionId }) => decisionId).sort(),
    userStoriesBlockerQuestionDecisions(changedContext).map(({ decisionId }) => decisionId).sort(),
    "a changed missing-fact context must safely create new decisions",
  );
});

test("answered Blocker scopes cover reordered or reduced old facts/questions but not new context", () => {
  const draft = {
    status: "Pending" as const,
    knownFacts: ["The current profile sections remain available."],
    missingFacts: [
      "The AI SDLC presentation format has not been selected.",
      "The repository-link policy has not been selected.",
    ],
    openQuestions: [
      "Should AI SDLC experience use cards or a table?",
      "Should project entries include repository links?",
      "Which AI SDLC experiences should be highlighted?",
    ],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner answers every question before Story authoring."],
  };
  const answered = userStoriesBlockerDecisionScope(renderUserStoriesBlocker(draft));
  const reordered = userStoriesBlockerDecisionScope(renderUserStoriesBlocker({
    ...draft,
    missingFacts: [...draft.missingFacts].reverse(),
    openQuestions: [...draft.openQuestions].reverse(),
  }));
  const reduced = userStoriesBlockerDecisionScope(renderUserStoriesBlocker({
    ...draft,
    missingFacts: [draft.missingFacts[0]!],
    openQuestions: [draft.openQuestions[1]!],
  }));
  const newQuestion = userStoriesBlockerDecisionScope(renderUserStoriesBlocker({
    ...draft,
    openQuestions: [...draft.openQuestions, "Should the profile include a printable view?"],
  }));
  const changedFact = userStoriesBlockerDecisionScope(renderUserStoriesBlocker({
    ...draft,
    missingFacts: ["The authoritative project catalog has not been selected."],
  }));
  assert.ok(answered && reordered && reduced && newQuestion && changedFact);
  assert.equal(isUserStoriesBlockerDecisionScopeCovered(reordered, answered), true);
  assert.equal(isUserStoriesBlockerDecisionScopeCovered(reduced, answered), true);
  assert.equal(isUserStoriesBlockerDecisionScopeCovered(newQuestion, answered), false);
  assert.equal(isUserStoriesBlockerDecisionScopeCovered(changedFact, answered), false);
});

test("a generic request for any priority or business rule is not a human decision gate", () => {
  const concrete = renderUserStoriesBlocker({
    status: "Pending",
    knownFacts: [],
    missingFacts: ["The profile card density has not been confirmed."],
    openQuestions: ["Should project cards use compact or spacious density?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner selects one density."],
  });
  const generic = concrete.replace(
    "Should project cards use compact or spacious density?",
    "Is there a specific priority or business rule that must be reflected in the new user story?",
  );
  const assessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: generic,
  }]);
  assert.equal(assessment.valid, false);
  if (!assessment.valid) {
    assert.deepEqual(assessment.issues, ["BLOCKER_OPEN_QUESTION_NOT_SPECIFIC"]);
  }
});
