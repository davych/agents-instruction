import {
  bindRemoteRepositorySchema,
  remoteGitCreateProjectSchema,
  type BindRemoteRepositoryInput,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import type { CloudProjectService } from "../cloud-project-service.js";
import type { AgentSessionService } from "./agent-session-service.js";

/** One default Cloud action: bind, wait for the immutable snapshot, then chat. */
export class RepositoryBindingService {
  constructor(
    private readonly store: PgWorkflowStore,
    private readonly cloudProjects: CloudProjectService,
    private readonly sessions: AgentSessionService,
  ) {}

  async bind(input: BindRemoteRepositoryInput, signal?: AbortSignal) {
    const request = bindRemoteRepositorySchema.parse(input);
    const inferred = inferRepositoryIdentity(request.repositoryUrl);
    const created = await this.cloudProjects.createRemoteProject(
      remoteGitCreateProjectSchema.parse({
        sourceKind: "remote-git",
        name: inferred.name,
        summary: `由 ${new URL(request.repositoryUrl).host} 远端仓库绑定`,
        repositoryUrl: request.repositoryUrl,
        requestedRef: request.requestedRef,
        credentialProfileId: request.credentialProfileId,
      }),
      signal,
    );
    const project = await this.cloudProjects.waitForProjectReady(created.project.id, signal);
    const current = await this.store.getProjectAgentSettings(project.id);
    let settings;
    try {
      settings = await this.store.updateProjectAgentSettings(project.id, {
        expectedVersion: current.version,
        repoAlias: inferred.alias,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "REPO_ALIAS_EXISTS") throw error;
      settings = await this.store.updateProjectAgentSettings(project.id, {
        expectedVersion: current.version,
        repoAlias: `${inferred.alias}-${project.id.slice(0, 6)}`.slice(0, 64).replace(/-+$/u, ""),
      });
    }
    const session = await this.sessions.create({
      primaryProjectId: project.id,
      providerId: settings.defaultProviderId,
      title: `${project.name} Agent Session`,
    });
    return { project, session };
  }
}

function inferRepositoryIdentity(repositoryUrl: string): { name: string; alias: string } {
  const url = new URL(repositoryUrl);
  const last = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/iu, "") || "repository";
  const name = decodeURIComponent(last).replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120)
    || "Remote repository";
  const normalized = last
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return { name, alias: /^[a-z]/u.test(normalized) ? normalized : `repo-${normalized || "remote"}` };
}
