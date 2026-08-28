import {
  sandboxBlueprintIdSchema,
  sandboxBlueprintSummarySchema,
  sandboxBlueprintVersionSchema,
  type SandboxBlueprintSummaryDto,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../../domain/errors.js";

const configuredBlueprintSchema = z.object({
  id: sandboxBlueprintIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  version: sandboxBlueprintVersionSchema,
  description: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000]*$/u),
  workerImage: z.string().trim().min(1).max(500)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]*$/u),
  default: z.boolean().default(false),
}).strict();

const configuredBlueprintsSchema = z.array(configuredBlueprintSchema).min(1).max(20);
const environmentBlueprintsSchema = z.array(
  configuredBlueprintSchema.omit({ workerImage: true }),
).min(1).max(20);
type ConfiguredBlueprint = z.infer<typeof configuredBlueprintSchema>;

export interface ResolvedSandboxBlueprint extends SandboxBlueprintSummaryDto {
  default: boolean;
  /** Trusted operator-only value. Never serialize this object to the browser. */
  workerImage: string;
}

export class SandboxBlueprintRegistry {
  private readonly entries: ReadonlyMap<string, ResolvedSandboxBlueprint>;
  private readonly defaultId: string;

  constructor(configurations: readonly ConfiguredBlueprint[]) {
    const entries = new Map<string, ResolvedSandboxBlueprint>();
    let configuredDefault: string | undefined;
    for (const candidate of configurations) {
      const config = configuredBlueprintSchema.parse(candidate);
      if (entries.has(config.id)) throw new Error(`Sandbox Blueprint ID 重复：${config.id}`);
      if (config.default) {
        if (configuredDefault) throw new Error("Sandbox Blueprint 只能有一个默认项");
        configuredDefault = config.id;
      }
      entries.set(config.id, {
        id: config.id,
        label: config.label,
        version: config.version,
        description: config.description,
        capabilities: {
          persistentWorkspace: true,
          testExecution: true,
          servicePorts: false,
          // The phase Worker network is deployment-owned and defaults to
          // Docker bridge. Until a Blueprint actually selects and enforces a
          // network policy, its public summary must not promise egress
          // restriction merely because the separate check runner is
          // networkless.
          restrictedNetwork: false,
        },
        configured: config.workerImage !== "unconfigured",
        installHint: config.workerImage === "unconfigured"
          ? "管理员需要配置 Docker Worker 镜像"
          : null,
        default: config.default,
        workerImage: config.workerImage,
      });
    }
    if (entries.size === 0) throw new Error("至少需要一个 Sandbox Blueprint");
    this.defaultId = configuredDefault ?? entries.keys().next().value!;
    this.entries = entries;
  }

  summaries(): SandboxBlueprintSummaryDto[] {
    return [...this.entries.values()].map(({ workerImage: _workerImage, default: _default, ...summary }) => (
      sandboxBlueprintSummarySchema.parse(summary)
    ));
  }

  default(): ResolvedSandboxBlueprint {
    return this.resolve(this.defaultId);
  }

  resolve(id?: string | null, version?: string | null): ResolvedSandboxBlueprint {
    const selected = this.entries.get(id || this.defaultId);
    if (!selected) {
      throw new AppError("所选 Sandbox Blueprint 不存在", 400, "SANDBOX_BLUEPRINT_NOT_FOUND");
    }
    if (version && selected.version !== version) {
      throw new AppError(
        "Sandbox Blueprint 版本已变化，请刷新仓库设置后重试",
        409,
        "SANDBOX_BLUEPRINT_VERSION_MISMATCH",
      );
    }
    return selected;
  }
}

export function createSandboxBlueprintRegistryFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fallbackWorkerImage?: string,
): SandboxBlueprintRegistry {
  const encoded = environment.AI_SDLC_SANDBOX_BLUEPRINTS?.trim();
  if (encoded) {
    try {
      const approvedWorkerImage = fallbackWorkerImage?.trim()
        || environment.AI_SDLC_WORKER_IMAGE?.trim();
      if (!approvedWorkerImage) throw new Error("Sandbox Blueprint 缺少批准的 Worker image");
      // Operators may publish several named/versioned policy choices, but the
      // image remains the one verified by Cloud startup. Browser- or
      // repository-selected images never cross this boundary.
      const configurations = environmentBlueprintsSchema.parse(JSON.parse(encoded))
        .map((configuration) => ({ ...configuration, workerImage: approvedWorkerImage }));
      return new SandboxBlueprintRegistry(configurations);
    } catch {
      throw new Error("AI_SDLC_SANDBOX_BLUEPRINTS 配置无效");
    }
  }
  const workerImage = fallbackWorkerImage?.trim() || environment.AI_SDLC_WORKER_IMAGE?.trim();
  if (!workerImage) {
    // Fake/dev mode still needs a stable public Blueprint identity even though
    // it cannot start a real Docker worker.
    return new SandboxBlueprintRegistry([{
      id: "default",
      label: "Managed default",
      version: "1",
      description: "平台默认的受限 Agent 工作环境",
      workerImage: "unconfigured",
      default: true,
    }]);
  }
  return new SandboxBlueprintRegistry([{
    id: "default",
    label: "Managed default",
    version: "1",
    description: "平台管理员批准的默认 Agent 工作环境",
    workerImage,
    default: true,
  }]);
}
