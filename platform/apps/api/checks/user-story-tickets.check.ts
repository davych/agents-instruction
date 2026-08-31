import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import {
  parseUserStoryTicketEntries,
  parseUserStoryTickets,
} from "../src/domain/user-story-tickets.ts";

test("parses and orders individual story files from an aggregate snapshot", () => {
  const snapshot = `## pinyin-learning/US-002-continue/story.md

# US-002: 继续逐级练习

**Category:** pinyin-learning

## Acceptance criteria

### US-002-AC-01: 进入下一级

\`\`\`gherkin
Given 当前级别完成
When 用户继续
Then 进入下一级
\`\`\`

## pinyin-learning\\US-001-choose\\story.md

# US-001：选择拼音级别

**Category:** pinyin-learning

## Acceptance criteria

### US-001-AC-01：查看级别

### US-001-AC-02: 进入级别

## user-stories.md

# 拼音分级练习用户故事

- [US-001](pinyin-learning/US-001-choose/story.md)
`;

  const tickets = parseUserStoryTickets(snapshot);

  assert.deepEqual(tickets.map(({ storyKey, title, sourcePath, position }) => ({
    storyKey,
    title,
    sourcePath,
    position
  })), [
    {
      storyKey: "US-001",
      title: "选择拼音级别",
      sourcePath: "pinyin-learning/US-001-choose/story.md",
      position: 1
    },
    {
      storyKey: "US-002",
      title: "继续逐级练习",
      sourcePath: "pinyin-learning/US-002-continue/story.md",
      position: 2
    }
  ]);
  assert.equal(tickets[0]?.category, "pinyin-learning");
  assert.equal(tickets[0]?.acceptanceCriteriaCount, 2);
  assert.equal(tickets[1]?.acceptanceCriteriaCount, 1);
  assert.doesNotMatch(tickets[0]?.content ?? "", /拼音分级练习用户故事/u);
  assert.equal(
    tickets[0]?.contentHash,
    createHash("sha256").update(tickets[0]?.content ?? "").digest("hex")
  );
});

test("rejects duplicate story keys", () => {
  const snapshot = `## onboarding/first/story.md

# US-010: First title

**Category:** onboarding

## onboarding/second/story.md

# US-010：Second title

**Category:** onboarding
`;

  assert.throws(
    () => parseUserStoryTickets(snapshot),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === "INVALID_USER_STORIES"
      && /US-010/u.test(error.message)
  );
});

test("returns an empty list when no valid story file exists", () => {
  assert.deepEqual(parseUserStoryTickets(""), []);
  assert.deepEqual(parseUserStoryTickets(`## user-stories.md

# user-stories

Deterministic fake artifact.
`), []);
  assert.deepEqual(parseUserStoryTickets(`## onboarding/invalid/story.md

# Story without a stable ID
`), []);
});

test("entry parsing counts colon, fullwidth colon, dash, and em-dash AC delimiters", () => {
  const [ticket] = parseUserStoryTicketEntries([{
    relativePath: "review/US-011-review/story.md",
    content: `# US-011 — Review a proposal

### US-011-AC-01 - Core path

### US-011-AC-02 — Revision path

### US-011-AC-03：Fallback path

### US-011-AC-04: Recovery path
`,
  }]);

  assert.equal(ticket?.storyKey, "US-011");
  assert.equal(ticket?.acceptanceCriteriaCount, 4);
});
