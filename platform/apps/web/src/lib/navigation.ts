export function routeTitle(route: {
  projectId?: string;
  runId?: string;
  view?: "workflow" | "tickets";
}): string {
  if (route.runId) {
    return route.view === "tickets"
      ? "用户故事 Tickets · AI SDLC"
      : "工作流看板 · AI SDLC";
  }
  return route.projectId ? "项目详情 · AI SDLC" : "项目 · AI SDLC";
}
