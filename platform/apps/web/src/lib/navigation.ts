export function routeTitle(route: {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  view?: "workflow" | "tickets";
  projectView?: "workspace" | "overview" | "ask";
}): string {
  if (route.runId) {
    return route.view === "tickets"
      ? "用户故事 Tickets · AI SDLC"
      : "工作流看板 · AI SDLC";
  }
  if (route.projectId && route.projectView === "ask") return "问项目 · AI SDLC";
  if (route.projectId && route.projectView === "overview") return "项目详情 · AI SDLC";
  return route.projectId ? "Agent 工作台 · AI SDLC" : "项目 · AI SDLC";
}
