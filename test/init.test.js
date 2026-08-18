import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../bin/cli.js";

const temporaryDirectories = [];
const roleIds = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("interactive init installs one native GitHub Copilot agent set", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const prompt = answers([
    "Solo Product",
    "A small product",
    "1",
    "docs/context.md, docs/brand.md",
    "tools/component-catalog.mjs"
  ], questions);

  assert.equal(await run(["init", target], { prompt, output: () => {} }), 0);
  assert.equal(questions.length, 5);

  const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
  assert.match(config, /name: "Solo Product"/u);
  assert.match(config, /summary: "A small product"/u);
  assert.match(config, /agent:\n  client: "github-copilot"/u);
  assert.match(config, /agents: "\.github\/agents"/u);
  assert.doesNotMatch(config, /clients:/u);
  assert.match(config, /outputs: docs/u);
  assert.match(config, /id: change-contract, owner: pm-ba, path: change-contract\.md/u);
  assert.match(config, /id: prd, owner: pm-ba, path: prd\.md/u);
  assert.match(config, /id: user-stories, owner: pm-ba, path: user-stories/u);
  assert.match(config, /outputs: \[change-contract, prd, user-stories\]/u);
  assert.match(config, /owner: designer\n      inputs: \[change-contract, prd, user-stories\]/u);
  assert.match(config, /owner: architect\n      inputs: \[change-contract, prd, user-stories, design-spec\]/u);
  assert.match(config, /outputs: \[architecture, architecture-discovery-context, architecture-options, architecture-c4-context, architecture-c4-containers, architecture-adrs, architecture-patterns, architecture-nfrs, architecture-adversarial\]/u);
  assert.match(config, /owner: software-engineer\n      inputs: \[change-contract, prd, user-stories, design-baseline, design-spec, architecture, architecture-c4-containers, architecture-adrs, architecture-patterns, architecture-nfrs\]/u);
  assert.match(config, /owner: tester\n      inputs: \[change-contract, prd, user-stories, architecture, architecture-nfrs, implementation-notes\]/u);
  assert.match(config, /owner: devops\n      inputs: \[architecture, architecture-adrs, architecture-nfrs, architecture-adversarial, test-report\]/u);
  assert.match(config, /id: design-baseline, owner: designer, path: DESIGN_BASELINE\.md/u);
  assert.match(config, /id: design-spec, owner: designer, path: design-spec\.md/u);
  assert.match(config, /id: architecture, owner: architect, path: architecture\.md/u);
  assert.match(config, /id: architecture-adrs, owner: architect, path: 04-adrs/u);

  for (const roleId of roleIds) {
    const agent = await readFile(path.join(target, `.github/agents/${roleId}.agent.md`), "utf8");
    assert.match(agent, new RegExp(`^---\\nname: "${roleId}"\\ndescription: `, "u"));
    assert.match(agent, new RegExp(`\\n---\\n\\n# `, "u"));
    const canonicalAgent = await readFile(
      path.join(process.cwd(), `templates/agents/${roleId}.md`),
      "utf8"
    );
    assert.ok(agent.endsWith(`${canonicalAgent.trim()}\n`));
  }
  assert.deepEqual(
    (await readdir(path.join(target, ".github/agents"))).sort(),
    roleIds.map((roleId) => `${roleId}.agent.md`).sort()
  );
  assert.equal(existsSync(path.join(target, ".ai-sdlc/agents")), false);
  assert.equal(existsSync(path.join(target, ".claude/agents")), false);
  assert.equal(existsSync(path.join(target, ".codex/agents")), false);
  const workflow = await readFile(path.join(target, ".ai-sdlc/workflows/default.md"), "utf8");
  assert.match(workflow, /artifact owner/u);
  assert.match(workflow, /\.ai-sdlc\/roles\/<owner>\/config\.yaml/u);
  assert.match(workflow, /immutable, task-scoped `change-contract`[\s\S]*Product Impact records `direct`, `reuse`, `partial`, or `full`/u);
  assert.match(workflow, /Design Impact records `skip`, `reuse`, `partial`, or `full`[\s\S]*Architecture Impact records `skip`, `reuse`, `partial`, or `full`[\s\S]*Bug fast path[\s\S]*Architecture: skip or reuse[\s\S]*Verification is never skipped/u);
  assert.match(workflow, /Older initialized projects that do not list `change-contract` are extended by the platform/u);
  assert.match(workflow, /Architect phase has an explicit selection checkpoint[\s\S]*`Selected option: <ID>`[\s\S]*selected-state output was refreshed after that review/u);
  await readFile(path.join(target, ".ai-sdlc/tasks/README.md"), "utf8");
  const prdTemplate = await readFile(path.join(target, ".ai-sdlc/templates/prd.md"), "utf8");
  const storyTemplate = await readFile(path.join(target, ".ai-sdlc/templates/story.md"), "utf8");
  assert.match(prdTemplate, /\{relative-path-from-prd-to-story\.md\}/u);
  assert.match(storyTemplate, /\{relative-path-from-story-to-prd\.md\}/u);
  assert.deepEqual(
    (await readdir(path.join(target, ".ai-sdlc/templates"))).sort(),
    [
      "architecture-adr.md",
      "architecture-adversarial.md",
      "architecture-c4-containers.mmd",
      "architecture-c4-context.mmd",
      "architecture-discovery-context.md",
      "architecture-nfrs.md",
      "architecture-options.md",
      "architecture-patterns.md",
      "architecture.md",
      "change-contract.md",
      "design-baseline.md",
      "design-spec.md",
      "implementation-notes.md",
      "prd.md",
      "release-runbook.md",
      "story.md",
      "test-report.md"
    ]
  );
  const pmBaConfig = await readFile(path.join(target, ".ai-sdlc/roles/pm-ba/config.yaml"), "utf8");
  assert.match(pmBaConfig, /role: "\.github\/agents\/pm-ba\.agent\.md"/u);
  assert.match(pmBaConfig, /inputs:\n  markdown: \[\]/u);
  assert.match(pmBaConfig, /output:\n  subdirectory: ai-native\/product/u);
  const pmBaWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/pm-ba/workflow.md"), "utf8");
  assert.match(pmBaWorkflow, /one `story\.md` per new story/u);
  assert.match(pmBaWorkflow, /`direct`[\s\S]*`reuse`[\s\S]*`partial`[\s\S]*`full`/u);
  assert.match(pmBaWorkflow, /Change Contract remains byte-for-byte unchanged/u);
  assert.doesNotMatch(pmBaWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/pm-ba/SKILL.md")), false);
  const changeContractTemplate = await readFile(
    path.join(target, ".ai-sdlc/templates/change-contract.md"),
    "utf8"
  );
  assert.match(changeContractTemplate, /immutable human contract for one Run/u);
  assert.match(changeContractTemplate, /## Current behavior or context[\s\S]*## Expected behavior and outcome[\s\S]*## Acceptance contract[\s\S]*## Regression obligations/u);
  assert.match(changeContractTemplate, /CC-AC-001[\s\S]*## Impact hints, not final dispositions/u);
  const pmBaAgent = await readFile(path.join(target, ".github/agents/pm-ba.agent.md"), "utf8");
  assert.match(pmBaAgent, /## Product disposition contract[\s\S]*`direct`[\s\S]*`reuse`[\s\S]*`partial`[\s\S]*`full`/u);
  assert.match(pmBaAgent, /change-contract[\s\S]*read-only/u);
  const architectConfig = await readFile(path.join(target, ".ai-sdlc/roles/architect/config.yaml"), "utf8");
  assert.match(architectConfig, /role: "\.github\/agents\/architect\.agent\.md"/u);
  assert.match(architectConfig, /artifacts: \[change-contract, prd, user-stories, design-spec\]/u);
  assert.match(architectConfig, /domain: null[\s\S]*regulations: \[\][\s\S]*confirmed_peak_load: null/u);
  assert.match(architectConfig, /rulebook:\n  project_mode: auto\n  validation: required\n  schema_version: 1/u);
  assert.match(architectConfig, /output:\n  subdirectory: ai-native\/architecture/u);
  assert.match(architectConfig, /minimum_options: 3[\s\S]*minimum_nfrs: 7[\s\S]*minimum_findings_per_stressor: 3/u);
  const architectWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/architect/workflow.md"), "utf8");
  assert.match(architectWorkflow, /`skip` and `reuse` are platform actions[\s\S]*Under `partial`[\s\S]*Under `full`/u);
  assert.match(architectWorkflow, /rulebook index[\s\S]*always-loaded[\s\S]*Greenfield, Brownfield, or Hybrid/u);
  assert.match(architectWorkflow, /all six conditional pack routes[\s\S]*load only packs marked Applicable or Blocked/u);
  assert.match(architectWorkflow, /Rule Pack Applicability rows[\s\S]*Never silently omit a pack/u);
  assert.match(architectWorkflow, /Rule Disposition Register[\s\S]*every rule × affected scope from every Applicable pack exactly once/u);
  assert.match(architectWorkflow, /Brownfield or existing Hybrid boundary[\s\S]*accepted migration ADR/u);
  assert.match(architectWorkflow, /Discovery is not selected[\s\S]*reviewed revision as read-only[\s\S]*Options is not selected[\s\S]*reviewed revision as read-only/u);
  assert.match(architectWorkflow, /do not edit an unselected artifact[\s\S]*record a new option selection/u);
  assert.match(architectWorkflow, /selected-state run reads them but does not rewrite them[\s\S]*invalidates the old selection/u);
  assert.match(architectWorkflow, /rulebook v1 JSON machine block[\s\S]*every rule × affected scope from every Applicable pack exactly once/u);
  assert.match(architectWorkflow, /platform semantic gate accepts option selection[\s\S]*final approval/u);
  assert.match(architectWorkflow, /rulebook-digest\.mjs[\s\S]*old checkpoint and selection are stale/u);
  assert.match(architectWorkflow, /Create or update the resolved `architecture` artifact[\s\S]*Check for human selection evidence[\s\S]*materialize the awaiting-selection scaffolds[\s\S]*`Awaiting human selection`/u);
  assert.match(architectWorkflow, /review-feedback line `Selected option: <ID>`[\s\S]*current options revision/u);
  assert.match(architectWorkflow, /C4 `\.mmd` artifact[\s\S]*`README\.md`[\s\S]*not an ADR[\s\S]*Pending document/u);
  assert.match(architectWorkflow, /Every output selected by the active execution contract exists and is non-empty/u);
  assert.match(architectWorkflow, /explicit `Must` and `Do not` rules/u);
  assert.match(architectWorkflow, /fresh session or independent reviewer/u);
  assert.doesNotMatch(architectWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/architect/SKILL.md")), false);
  const architectAgent = await readFile(path.join(target, ".github/agents/architect.agent.md"), "utf8");
  assert.match(architectAgent, /## Architecture disposition contract[\s\S]*`skip`[\s\S]*`reuse`[\s\S]*`partial`[\s\S]*`full`/u);
  const architectRuleIndex = await readFile(
    path.join(target, ".ai-sdlc/roles/architect/references/architecture-rules.md"),
    "utf8"
  );
  assert.match(architectRuleIndex, /MUST[\s\S]*DEFAULT[\s\S]*WHEN[\s\S]*FORBIDDEN/u);
  assert.match(architectRuleIndex, /Conditional pack router[\s\S]*API rules[\s\S]*Frontend rules/u);
  assert.match(architectRuleIndex, /Do not load a conditional pack merely because it exists/u);
  const architectRuleDirectory = path.join(target, ".ai-sdlc/roles/architect/references/rules");
  assert.deepEqual(
    (await readdir(architectRuleDirectory)).sort(),
    ["api.md", "core.md", "data.md", "frontend.md", "integration.md", "observability.md", "security.md"]
  );
  const architectRulePacks = Object.fromEntries(await Promise.all(
    ["api", "core", "data", "frontend", "integration", "observability", "security"].map(async (name) => [
      name,
      await readFile(path.join(architectRuleDirectory, `${name}.md`), "utf8")
    ])
  ));
  assert.match(architectRulePacks.api, /API-001[\s\S]*RESTful[\s\S]*API-002[\s\S]*response-envelope[\s\S]*API-003[\s\S]*cursor pagination/u);
  assert.match(architectRulePacks.data, /DATA-001[\s\S]*repository[\s\S]*DATA-002[\s\S]*transactional outbox[\s\S]*DATA-003[\s\S]*owning container[\s\S]*DATA-004[\s\S]*cache/u);
  assert.match(architectRulePacks.integration, /INT-001[\s\S]*retries[\s\S]*INT-002[\s\S]*deadlines[\s\S]*INT-003[\s\S]*circuit breaker[\s\S]*INT-004[\s\S]*anti-corruption layer[\s\S]*INT-005[\s\S]*event-driven/u);
  assert.match(architectRulePacks.security, /SEC-001[\s\S]*identity[\s\S]*SEC-002[\s\S]*authorization[\s\S]*SEC-003[\s\S]*sensitive fields/u);
  assert.match(architectRulePacks.observability, /OBS-001[\s\S]*request ID[\s\S]*OBS-002[\s\S]*structured logs[\s\S]*OBS-003[\s\S]*distributed tracing/u);
  assert.match(architectRulePacks.frontend, /FE-001[\s\S]*Greenfield, Brownfield, or Hybrid[\s\S]*FE-002[\s\S]*React[\s\S]*FE-003[\s\S]*Tailwind[\s\S]*FE-004[\s\S]*Redux Toolkit/u);
  assert.match(architectRulePacks.frontend, /Brownfield[\s\S]*do not introduce a second framework[\s\S]*migration ADR/u);
  assert.match(architectRulePacks.api, /API-001` \| `DEFAULT` \| `ADR required`[\s\S]*API-002` \| `DEFAULT` \| `ADR required`/u);
  assert.match(architectRulePacks.frontend, /FE-002` \| `DEFAULT` \| `ADR required`[\s\S]*FE-004` \| `DEFAULT` \| `ADR required`/u);
  assert.match(architectRulePacks.core, /Build context before the solution[\s\S]*Diverge before selecting[\s\S]*Keep C4 at the right level[\s\S]*Use an independent premortem/u);
  const rulebookDigestScript = path.join(target, ".ai-sdlc/roles/architect/scripts/rulebook-digest.mjs");
  const digestResult = spawnSync(process.execPath, [rulebookDigestScript], { cwd: target, encoding: "utf8" });
  assert.equal(digestResult.status, 0, digestResult.stderr);
  assert.match(digestResult.stdout, /^[a-f0-9]{64}\n$/u);
  await writeFile(
    path.join(target, ".ai-sdlc/roles/architect/config.yaml"),
    architectConfig.replace("project_mode: auto", "project_mode: brownfield"),
    "utf8"
  );
  const brownfieldDigestResult = spawnSync(process.execPath, [rulebookDigestScript], { cwd: target, encoding: "utf8" });
  assert.equal(brownfieldDigestResult.status, 0, brownfieldDigestResult.stderr);
  assert.notEqual(brownfieldDigestResult.stdout, digestResult.stdout);
  await writeFile(path.join(target, ".ai-sdlc/roles/architect/config.yaml"), architectConfig, "utf8");
  const architectureIndex = await readFile(path.join(target, ".ai-sdlc/templates/architecture.md"), "utf8");
  assert.match(architectureIndex, /Acceptance evidence:[\s\S]*## Rulebook Conformance[\s\S]*## Pack Index[\s\S]*## ADR Register[\s\S]*## Open Human Decisions/u);
  assert.match(architectureIndex, /## Rulebook Conformance[\s\S]*\| API \|[\s\S]*\| Data \|[\s\S]*\| Integration \|[\s\S]*\| Security \|[\s\S]*\| Observability \|[\s\S]*\| Frontend \|/u);
  assert.match(architectureIndex, /"selection": null[\s\S]*"justifiedDeviationRuleIds": \[\]/u);
  assertCanonicalRulebookBlock(architectureIndex, "architecture");
  const architectureDiscovery = await readFile(path.join(target, ".ai-sdlc/templates/architecture-discovery-context.md"), "utf8");
  assert.match(architectureDiscovery, /## Project Mode[\s\S]*Greenfield \/ Brownfield \/ Hybrid \/ Blocked[\s\S]*## Rule Pack Applicability[\s\S]*\| API \|[\s\S]*\| Frontend \|/u);
  assertCanonicalRulebookBlock(architectureDiscovery, "discovery");
  const architectureOptions = await readFile(path.join(target, ".ai-sdlc/templates/architecture-options.md"), "utf8");
  assert.match(architectureOptions, /## Rule Constraints[\s\S]*Rule fit or exceptions[\s\S]*Rule Conflict or Rejecting Constraint/u);
  assertCanonicalRulebookBlock(architectureOptions, "options");
  const architectureAdr = await readFile(path.join(target, ".ai-sdlc/templates/architecture-adr.md"), "utf8");
  assert.match(architectureAdr, /Related architecture rules:[\s\S]*Related scopes:[\s\S]*Rule effect:[\s\S]*does not silently waive/u);
  const architecturePatterns = await readFile(path.join(target, ".ai-sdlc/templates/architecture-patterns.md"), "utf8");
  assert.match(architecturePatterns, /## Rule Disposition Register[\s\S]*Adopted \/ Not triggered \/ Justified deviation \/ Exception \/ Blocked/u);
  assert.match(architecturePatterns, /"selection": \{ "optionId":[\s\S]*"scopeId": "\{scope-id-from-discovery\}"[\s\S]*justified_deviation/u);
  assertCanonicalRulebookBlock(architecturePatterns, "patterns");
  const architectureNfrs = await readFile(path.join(target, ".ai-sdlc/templates/architecture-nfrs.md"), "utf8");
  assert.match(architectureNfrs, /ai-sdlc:architecture-selection:v1[\s\S]*Source Rule IDs/u);
  const architectureContext = await readFile(path.join(target, ".ai-sdlc/templates/architecture-c4-context.mmd"), "utf8");
  const architectureContainers = await readFile(path.join(target, ".ai-sdlc/templates/architecture-c4-containers.mmd"), "utf8");
  assert.match(architectureContext, /ai-sdlc:architecture-selection:v1/u);
  assert.match(architectureContainers, /ai-sdlc:architecture-selection:v1/u);
  const architectureAdversarial = await readFile(path.join(target, ".ai-sdlc/templates/architecture-adversarial.md"), "utf8");
  assert.match(architectureAdversarial, /ai-sdlc:architecture-selection:v1/u);
  const designerGuidance = await readFile(path.join(target, ".ai-sdlc/guides/designer.md"), "utf8");
  assert.match(designerGuidance, /## GitHub Copilot[\s\S]*## Claude Code[\s\S]*## Codex/u);
  assert.match(designerGuidance, /ready-for-engineering[\s\S]*empty `blockers` list/u);
  await readFile(
    path.join(target, ".ai-sdlc/roles/designer/references/figma-workflow.md"),
    "utf8"
  );
  const designerConfig = await readFile(path.join(target, ".ai-sdlc/roles/designer/config.yaml"), "utf8");
  assert.match(designerConfig, /role: "\.github\/agents\/designer\.agent\.md"/u);
  assert.match(designerConfig, /artifacts: \[change-contract, prd, user-stories\]/u);
  assert.match(designerConfig, /- "docs\/context\.md"/u);
  assert.match(designerConfig, /output:\n  subdirectory: ai-native\/design\n\ncomponents:/u);
  const designerAgent = await readFile(path.join(target, ".github/agents/designer.agent.md"), "utf8");
  assert.match(designerAgent, /## Start here[\s\S]*## Evidence order[\s\S]*## Working rules[\s\S]*## Output contract[\s\S]*## Boundaries[\s\S]*## Handoff/u);
  assert.match(designerAgent, /Software Engineer[\s\S]*ready-for-engineering/u);
  assert.match(designerAgent, /## Design disposition contract[\s\S]*`skip`[\s\S]*`reuse`[\s\S]*`partial`[\s\S]*`full`/u);
  assert.match(designerAgent, /baseline is project-level|project-wide rules/u);
  const designerWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/designer/workflow.md"), "utf8");
  assert.match(designerWorkflow, /Handoff to Software Engineer[\s\S]*ready-for-engineering/u);
  assert.match(designerWorkflow, /`skip`[\s\S]*`reuse`[\s\S]*`partial`[\s\S]*`full`/u);
  assert.match(designerWorkflow, /Downstream implementation consumes the active product, design, and architecture clearances/u);
  assert.doesNotMatch(designerWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/designer/SKILL.md")), false);
  const designSpecTemplate = await readFile(path.join(target, ".ai-sdlc/templates/design-spec.md"), "utf8");
  assert.match(designSpecTemplate, /"blockers": \[\][\s\S]*## Handoff to Software Engineer/u);
  assert.match(designSpecTemplate, /artifact:change-contract/u);
  const engineerAgent = await readFile(path.join(target, ".github/agents/software-engineer.agent.md"), "utf8");
  assert.match(engineerAgent, /immutable Change Contract[\s\S]*Design `skip`[\s\S]*for `reuse`[\s\S]*all three gates/u);
  const testerAgent = await readFile(path.join(target, ".github/agents/tester.agent.md"), "utf8");
  assert.match(testerAgent, /change-contract[\s\S]*不会省略测试[\s\S]*目标回归结果/u);
  const implementationNotes = await readFile(
    path.join(target, ".ai-sdlc/templates/implementation-notes.md"),
    "utf8"
  );
  assert.match(implementationNotes, /## Contract and active clearances[\s\S]*Change Contract[\s\S]*## Impact-check deviations[\s\S]*Targeted regression obligations/u);
  const testReport = await readFile(path.join(target, ".ai-sdlc/templates/test-report.md"), "utf8");
  assert.match(testReport, /## Contract, scope, and environment[\s\S]*## Acceptance and regression results[\s\S]*pre-fix reproduction[\s\S]*## Coverage gaps/u);
  const componentQuery = await readFile(
    path.join(target, ".ai-sdlc/roles/designer/scripts/component-query.mjs"),
    "utf8"
  );
  assert.match(componentQuery, /tools\/component-catalog\.mjs/u);
  assert.doesNotMatch(componentQuery, /VDS|@verso/iu);

  await mkdir(path.join(target, "tools"), { recursive: true });
  await writeFile(path.join(target, "tools/component-catalog.mjs"), `
export async function loadComponentCatalog() {
  return {
    components: [{
      name: "Action",
      aliases: ["Button"],
      frameworks: ["web"],
      props: [{ name: "tone", values: ["primary", "secondary"] }]
    }],
    tokens: [],
    icons: []
  };
}
`, "utf8");

  const queryResult = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/component-query.mjs"),
    "component",
    "Action",
    "--json"
  ], { cwd: target, encoding: "utf8" });
  assert.equal(queryResult.status, 0, queryResult.stderr);
  assert.equal(JSON.parse(queryResult.stdout).matched, true);

  const specPath = path.join(target, "design-spec.md");
  await writeFile(specPath, validSpec(), "utf8");
  const validation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    specPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);

  const invalidSpecPath = path.join(target, "invalid-design-spec.md");
  await writeFile(invalidSpecPath, "```json\n{\"spec_version\":\"1.0\",\"screens\":{},\"components\":[null]}\n```\n", "utf8");
  const invalidValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    invalidSpecPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(invalidValidation.status, 1, invalidValidation.stderr);
  assert.ok(JSON.parse(invalidValidation.stdout).failures > 0);

  const blockedHandoffPath = path.join(target, "blocked-handoff-design-spec.md");
  await writeFile(
    blockedHandoffPath,
    validSpec().replace('"blockers": []', '"blockers": ["Needs a human decision"]'),
    "utf8"
  );
  const blockedHandoffValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    blockedHandoffPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(blockedHandoffValidation.status, 1, blockedHandoffValidation.stderr);
  assert.match(blockedHandoffValidation.stdout, /ready-for-engineering requires an empty blockers array/u);

  const emptyHandoffPath = path.join(target, "empty-handoff-design-spec.md");
  await writeFile(
    emptyHandoffPath,
    validSpec().replace(/## Handoff to Software Engineer[\s\S]*$/u, ""),
    "utf8"
  );
  const emptyHandoffValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    emptyHandoffPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(emptyHandoffValidation.status, 1, emptyHandoffValidation.stderr);
  assert.match(emptyHandoffValidation.stdout, /A ready-for-engineering SPEC needs ## Handoff to Software Engineer/u);
});

test("interactive init installs only the selected Claude Code or Codex agents", async () => {
  const cases = [
    {
      answer: "2",
      directory: ".claude/agents",
      fileName: (roleId) => `${roleId}.md`,
      absent: [".github/agents", ".codex/agents"],
      client: "claude-code",
      rolePattern: /role: "\.claude\/agents\/designer\.md"/u
    },
    {
      answer: "3",
      directory: ".codex/agents",
      fileName: (roleId) => `${roleId}.toml`,
      absent: [".github/agents", ".claude/agents"],
      client: "codex",
      rolePattern: /role: "\.codex\/agents\/designer\.toml"/u
    }
  ];

  for (const clientCase of cases) {
    const target = await temporaryDirectory();
    const prompt = answers([
      "Client Product",
      "Selected native client",
      ...(clientCase.answer === "2" ? ["unknown-client"] : []),
      clientCase.answer,
      "",
      ""
    ]);
    assert.equal(await run(["init", target], { prompt, output: () => {} }), 0);

    assert.deepEqual(
      (await readdir(path.join(target, clientCase.directory))).sort(),
      roleIds.map(clientCase.fileName).sort()
    );
    for (const absentDirectory of clientCase.absent) {
      assert.equal(existsSync(path.join(target, absentDirectory)), false);
    }
    assert.equal(existsSync(path.join(target, ".ai-sdlc/agents")), false);
    assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/designer/config.yaml")), true);
    assert.equal(existsSync(path.join(target, ".ai-sdlc/workflows/default.md")), true);
    const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
    assert.match(config, new RegExp(`client: "${clientCase.client}"`, "u"));
    assert.match(
      config,
      new RegExp(`agents: "${clientCase.directory.replace(".", "\\.").replaceAll("/", "\\/")}"`, "u")
    );
    assert.match(
      await readFile(path.join(target, ".ai-sdlc/roles/designer/config.yaml"), "utf8"),
      clientCase.rolePattern
    );
    if (clientCase.answer === "2") {
      const claudeAgent = await readFile(path.join(target, ".claude/agents/pm-ba.md"), "utf8");
      assert.ok(claudeAgent.endsWith(
        (await readFile(path.join(process.cwd(), "templates/agents/pm-ba.md"), "utf8")).trim() + "\n"
      ));
    }
  }

  const codexTarget = temporaryDirectories.at(-1);
  for (const roleId of roleIds) {
    const codexAgent = await readFile(path.join(codexTarget, `.codex/agents/${roleId}.toml`), "utf8");
    assert.match(codexAgent, new RegExp(`^name = "${roleId}"\\ndescription = `, "u"));
    const instructions = codexAgent.match(/^developer_instructions = (.+)$/mu);
    assert.ok(instructions);
    assert.equal(
      JSON.parse(instructions[1]),
      (await readFile(path.join(process.cwd(), `templates/agents/${roleId}.md`), "utf8")).trim()
    );
  }
});

test("init rejects unsafe output paths before writing anything", async () => {
  const target = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await symlink(outside, path.join(target, ".github"));

  await assert.rejects(
    run(["init", target], {
      prompt: answers(["Safe Product", "Do not escape the project", "1", "", ""]),
      output: () => {}
    }),
    /\.github\//u
  );

  assert.equal(existsSync(path.join(target, "ai-native.yaml")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  assert.deepEqual(await readdir(outside), []);

  const danglingTarget = await temporaryDirectory();
  const danglingOutside = await temporaryDirectory();
  const danglingAgents = path.join(danglingTarget, ".claude/agents");
  const danglingOutsideFile = path.join(danglingOutside, "pm-ba.md");
  await mkdir(danglingAgents, { recursive: true });
  await symlink(danglingOutsideFile, path.join(danglingAgents, "pm-ba.md"));

  await assert.rejects(
    run(["init", danglingTarget], {
      prompt: answers(["Safe Product", "Reject dangling links", "2", "", ""]),
      output: () => {}
    }),
    /\.claude\/agents\/pm-ba\.md/u
  );
  assert.equal(existsSync(danglingOutsideFile), false);
  assert.equal(existsSync(path.join(danglingTarget, "ai-native.yaml")), false);

  const collisionTarget = await temporaryDirectory();
  await writeFile(path.join(collisionTarget, ".codex"), "not a directory", "utf8");
  await assert.rejects(
    run(["init", collisionTarget], {
      prompt: answers(["Safe Product", "Reject path collisions", "3", "", ""]),
      output: () => {}
    }),
    /\.codex\//u
  );
  assert.equal(existsSync(path.join(collisionTarget, "ai-native.yaml")), false);
  assert.equal(existsSync(path.join(collisionTarget, ".ai-sdlc")), false);
});

function answers(values, questions) {
  const queue = [...values];
  return async (question) => {
    questions?.push(question);
    return queue.shift() ?? "";
  };
}

function assertCanonicalRulebookBlock(content, document) {
  const sentinel = "<!-- ai-sdlc:architecture-rulebook:v1 -->";
  assert.equal(content.split(sentinel).length - 1, 1);
  assert.match(content, new RegExp(`${sentinel}[\\s\\S]*\"document\": \"${document}\"`, "u"));
  assert.match(content, /"catalogDigest": "\{64-character digest from architect\/scripts\/rulebook-digest\.mjs\}"/u);
}

function validSpec() {
  return `\`\`\`json
{
  "spec_version": "1.0",
  "title": "Generic design",
  "mode": "new",
  "status": "ready-for-engineering",
  "framework": "web",
  "source": ["artifact:prd", "artifact:user-stories"],
  "screens": [{ "id": "main", "layout": "project pattern", "states": ["default"] }],
  "components": [{ "name": "Action", "source": "project", "props": { "tone": "primary" } }],
  "acceptance_criteria": [{
    "id": "US-001-AC-01",
    "requirement": "A clear action",
    "design_response": "The main action is identifiable"
  }],
  "blockers": []
}
\`\`\`

# Generic design

US-001-AC-01 is addressed by the verified project component.

## Handoff to Software Engineer

The design is ready for the Software Engineer. The required behavior is covered by US-001-AC-01 and there are no blockers.

**Next owner:** Software Engineer

### Build scope

- US-001 and US-001-AC-01.

### Behavior to preserve

- Keep the main action identifiable.

### Do not infer

- None.

### Allowed design flexibility

- None.

### Validation evidence

- The configured project component matched and the SPEC validator passed.

### Open decisions and blockers

- None.
`;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-interactive-"));
  temporaryDirectories.push(directory);
  return directory;
}
