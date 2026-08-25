import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { routeTitle } from "@/lib/navigation";
import { allowAppNavigation } from "@/lib/navigation-guard";
import { ProjectPage } from "@/pages/project-page";
import { ProjectsPage } from "@/pages/projects-page";
import { RunPage } from "@/pages/run-page";

interface RouteState {
  projectId?: string;
  runId?: string;
  view?: "workflow" | "tickets";
  ticketId?: string;
}

const historyIndexKey = "aiSdlcHistoryIndex";

function historyIndex(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[historyIndexKey];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function indexedHistoryState(index: number): Record<string, unknown> {
  const current = window.history.state;
  return {
    ...(current && typeof current === "object" ? current as Record<string, unknown> : {}),
    [historyIndexKey]: index,
  };
}

function currentHistoryUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
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
  const navigationKindRef = useRef<"initial" | "push" | "pop">("initial");
  const restoringBlockedPopRef = useRef(false);
  const historyIndexRef = useRef(historyIndex(window.history.state) ?? 0);
  const renderedUrlRef = useRef(currentHistoryUrl());

  useEffect(() => {
    const initialIndex = historyIndex(window.history.state);
    if (initialIndex === undefined) {
      window.history.replaceState(
        indexedHistoryState(historyIndexRef.current),
        "",
        currentHistoryUrl(),
      );
    } else {
      historyIndexRef.current = initialIndex;
    }
    renderedUrlRef.current = currentHistoryUrl();

    const onPopState = (event: PopStateEvent) => {
      const targetIndex = historyIndex(event.state);
      if (restoringBlockedPopRef.current) {
        restoringBlockedPopRef.current = false;
        if (targetIndex !== undefined) historyIndexRef.current = targetIndex;
        renderedUrlRef.current = currentHistoryUrl();
        return;
      }
      if (!allowAppNavigation()) {
        if (targetIndex !== undefined && targetIndex !== historyIndexRef.current) {
          restoringBlockedPopRef.current = true;
          window.history.go(historyIndexRef.current - targetIndex);
        } else {
          window.history.pushState(
            indexedHistoryState(historyIndexRef.current),
            "",
            renderedUrlRef.current,
          );
        }
        return;
      }
      if (targetIndex !== undefined) historyIndexRef.current = targetIndex;
      renderedUrlRef.current = currentHistoryUrl();
      navigationKindRef.current = "pop";
      setRoute(readRoute());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: RouteState) => {
    if (!allowAppNavigation()) return;
    const params = new URLSearchParams();
    if (next.projectId) params.set("project", next.projectId);
    if (next.runId) params.set("run", next.runId);
    if (next.runId && next.view === "tickets") params.set("view", "tickets");
    if (next.runId && next.view === "tickets" && next.ticketId) params.set("ticket", next.ticketId);
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
    const nextIndex = historyIndexRef.current + 1;
    window.history.pushState(indexedHistoryState(nextIndex), "", nextUrl);
    historyIndexRef.current = nextIndex;
    renderedUrlRef.current = nextUrl;
    navigationKindRef.current = "push";
    setRoute(next);
  }, []);

  useEffect(() => {
    document.title = routeTitle(route);
    if (navigationKindRef.current !== "push") {
      navigationKindRef.current = "initial";
      return;
    }

    navigationKindRef.current = "initial";
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (!heading) return false;
      heading.focus({ preventScroll: true });
      return true;
    };
    if (focusHeading()) return;

    const main = document.querySelector("main");
    if (!main) return;
    const observer = new MutationObserver(() => {
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    const timeoutId = window.setTimeout(() => observer.disconnect(), 5_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeoutId);
    };
  }, [route.projectId, route.runId, route.ticketId, route.view]);

  const crumbs = route.runId
    ? [
        { label: "项目", onClick: () => navigate({ projectId: route.projectId }) },
        { label: route.view === "tickets" ? "Ticket 看板" : "工作流看板" },
      ]
    : route.projectId
      ? [{ label: "项目详情" }]
      : [];

  return (
    <AppShell crumbs={crumbs} onHome={() => navigate({})}>
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
