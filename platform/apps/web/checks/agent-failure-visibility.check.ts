import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DISMISSED_AGENT_FAILURE_EVENTS,
  agentFailureVisibilityStorageKey,
  conversationFailureEvents,
  mergeDismissedAgentFailureEventIds,
  parseDismissedAgentFailureEventIds,
  readDismissedAgentFailureEventIds,
  visibleConversationActivityEvents,
  writeDismissedAgentFailureEventIds,
} from "../src/lib/agent-failure-visibility.ts";
import type { AgentEvent } from "../src/lib/types.ts";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const event = (
  sequence: number,
  kind: AgentEvent["kind"],
  status: AgentEvent["status"],
): AgentEvent => ({
  id: id(sequence),
  sessionId: id(999),
  sequence,
  kind,
  status,
  summary: `${kind} ${status}`,
  messageId: null,
  toolCallId: null,
  projectId: null,
  workflowRunId: null,
  phaseId: null,
  createdAt: "2026-08-28T12:00:00.000Z",
});

test("only failure cards that are presentation noise can be dismissed", () => {
  const events = [
    event(1, "turn.failed", "failed"),
    event(2, "tool.failed", "failed"),
    event(3, "sandbox.failed", "failed"),
    event(4, "sdlc.run-created", "completed"),
    event(5, "turn.completed", "completed"),
  ];

  assert.deepEqual(conversationFailureEvents(events).map(({ sequence }) => sequence), [1, 2, 3]);
  assert.deepEqual(
    visibleConversationActivityEvents(events, [id(1), id(4)]).map(({ sequence }) => sequence),
    [2, 3, 4],
    "local browser data must never hide structural Run events",
  );
});

test("dismissed ids are namespaced per Session, validated and bounded", () => {
  assert.notEqual(
    agentFailureVisibilityStorageKey(id(1)),
    agentFailureVisibilityStorageKey(id(2)),
  );
  assert.deepEqual(parseDismissedAgentFailureEventIds("not-json"), []);
  assert.deepEqual(parseDismissedAgentFailureEventIds(JSON.stringify([
    id(1),
    id(1),
    "not-an-id",
    42,
  ])), [id(1)]);

  const many = Array.from(
    { length: MAX_DISMISSED_AGENT_FAILURE_EVENTS + 20 },
    (_, index) => id(index + 1),
  );
  const parsed = parseDismissedAgentFailureEventIds(JSON.stringify(many));
  assert.equal(parsed.length, MAX_DISMISSED_AGENT_FAILURE_EVENTS);
  assert.equal(parsed[0], id(21));
});

test("merge keeps only dismissible ids that still belong to the current Session detail", () => {
  const events = [
    event(1, "turn.failed", "failed"),
    event(2, "tool.failed", "completed"),
    event(3, "sdlc.run-created", "completed"),
  ];

  assert.deepEqual(
    mergeDismissedAgentFailureEventIds(events, [id(999)], [id(1), id(2), id(3)]),
    [id(1)],
  );
});

test("hiding a failure in the fixed eight-card window does not reveal older activity", () => {
  const events = [
    event(1, "sdlc.run-created", "completed"),
    event(2, "turn.failed", "failed"),
    ...Array.from({ length: 7 }, (_, index) => event(index + 3, "tool.completed", "completed")),
  ];

  assert.deepEqual(
    visibleConversationActivityEvents(events, [id(2)]).map(({ sequence }) => sequence),
    [3, 4, 5, 6, 7, 8, 9],
    "sequence 1 is outside the original window and must not be backfilled",
  );
});

test("browser storage failures fail open without exposing or corrupting Session state", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  assert.equal(writeDismissedAgentFailureEventIds(storage, id(999), [id(1)]), true);
  assert.deepEqual(readDismissedAgentFailureEventIds(storage, id(999)), [id(1)]);
  assert.equal(writeDismissedAgentFailureEventIds(storage, id(999), []), true);
  assert.deepEqual(readDismissedAgentFailureEventIds(storage, id(999)), []);

  const unavailable = {
    getItem: () => { throw new Error("disabled"); },
    setItem: () => { throw new Error("disabled"); },
    removeItem: () => { throw new Error("disabled"); },
  };
  assert.deepEqual(readDismissedAgentFailureEventIds(unavailable, id(999)), []);
  assert.equal(writeDismissedAgentFailureEventIds(unavailable, id(999), [id(1)]), false);
  assert.equal(writeDismissedAgentFailureEventIds(unavailable, id(999), []), false);
});
