import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { ProjectPage } from "@/pages/project-page";
import { ProjectsPage } from "@/pages/projects-page";
import { RunPage } from "@/pages/run-page";

interface RouteState {
  projectId?: string;
  runId?: string;
  view?: "workflow" | "tickets";
  ticketId?: string;
}

function readRoute(): RouteState {
  const params = new URLSearchParams(window.location.search);
  return {
    projectId: params.get("project") || undefined,
    runId: params.get("run") || undefined,
    view: params.get("view") === "tickets" ? "tickets" : "workflow",
    ticketId: params.get("ticket") || undefined,
  };
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(readRoute);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: RouteState) => {
    const params = new URLSearchParams();
    if (next.projectId) params.set("project", next.projectId);
    if (next.runId) params.set("run", next.runId);
    if (next.runId && next.view === "tickets") params.set("view", "tickets");
    if (next.runId && next.view === "tickets" && next.ticketId) params.set("ticket", next.ticketId);
    const query = params.toString();
    window.history.pushState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    setRoute(next);
  }, []);

  const crumbs = route.runId
    ? [
        { label: "项目", onClick: () => navigate({ projectId: route.projectId }) },
        { label: route.view === "tickets" ? "Ticket 看板" : "工作流看板" },
      ]
    : route.projectId
      ? [{ label: "项目详情" }]
      : [];

  return (
    <AppShell crumbs={crumbs}>
      {route.runId ? (
        <RunPage
          runId={route.runId}
          onBack={(projectId) => navigate({ projectId: projectId || route.projectId })}
          view={route.view ?? "workflow"}
          ticketId={route.ticketId}
          onViewChange={(view) => navigate({ projectId: route.projectId, runId: route.runId, view })}
          onOpenTicket={(ticketId) =>
            navigate({ projectId: route.projectId, runId: route.runId, view: "tickets", ticketId })
          }
          onCloseTicket={() =>
            navigate({ projectId: route.projectId, runId: route.runId, view: "tickets" })
          }
        />
      ) : route.projectId ? (
        <ProjectPage
          projectId={route.projectId}
          onBack={() => navigate({})}
          onOpenRun={(runId) => navigate({ projectId: route.projectId, runId })}
        />
      ) : (
        <ProjectsPage onSelectProject={(projectId) => navigate({ projectId })} />
      )}
    </AppShell>
  );
}
