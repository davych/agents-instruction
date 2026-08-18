import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { AppError } from "../domain/errors.js";
import {
  architectureRulePackIds,
  validateArchitectureRulebook,
  type ArchitectureAdrFile,
  type ArchitectureRulebookProjectMode,
  type ArchitectureRulebookSource,
} from "./architecture-rulebook-validator.js";
import { assertRuntimePath, readArtifactContent } from "./artifact-workspace.js";

const architectureAdrBytesLimit = 2_000_000;

interface ArchitectureArtifactContent {
  artifactKey: string;
  content: string;
  filePath: string;
  revisionSource: "ai" | "human";
}

interface ValidateArchitectureRulebookReviewInput {
  projectRoot: string;
  stage: "checkpoint" | "final";
  artifacts: ReadonlyArray<ArchitectureArtifactContent>;
  documentedOptionIds: string[];
  architectureSelection?: {
    optionId: string;
    reviewId: string;
    optionsArtifactId: string;
    selectedAt: string;
  };
}

const architectConfigSchema = z.object({
  rulebook: z.object({
    project_mode: z.enum(["auto", "greenfield", "brownfield", "hybrid"]).default("auto"),
    validation: z.enum(["required", "advisory"]),
    schema_version: z.number().int().optional(),
  }).strict().optional(),
}).passthrough();

export async function validateArchitectureRulebookReview(
  input: ValidateArchitectureRulebookReviewInput,
): Promise<void> {
  const configured = await loadArchitectureRulebookContext(input.projectRoot);
  if (configured.validation !== "required") return;
  const byKey = new Map(input.artifacts.map((artifact) => [artifact.artifactKey, artifact.content]));
  const adrArtifact = input.artifacts.find((artifact) => artifact.artifactKey === "architecture-adrs");
  const architectureAdrFiles = input.stage === "final" && adrArtifact
    ? await readArchitectureAdrFiles(input.projectRoot, adrArtifact)
    : undefined;
  validateArchitectureRulebook({
    validation: "required",
    stage: input.stage,
    rulebook: configured.source,
    discoveryContext: byKey.get("architecture-discovery-context"),
    architectureOptions: byKey.get("architecture-options"),
    architectureIndex: byKey.get("architecture"),
    architecturePatterns: byKey.get("architecture-patterns"),
    architectureC4Context: byKey.get("architecture-c4-context"),
    architectureC4Containers: byKey.get("architecture-c4-containers"),
    architectureAdrs: byKey.get("architecture-adrs"),
    architectureAdrFiles,
    architectureAdrsRevisionSource: adrArtifact?.revisionSource,
    architectureNfrs: byKey.get("architecture-nfrs"),
    architectureAdversarial: byKey.get("architecture-adversarial"),
    documentedOptionIds: input.documentedOptionIds,
    architectureSelection: input.architectureSelection,
  });
}

/**
 * Reads ADRs from the actual artifact directory. The aggregate stored in the DB
 * is checked for byte-for-byte equality, but is never parsed as a file boundary:
 * Markdown inside README or 00-selection therefore cannot manufacture ADR files.
 */
export async function readArchitectureAdrFiles(
  projectRoot: string,
  artifact: Pick<ArchitectureArtifactContent, "content" | "filePath">,
): Promise<ArchitectureAdrFile[]> {
  const absolutePath = path.resolve(projectRoot, artifact.filePath);
  await assertRuntimePath(projectRoot, absolutePath);
  const rootStats = await lstat(absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError(
        "architecture-adrs 工作区目录不存在，请重新生成该产物后再审核",
        409,
        "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH",
      );
    }
    throw error;
  });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new AppError(
      "architecture-adrs 必须是项目内不经过符号链接的真实目录",
      422,
      "UNSAFE_ARCHITECTURE_ADR_DIRECTORY",
    );
  }

  const physicalAggregate = await readArtifactContent(absolutePath, architectureAdrBytesLimit);
  if (physicalAggregate !== artifact.content) {
    throw new AppError(
      "architecture-adrs 的数据库快照与工作区内容不一致，请重新生成或保存产物后再审核",
      409,
      "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH",
    );
  }

  const files: ArchitectureAdrFile[] = [];
  let consumed = 0;
  const visit = async (directory: string): Promise<void> => {
    await assertRuntimePath(projectRoot, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      await assertRuntimePath(projectRoot, target);
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || entry.isSymbolicLink()) {
        throw new AppError(
          "architecture-adrs 目录不能包含符号链接",
          422,
          "UNSAFE_ARCHITECTURE_ADR_DIRECTORY",
        );
      }
      if (stats.isDirectory() && entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!stats.isFile() || !entry.isFile()) {
        throw new AppError(
          "architecture-adrs 目录只能包含普通文件和目录",
          422,
          "UNSAFE_ARCHITECTURE_ADR_DIRECTORY",
        );
      }
      consumed += stats.size;
      if (consumed > architectureAdrBytesLimit) {
        throw new AppError(
          `architecture-adrs 超过 ${architectureAdrBytesLimit} 字节限制`,
          422,
          "ARTIFACT_TOO_LARGE",
        );
      }
      files.push({
        relativePath: path.relative(absolutePath, target).split(path.sep).join("/"),
        content: await readFile(target, "utf8"),
      });
    }
  };
  await visit(absolutePath);

  const rereadAggregate = files
    .map((file) => `## ${file.relativePath}\n\n${file.content}`)
    .join("\n\n");
  if (rereadAggregate !== physicalAggregate) {
    throw new AppError(
      "读取 architecture-adrs 期间工作区发生变化，请刷新后重试",
      409,
      "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH",
    );
  }
  return files;
}

export async function architectureRulebookValidationRequired(projectRoot: string): Promise<boolean> {
  return (await loadArchitectureRulebookContext(projectRoot)).validation === "required";
}

export async function loadArchitectureRulebookContext(projectRoot: string): Promise<{
  validation: "required" | "advisory";
  source?: ArchitectureRulebookSource;
}> {
  const roleRoot = path.join(projectRoot, ".ai-sdlc", "roles", "architect");
  const configPath = path.join(roleRoot, "config.yaml");
  const configContent = await readOptionalRegularFile(configPath);
  if (configContent === undefined) return { validation: "advisory" };

  let config: z.infer<typeof architectConfigSchema>;
  try {
    config = architectConfigSchema.parse(YAML.parse(configContent));
  } catch (error) {
    throw new AppError("Architect config 中的 rulebook 配置无效", 400, "CONFIG_INVALID", error);
  }
  const validation = config.rulebook?.validation ?? "advisory";
  if (validation !== "required") return { validation };
  if (config.rulebook?.schema_version !== 1) {
    throw new AppError(
      "Architect rulebook required 模式仅支持 schema_version: 1",
      400,
      "CONFIG_INVALID",
    );
  }

  const referenceRoot = path.join(roleRoot, "references");
  const projectMode: ArchitectureRulebookProjectMode = config.rulebook?.project_mode ?? "auto";
  const indexMarkdown = await readOptionalRegularFile(path.join(referenceRoot, "architecture-rules.md"));
  const entries = await Promise.all(["core", ...architectureRulePackIds].map(async (id) => {
    const relativePath = `rules/${id}.md`;
    return [relativePath, await readOptionalRegularFile(path.join(referenceRoot, relativePath))] as const;
  }));
  return {
    validation,
    source: indexMarkdown === undefined
      ? undefined
      : { indexMarkdown, packMarkdownByPath: Object.fromEntries(entries), projectMode },
  };
}

async function readOptionalRegularFile(filePath: string): Promise<string | undefined> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AppError(
        `Architect rulebook 路径必须是普通文件：${filePath}`,
        400,
        "CONFIG_INVALID",
      );
    }
    return readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
