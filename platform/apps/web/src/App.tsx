import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { AccessTokenGate } from "@/components/access-token-gate";
import { AppShell } from "@/components/app-shell";
import { ProviderSettingsDialog } from "@/components/provider-settings-dialog";
import { ErrorState, PageSkeleton } from "@/components/states";
import { api, ApiError, getAccessToken, setAccessToken } from "@/lib/api";
import { routeTitle } from "@/lib/navigation";
import { allowAppNavigation } from "@/lib/navigation-guard";
import { AgentWorkspacePage } from "@/pages/agent-workspace-page";
import { ProjectPage } from "@/pages/project-page";
import { ProjectsPage } from "@/pages/projects-page";
import { RunPage } from "@/pages/run-page";

interface RouteState {
  projectId?: string;
  sessionId?: string;
  runId?: string;
  view?: "workflow" | "tickets";
  projectView?: "workspace" | "overview" | "ask";
  ticketId?: string;
}

const AskPage = lazy(() =>
  import("@/pages/ask-page").then((module) => ({ default: module.AskPage })),
);

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
    sessionId: params.get("session") || undefined,
    runId: params.get("run") || undefined,
    view: params.get("view") === "tickets" ? "tickets" : "workflow",
    projectView: params.get("projectView") === "ask"
      ? "ask"
      : params.get("projectView") === "overview" ? "overview" : "workspace",
    ticketId: params.get("ticket") || undefined,
  };
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(readRoute);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const initialAccessTokenRef = useRef(getAccessToken());
  const [authenticationApproved, setAuthenticationApproved] = useState(false);
  const navigationKindRef = useRef<"initial" | "push" | "pop">("initial");
  const restoringBlockedPopRef = useRef(false);
  const historyIndexRef = useRef(historyIndex(window.history.state) ?? 0);
  const renderedUrlRef = useRef(currentHistoryUrl());
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
    staleTime: 30_000,
    retry: false,
  });
  const storedAuthenticationQuery = useQuery({
    queryKey: ["authentication", "stored-token"],
    queryFn: () => api.checkAuth(),
    enabled: healthQuery.data?.authentication?.required === true && Boolean(initialAccessTokenRef.current),
    retry: false,
  });

  useEffect(() => {
    if (storedAuthenticationQuery.isSuccess) setAuthenticationApproved(true);
    if (storedAuthenticationQuery.error instanceof ApiError && storedAuthenticationQuery.error.status === 401) {
      setAccessToken("");
    }
  }, [storedAuthenticationQuery.error, storedAuthenticationQuery.isSuccess]);

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

  const navigate = useCallback((next: RouteState, options: { replace?: boolean } = {}) => {
    if (!allowAppNavigation()) return;
    const params = new URLSearchParams();
    if (next.projectId) params.set("project", next.projectId);
    if (next.sessionId) params.set("session", next.sessionId);
    if (next.runId) params.set("run", next.runId);
    if (next.projectId && !next.runId && next.projectView && next.projectView !== "workspace") {
      params.set("projectView", next.projectView);
    }
    if (next.runId && next.view === "tickets") params.set("view", "tickets");
    if (next.runId && next.view === "tickets" && next.ticketId) params.set("ticket", next.ticketId);
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
    const nextIndex = options.replace ? historyIndexRef.current : historyIndexRef.current + 1;
    if (options.replace) {
      window.history.replaceState(indexedHistoryState(nextIndex), "", nextUrl);
    } else {
      window.history.pushState(indexedHistoryState(nextIndex), "", nextUrl);
    }
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
  }, [route.projectId, route.projectView, route.runId, route.sessionId, route.ticketId, route.view]);

  if (healthQuery.isLoading || (
    healthQuery.data?.authentication?.required &&
    initialAccessTokenRef.current &&
    storedAuthenticationQuery.isLoading
  )) {
    return <main className="mx-auto max-w-5xl px-6 py-12"><PageSkeleton /></main>;
  }
  if (healthQuery.isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <ErrorState error={healthQuery.error} retry={() => void healthQuery.refetch()} />
      </main>
    );
  }
  const authenticationRequired = healthQuery.data?.authentication?.required === true;
  if (authenticationRequired && !authenticationApproved && !storedAuthenticationQuery.isSuccess) {
    return (
      <AccessTokenGate
        storedTokenRejected={Boolean(initialAccessTokenRef.current && storedAuthenticationQuery.isError)}
        onConnected={() => setAuthenticationApproved(true)}
      />
    );
  }

  const crumbs = route.runId
    ? [
        {
          label: "Agent 工作台",
          onClick: () => navigate({ projectId: route.projectId }),
        },
        {
          label: route.view === "tickets" ? "Ticket 看板" : "工作流看板",
        },
      ]
    : route.projectId && route.projectView === "ask"
      ? [
          { label: "项目", onClick: () => navigate({ projectId: route.projectId }) },
          { label: "问项目" },
        ]
      : route.projectId && route.projectView === "overview"
        ? [{ label: "项目详情" }]
        : route.projectId
          ? [{ label: "Agent 工作台" }]
      : [];

  return (
    <>
      <AppShell
      crumbs={crumbs}
      onHome={() => navigate({})}
      onOpenProviderSettings={() => setProviderSettingsOpen(true)}
    >
      {route.runId ? (
        <RunPage
          runId={route.runId}
          sessionId={route.sessionId}
          onBack={(projectId) => navigate({ projectId: projectId || route.projectId })}
          onReturnToSession={(projectId, verifiedSessionId) => navigate({
            projectId: projectId || route.projectId,
            sessionId: verifiedSessionId || route.sessionId,
            projectView: "workspace",
          })}
          view={route.view ?? "workflow"}
          ticketId={route.ticketId}
          onViewChange={(view) => navigate({
            projectId: route.projectId,
            sessionId: route.sessionId,
            runId: route.runId,
            view,
          })}
          onOpenTicket={(ticketId) =>
            navigate({
              projectId: route.projectId,
              sessionId: route.sessionId,
              runId: route.runId,
              view: "tickets",
              ticketId,
            })
          }
          onCloseTicket={() =>
            navigate({
              projectId: route.projectId,
              sessionId: route.sessionId,
              runId: route.runId,
              view: "tickets",
            })
          }
        />
      ) : route.projectId && route.projectView === "ask" ? (
        <Suspense fallback={<PageSkeleton />}>
          <AskPage
            key={route.projectId}
            projectId={route.projectId}
            onBack={() => navigate({ projectId: route.projectId })}
            onOpenRun={(runId) => navigate({ projectId: route.projectId, runId })}
            onOpenProviderSettings={() => setProviderSettingsOpen(true)}
          />
        </Suspense>
      ) : route.projectId && route.projectView === "overview" ? (
        <ProjectPage
          projectId={route.projectId}
          onBack={() => navigate({})}
          onOpenAsk={() => navigate({ projectId: route.projectId, projectView: "ask" })}
          onOpenRun={(runId) => navigate({ projectId: route.projectId, runId })}
        />
      ) : route.projectId ? (
        <AgentWorkspacePage
          key={route.projectId}
          projectId={route.projectId}
          sessionId={route.sessionId}
          onSessionChange={(sessionId) => navigate({
            projectId: route.projectId,
            sessionId,
            projectView: "workspace",
          })}
          onSessionReplace={(sessionId) => navigate({
            projectId: route.projectId,
            sessionId,
            projectView: "workspace",
          }, { replace: true })}
          onBack={() => navigate({})}
          onOpenRun={(runId) => navigate({ projectId: route.projectId, sessionId: route.sessionId, runId })}
          onOpenProviderSettings={() => setProviderSettingsOpen(true)}
        />
      ) : (
        <ProjectsPage onOpenWorkspace={(projectId, sessionId) => navigate({
          projectId,
          sessionId,
          projectView: "workspace",
        })} />
      )}
      </AppShell>
      <ProviderSettingsDialog
        open={providerSettingsOpen}
        onOpenChange={setProviderSettingsOpen}
      />
    </>
  );
}
