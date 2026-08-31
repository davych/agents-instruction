import type { AgentEvent, AgentEventKind, AskProviderId } from "./types";

export const MAX_DISMISSED_AGENT_FAILURE_EVENTS = 200;

const CONVERSATION_ACTIVITY_KINDS = new Set<AgentEventKind>([
  "tool.completed",
  "tool.failed",
  "sandbox.starting",
  "sandbox.ready",
  "sandbox.failed",
  "sdlc.run-created",
  "sdlc.phase-started",
  "sdlc.phase-completed",
  "turn.failed",
]);

const DISMISSIBLE_FAILURE_KINDS = new Set<AgentEventKind>([
  "tool.failed",
  "sandbox.failed",
  "turn.failed",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AgentFailureVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AgentSessionRunPointer {
  workflowRunId: string;
  providerId?: AskProviderId;
}

interface AgentSessionRunAssociationLike {
  workflowRunId: string;
  providerId: AskProviderId;
  createdAt: string;
}

/**
 * The durable Session-to-Run association is the control-plane source of truth.
 * Events remain a display/audit fallback for older API responses and projects.
 */
export function latestAgentSessionRunPointer(input?: {
  runs?: ReadonlyArray<AgentSessionRunAssociationLike>;
  events?: ReadonlyArray<Pick<AgentEvent, "workflowRunId">>;
}): AgentSessionRunPointer | undefined {
  const latestDurableRun = input?.runs?.reduce<AgentSessionRunAssociationLike | undefined>(
    (latest, candidate) => !latest || candidate.createdAt >= latest.createdAt ? candidate : latest,
    undefined,
  );
  if (latestDurableRun) {
    return {
      workflowRunId: latestDurableRun.workflowRunId,
      providerId: latestDurableRun.providerId,
    };
  }
  const fallbackEvent = [...(input?.events ?? [])]
    .reverse()
    .find(({ workflowRunId }) => Boolean(workflowRunId));
  return fallbackEvent?.workflowRunId
    ? { workflowRunId: fallbackEvent.workflowRunId }
    : undefined;
}

export function agentFailureVisibilityStorageKey(sessionId: string): string {
  return `ai-sdlc:agent-session:${sessionId}:dismissed-failure-events:v1`;
}

export function isDismissibleAgentFailureEvent(event: AgentEvent): boolean {
  return event.status === "failed" && DISMISSIBLE_FAILURE_KINDS.has(event.kind);
}

export function conversationFailureEvents(events: AgentEvent[]): AgentEvent[] {
  return events
    .filter(({ kind }) => CONVERSATION_ACTIVITY_KINDS.has(kind))
    .slice(-8)
    .filter(isDismissibleAgentFailureEvent);
}

export function visibleConversationActivityEvents(
  events: AgentEvent[],
  dismissedEventIds: Iterable<string>,
): AgentEvent[] {
  const dismissed = new Set(dismissedEventIds);
  return events
    .filter(({ kind }) => CONVERSATION_ACTIVITY_KINDS.has(kind))
    .slice(-8)
    .filter((event) => !(isDismissibleAgentFailureEvent(event) && dismissed.has(event.id)));
}

export function parseDismissedAgentFailureEventIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(
      (item): item is string => typeof item === "string" && UUID_PATTERN.test(item),
    ))].slice(-MAX_DISMISSED_AGENT_FAILURE_EVENTS);
  } catch {
    return [];
  }
}

export function readDismissedAgentFailureEventIds(
  storage: AgentFailureVisibilityStorage,
  sessionId: string,
): string[] {
  try {
    return parseDismissedAgentFailureEventIds(
      storage.getItem(agentFailureVisibilityStorageKey(sessionId)),
    );
  } catch {
    return [];
  }
}

export function writeDismissedAgentFailureEventIds(
  storage: AgentFailureVisibilityStorage,
  sessionId: string,
  ids: string[],
): boolean {
  try {
    const key = agentFailureVisibilityStorageKey(sessionId);
    if (ids.length) storage.setItem(key, JSON.stringify(ids));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function mergeDismissedAgentFailureEventIds(
  events: AgentEvent[],
  currentIds: Iterable<string>,
  additionalIds: Iterable<string>,
): string[] {
  const allowed = new Set(conversationFailureEvents(events).map(({ id }) => id));
  return [...new Set([...currentIds, ...additionalIds])]
    .filter((id) => allowed.has(id))
    .slice(-MAX_DISMISSED_AGENT_FAILURE_EVENTS);
}
