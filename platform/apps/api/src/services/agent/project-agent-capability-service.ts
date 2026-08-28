import {
  mcpActivationSchema,
  mcpInstallationSummarySchema,
  updateProjectAgentSettingsSchema,
  type McpActivationDto,
  type McpInstallationSummaryDto,
  type ProjectAgentSettingsDto,
  type UpdateProjectAgentSettingsInput,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import type { AskProviderRegistry } from "../llm/provider-registry.js";
import type { WorkItemMcpRegistry } from "../work-item/work-item-mcp-registry.js";
import type { SandboxBlueprintRegistry } from "./sandbox-blueprint-registry.js";

export class ProjectAgentSettingsService {
  constructor(
    private readonly store: PgWorkflowStore,
    private readonly providers: AskProviderRegistry,
    private readonly blueprints: SandboxBlueprintRegistry,
    private readonly mcp: McpCatalogService,
  ) {}

  get(projectId: string): Promise<ProjectAgentSettingsDto> {
    return this.store.getProjectAgentSettings(projectId);
  }

  async update(
    projectId: string,
    unparsedInput: UpdateProjectAgentSettingsInput,
  ): Promise<ProjectAgentSettingsDto> {
    const input = updateProjectAgentSettingsSchema.parse(unparsedInput);
    if (input.defaultProviderId) {
      const provider = this.providers.status(input.defaultProviderId);
      if (!provider.configured) {
        throw new AppError(
          provider.message || "所选 Provider 尚未配置",
          409,
          "AGENT_PROVIDER_NOT_CONFIGURED",
        );
      }
    }
    if (input.sandboxBlueprintId || input.sandboxBlueprintVersion) {
      const current = await this.store.getProjectAgentSettings(projectId);
      const blueprint = this.blueprints.resolve(
        input.sandboxBlueprintId ?? current.sandboxBlueprintId,
        input.sandboxBlueprintVersion ?? current.sandboxBlueprintVersion,
      );
      if (!blueprint.configured) {
        throw new AppError(
          blueprint.installHint || "所选 Sandbox Blueprint 尚未配置",
          409,
          "SANDBOX_BLUEPRINT_NOT_CONFIGURED",
        );
      }
    }
    if (input.enabledMcpServerIds) this.mcp.assertActivatable(input.enabledMcpServerIds);
    return this.store.updateProjectAgentSettings(projectId, input);
  }
}

/** Public catalog backed only by operator-installed, read-only Work Item MCPs. */
export class McpCatalogService {
  constructor(
    private readonly store: PgWorkflowStore,
    private readonly registry: WorkItemMcpRegistry,
  ) {}

  list(): McpInstallationSummaryDto[] {
    return this.registry.summaries().map((adapter) => mcpInstallationSummarySchema.parse({
      id: adapter.id,
      label: adapter.label,
      description: adapter.configured
        ? "读取已授权的外部工作项；结果会作为未信任需求证据保存。"
        : "外部工作项连接尚未完成管理员配置。",
      kind: adapter.kind,
      installed: true,
      authorization: adapter.configured ? "ready" : "missing",
      permissionClasses: ["read"],
      installHint: adapter.message,
    }));
  }

  assertActivatable(ids: readonly string[]): void {
    const byId = new Map(this.list().map((installation) => [installation.id, installation]));
    for (const id of ids) {
      const installation = byId.get(id);
      if (!installation?.installed) {
        throw new AppError("所选 MCP 尚未安装", 404, "MCP_INSTALLATION_NOT_FOUND");
      }
      if (installation.authorization === "missing") {
        throw new AppError("所选 MCP 尚未完成授权", 409, "MCP_AUTHORIZATION_REQUIRED");
      }
    }
  }

  async activate(projectId: string, serverId: string, enabled: boolean): Promise<McpActivationDto> {
    if (enabled) this.assertActivatable([serverId]);
    else if (!this.list().some(({ id }) => id === serverId)) {
      throw new AppError("MCP 安装项不存在", 404, "MCP_INSTALLATION_NOT_FOUND");
    }
    const settings = await this.store.getProjectAgentSettings(projectId);
    const ids = new Set(settings.enabledMcpServerIds);
    if (enabled) ids.add(serverId);
    else ids.delete(serverId);
    const updated = await this.store.updateProjectAgentSettings(projectId, {
      expectedVersion: settings.version,
      enabledMcpServerIds: [...ids].sort(),
    });
    const installation = this.list().find(({ id }) => id === serverId)!;
    return mcpActivationSchema.parse({
      projectId,
      mcpServerId: serverId,
      enabled: updated.enabledMcpServerIds.includes(serverId),
      permissionClasses: installation.permissionClasses,
      updatedAt: updated.updatedAt,
    });
  }
}
