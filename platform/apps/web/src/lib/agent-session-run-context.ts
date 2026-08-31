import type { AgentSession, AgentSessionRun } from "@/lib/types";

export function verifiedAgentSessionRun(
  candidateSessionId: string | undefined,
  workflowRunId: string,
  session: AgentSession | undefined,
): AgentSessionRun | undefined {
  if (!candidateSessionId || !session || session.id !== candidateSessionId) return undefined;
  return session.runs?.find((association) => (
    association.sessionId === candidateSessionId
    && association.workflowRunId === workflowRunId
  ));
}
