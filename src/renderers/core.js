import path from "node:path";

import { GENERATOR_NAME } from "../constants.js";
import { ensureFinalNewline, formatList } from "../utils.js";

const ARTIFACT_SECTIONS = {
  "product-brief": [
    "Problem / Opportunity",
    "Target Users",
    "Business Goal",
    "Success Metrics",
    "Scope",
    "Out of Scope",
    "Risks and Open Questions"
  ],
  requirements: [
    "Context",
    "Functional Requirements",
    "Non-functional Requirements",
    "Acceptance Criteria",
    "Dependencies",
    "Traceability",
    "Open Questions"
  ],
  "design-spec": [
    "User Journey",
    "Information Architecture",
    "Interaction States",
    "Visual and Content Rules",
    "Accessibility",
    "Responsive Behavior",
    "Engineering Handoff"
  ],
  architecture: [
    "Context and Constraints",
    "Quality Attributes",
    "System Context",
    "Components and Boundaries",
    "Data and Interfaces",
    "Security and Privacy",
    "Decisions and Trade-offs",
    "Risks"
  ],
  "implementation-plan": [
    "Approved Scope",
    "Change Plan",
    "Milestones",
    "Test Strategy",
    "Migration and Compatibility",
    "Risks",
    "Completion Evidence"
  ],
  "test-plan": [
    "Quality Risks",
    "Test Scope",
    "Acceptance Coverage",
    "Functional Tests",
    "Non-functional Tests",
    "Test Data and Environments",
    "Regression Strategy",
    "Release Recommendation"
  ],
  "release-runbook": [
    "Release Scope",
    "Prerequisites",
    "Deployment Steps",
    "Smoke Tests",
    "Observability and Alerts",
    "Rollback",
    "Incident Contacts",
    "Post-release Review"
  ]
};

export function renderRoleDocument(config, role, configPath) {
  const artifacts = config.artifacts.filter((artifact) => artifact.owner === role.id);
  const artifactLink = (artifact) => path.posix.relative(config.paths.roles, artifact.output);
  return ensureFinalNewline(`# ${role.name}

${generatedMarkdownHeader(configPath)}

- **Role ID:** \`${role.id}\`
- **Project:** ${config.project.name}
- **Mission:** ${role.mission}

## Responsibilities

${formatList(role.responsibilities)}

## Deliverables

${artifacts.length > 0 ? artifacts.map((artifact) => `- [${artifact.title}](${artifactLink(artifact)})`).join("\n") : "- （无启用产物）"}

## Working Protocol

1. 先读取 \`${configPath}\`、相关 baseline 和上游产物。
2. 在行动前写明假设、范围和验收方式。
3. 只修改本角色拥有或任务明确授权的产物。
4. 把决策、证据、风险和下一角色需要的上下文写入交付物。
5. 阶段 gate 未满足时停止交接，并列出缺口。
`);
}

export function renderBaseline(config, baseline, configPath) {
  const renderers = {
    "project-charter": renderProjectCharter,
    workflow: renderWorkflow,
    "definition-of-done": renderDefinitionOfDone,
    "role-registry": renderRoleRegistry
  };
  return renderers[baseline.template](config, baseline, configPath);
}

export function renderArtifact(config, artifact, configPath) {
  const role = config.roles.find((item) => item.id === artifact.owner);
  const sections = ARTIFACT_SECTIONS[artifact.template];
  const body = sections
    .map((section) => `## ${section}\n\n> TODO: ${role.name} 补充此部分，并链接相关证据。`)
    .join("\n\n");

  return ensureFinalNewline(`# ${artifact.title}

<!-- Seeded by ${GENERATOR_NAME} from ${configPath}. This artifact becomes user-owned after creation. -->

- **Project:** ${config.project.name}
- **Artifact ID:** \`${artifact.id}\`
- **Owner:** ${role.name} (\`${role.id}\`)
- **Status:** Draft
- **Baseline:** \`${config.paths.baseline}/\`

> ${config.project.summary}

${body}
`);
}

export function renderCommonInstructions(config, configPath) {
  const enabledRoles = config.roles.filter((role) => role.enabled);
  const commands = Object.entries(config.project.commands)
    .filter(([, command]) => command.trim().length > 0)
    .map(([name, command]) => `- **${name}:** \`${command}\``);

  const configOption = configPath === "ai-native.yaml"
    ? ""
    : ` --config ${renderCommandPath(configPath)}`;
  return ensureFinalNewline(`# ${config.project.name}: AI-native SDLC

${generatedMarkdownHeader(configPath)}

## Source of Truth

- \`${configPath}\` 是项目、角色、阶段、baseline 和产物路径的唯一配置源。
- \`${config.paths.baseline}/\` 是由配置生成的执行基线；不要直接编辑 generated 文件。
- 业务产物位于 \`${config.paths.artifacts}/\`，seed 文件创建后由项目维护，不会被同步覆盖。
- 配置变化后运行 \`npx ${GENERATOR_NAME} sync .${configOption}\`；提交前运行 \`npx ${GENERATOR_NAME} check .${configOption}\`。
${configOption.includes("<path-to-config>") ? `- 当前自定义配置路径含 shell 敏感字符；请把 \`<path-to-config>\` 替换为当前 shell 正确引用的 \`${configPath}\`。` : ""}

## Project Context

- **Summary:** ${config.project.summary}
- **Owner:** ${config.project.owner}
- **Locale:** ${config.project.locale}
- **Stack:** ${config.project.stack.length > 0 ? config.project.stack.join(", ") : "从仓库探测并回写配置"}

## Roles

${enabledRoles.map((role) => `- **${role.name}** (\`${role.id}\`): ${role.mission}`).join("\n")}

## Delivery Flow

${renderPhaseTable(config)}

## Working Agreements

1. 从当前阶段的上游产物开始，不凭空补齐产品或技术事实。
2. 让对应角色拥有决策；跨角色工作必须明确交接输入、输出和 gate。
3. 对可并行且文件范围独立的工作使用子智能体，最多并行 ${config.generation.maxParallelAgents} 个。
4. 变更应最小、可验证且可回滚；保留用户已有文件和无关改动。
5. 实现前明确验收标准，实现后运行相关检查并记录证据。
6. 任何密钥、生产权限或不可逆操作都不得写入模板或默认配置。

## Repository Commands

${commands.length > 0 ? commands.join("\n") : "- 尚未配置。先从仓库发现可靠命令，再将它们写回 `project.commands`。"}

## Definition of Done

${formatList(config.workflow.definitionOfDone)}
`);
}

export function renderPhaseSkill(config, phase, configPath) {
  const role = config.roles.find((item) => item.id === phase.owner);
  const workflowBaseline = config.baselines.find((item) => item.template === "workflow");
  const baselineTarget = workflowBaseline?.output ?? `${config.paths.baseline}/`;
  const artifactMap = new Map(config.artifacts.map((artifact) => [artifact.id, artifact]));
  const inputLines = phase.inputs.map((id) => {
    const artifact = artifactMap.get(id);
    return `- \`${id}\`: \`${artifact.output}\``;
  });
  const outputLines = phase.outputs.map((id) => {
    const artifact = artifactMap.get(id);
    return `- \`${id}\`: \`${artifact.output}\``;
  });

  return ensureFinalNewline(`---
name: ${phase.id}
description: ${yamlString(`Run the ${phase.name} phase as ${role.name}; use when work must produce ${phase.outputs.join(", ")}.`)}
---

# ${phase.name}

1. Read \`${configPath}\` and \`${baselineTarget}\`.
2. Act as **${role.name}** (\`${role.id}\`) and follow \`${config.paths.roles}/${role.id}.md\`.
3. Review every declared input and state missing information before editing outputs.
4. Update the declared output artifacts with decisions, evidence, risks, and open questions.
5. Verify the phase gate and report pass/fail with evidence.

## Inputs

${inputLines.length > 0 ? inputLines.join("\n") : "- No upstream artifact; start from the project charter and user evidence."}

## Outputs

${outputLines.join("\n")}

## Gate

${phase.gate}
`);
}

function renderProjectCharter(config, baseline, configPath) {
  return ensureFinalNewline(`# ${baseline.title}

${generatedMarkdownHeader(configPath)}

## Project

- **ID:** \`${config.project.id}\`
- **Name:** ${config.project.name}
- **Owner:** ${config.project.owner}
- **Locale:** ${config.project.locale}
- **Template set:** \`${config.templateSet}\`

## Purpose

${config.project.summary}

## Operating Model

这是一个 one-person company 风格的 AI-native 项目：一位负责人对最终决策负责，专业智能体承担 PM/BA、设计、架构、工程、测试和 DevOps 职能。任何智能体输出都必须可审查、可追踪并由证据支持。

## Constraints

- 配置是唯一事实源，生成物不得形成第二套配置。
- seed 业务产物允许人工持续编辑；generated baseline 和角色适配文件由 CLI 同步。
- 高风险、生产或不可逆动作需要负责人明确授权。
`);
}

function renderWorkflow(config, baseline, configPath) {
  return ensureFinalNewline(`# ${baseline.title}

${generatedMarkdownHeader(configPath)}

${renderPhaseTable(config)}

## Handoff Contract

每次交接必须包含：已完成范围、产物链接、关键决策、验证证据、已知风险、未解决问题和下一阶段 gate。上游事实不完整时，下游角色应返回缺口，而不是自行编造。
`);
}

function renderDefinitionOfDone(config, baseline, configPath) {
  return ensureFinalNewline(`# ${baseline.title}

${generatedMarkdownHeader(configPath)}

以下条件全部满足，或例外获得项目负责人明确接受，工作才算完成：

${config.workflow.definitionOfDone.map((item) => `- [ ] ${item}`).join("\n")}
`);
}

function renderRoleRegistry(config, baseline, configPath) {
  const rows = config.roles.map((role) => {
    const deliverables = role.deliverables.map((item) => `\`${item}\``).join(", ");
    return `| \`${role.id}\` | ${mdCell(role.name)} | ${role.enabled ? "enabled" : "disabled"} | ${mdCell(role.mission)} | ${deliverables} |`;
  });
  return ensureFinalNewline(`# ${baseline.title}

${generatedMarkdownHeader(configPath)}

| Role ID | Name | Status | Mission | Deliverables |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

角色的详细职责位于 \`${config.paths.roles}/\`。三种 AI 工具的适配文件均从这些配置字段生成。
`);
}

function renderPhaseTable(config) {
  const roles = new Map(config.roles.map((role) => [role.id, role]));
  const rows = config.workflow.phases.map((phase, index) => {
    return `| ${index + 1} | \`${phase.id}\` | ${mdCell(phase.name)} | ${mdCell(roles.get(phase.owner).name)} | ${phase.outputs.map((id) => `\`${id}\``).join(", ")} | ${mdCell(phase.gate)} |`;
  });
  return `| # | Phase | Name | Owner | Outputs | Gate |\n| ---: | --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}

function generatedMarkdownHeader(configPath) {
  return `<!-- Generated by ${GENERATOR_NAME} from ${configPath} (schemaVersion 1). Do not edit directly. -->`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function mdCell(value) {
  return String(value).replace(/\r?\n/gu, "<br>").replace(/\|/gu, "\\|");
}

function renderCommandPath(value) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) {
    return `<path-to-config>`;
  }
  return value;
}
