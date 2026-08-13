import { MANIFEST_PATH } from "./constants.js";
import { ConfigError } from "./errors.js";
import { assertSafeRelativePath } from "./fs-safety.js";
import {
  renderClaudeAgent,
  renderClaudeInstructions,
  renderCodexAgent,
  renderCopilotAgent,
  renderCopilotInstructions
} from "./renderers/adapters.js";
import {
  renderArtifact,
  renderBaseline,
  renderCommonInstructions,
  renderPhaseSkill,
  renderRoleDocument
} from "./renderers/core.js";
import { compareCodeUnits, ensureFinalNewline } from "./utils.js";

export function buildBlueprint(config, configPath) {
  const entries = [];
  const paths = new Map();
  if (pathKey(configPath) === pathKey(MANIFEST_PATH)) {
    throw new ConfigError(`配置文件不能使用 manifest 保留路径: ${configPath}`);
  }
  const reservedPaths = new Set([configPath, MANIFEST_PATH].map(pathKey));
  const enabledRoles = config.roles.filter((role) => role.enabled);

  const add = (entry) => {
    assertSafeRelativePath(entry.path);
    const key = pathKey(entry.path);
    if (reservedPaths.has(key)) {
      throw new ConfigError(`生成目标不能覆盖保留文件: ${entry.path}`);
    }
    if (paths.has(key)) {
      throw new ConfigError(`生成目标路径重复或仅大小写不同: ${paths.get(key)} / ${entry.path}`);
    }
    paths.set(key, entry.path);
    entries.push(entry);
  };

  add({
    path: "AGENTS.md",
    mode: "block",
    markerStyle: "markdown",
    block: renderCommonInstructions(config, configPath)
  });
  add({
    path: ".gitignore",
    mode: "block",
    markerStyle: "hash",
    block: ensureFinalNewline(".ai-sdlc/backups/")
  });
  add({
    path: ".gitattributes",
    mode: "block",
    markerStyle: "hash",
    block: ensureFinalNewline(`ai-native.yaml text eol=lf
.ai-sdlc/** text eol=lf
.agents/** text eol=lf
.github/agents/** text eol=lf
.github/copilot-instructions.md text eol=lf
.claude/** text eol=lf
.codex/** text eol=lf
docs/ai-sdlc/** text eol=lf`)
  });

  for (const role of enabledRoles) {
    add({
      path: `${config.paths.roles}/${role.id}.md`,
      mode: "managed",
      content: renderRoleDocument(config, role, configPath)
    });
  }

  for (const baseline of config.baselines) {
    add({
      path: baseline.output,
      mode: "managed",
      content: renderBaseline(config, baseline, configPath)
    });
  }

  for (const artifact of config.artifacts) {
    add({
      path: artifact.output,
      mode: "seed",
      content: renderArtifact(config, artifact, configPath)
    });
  }

  for (const phase of config.workflow.phases) {
    const skill = renderPhaseSkill(config, phase, configPath);
    add({
      path: `.agents/skills/${phase.id}/SKILL.md`,
      mode: "managed",
      content: skill
    });
    if (config.integrations.claudeCode) {
      add({
        path: `.claude/skills/${phase.id}/SKILL.md`,
        mode: "managed",
        content: skill
      });
    }
  }

  if (config.integrations.githubCopilot) {
    add({
      path: ".github/copilot-instructions.md",
      mode: "block",
      markerStyle: "markdown",
      block: renderCopilotInstructions(config, configPath)
    });
    for (const role of enabledRoles) {
      add({
        path: `.github/agents/${role.id}.agent.md`,
        mode: "managed",
        content: renderCopilotAgent(config, role, configPath)
      });
    }
  }

  if (config.integrations.claudeCode) {
    add({
      path: "CLAUDE.md",
      mode: "block",
      markerStyle: "markdown",
      block: renderClaudeInstructions(config, configPath)
    });
    for (const role of enabledRoles) {
      add({
        path: `.claude/agents/${role.id}.md`,
        mode: "managed",
        content: renderClaudeAgent(config, role, configPath)
      });
    }
  }

  if (config.integrations.codex) {
    for (const role of enabledRoles) {
      add({
        path: `.codex/agents/${role.id}.toml`,
        mode: "managed",
        content: renderCodexAgent(config, role, configPath)
      });
    }
  }

  validateProviderContracts(entries);
  assertNoFileAncestorCollisions([configPath, MANIFEST_PATH, ...entries.map((entry) => entry.path)]);
  return entries.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function validateProviderContracts(entries) {
  for (const entry of entries) {
    if (entry.path.startsWith(".github/agents/") && entry.content.length > 30_000) {
      throw new ConfigError(`GitHub Copilot agent 超过 30,000 字符上限: ${entry.path}`);
    }
    if (entry.path.endsWith("/SKILL.md")) {
      const descriptionLine = entry.content
        .split("\n")
        .find((line) => line.startsWith("description: "));
      if (!descriptionLine) {
        throw new ConfigError(`Skill 缺少 description: ${entry.path}`);
      }
      const description = JSON.parse(descriptionLine.slice("description: ".length));
      if (description.length > 1024) {
        throw new ConfigError(`Skill description 超过 1024 字符上限: ${entry.path}`);
      }
    }
  }
}

function pathKey(filePath) {
  return filePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertNoFileAncestorCollisions(filePaths) {
  const sorted = filePaths
    .map((filePath) => ({ filePath, key: pathKey(filePath) }))
    .sort((left, right) => left.key.length - right.key.length);
  for (let index = 0; index < sorted.length; index += 1) {
    const parent = sorted[index];
    for (let childIndex = index + 1; childIndex < sorted.length; childIndex += 1) {
      const child = sorted[childIndex];
      if (child.key.startsWith(`${parent.key}/`)) {
        throw new ConfigError(`生成文件不能同时作为另一目标的父目录: ${parent.filePath} / ${child.filePath}`);
      }
    }
  }
}
