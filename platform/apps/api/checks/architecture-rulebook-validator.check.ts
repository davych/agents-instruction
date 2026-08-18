import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppError } from "../src/domain/errors.js";
import {
  architectureRulePackIds,
  calculateArchitectureRulebookDigest,
  inspectArchitectureRulebook,
  validateArchitectureRulebook,
  type ArchitectureRulebookValidationInput,
} from "../src/services/architecture-rulebook-validator.js";
import { readArchitectureAdrFiles } from "../src/services/architecture-rulebook-runtime.js";
import { readArtifactContent } from "../src/services/artifact-workspace.js";

const ruleIds = {
  api: "API-001",
  data: "DATA-001",
  integration: "INT-001",
  security: "SEC-001",
  observability: "OBS-001",
  frontend: "FE-002",
} as const;
const selectionEvidence = {
  optionId: "A",
  reviewId: "11111111-1111-4111-8111-111111111111",
  optionsArtifactId: "22222222-2222-4222-8222-222222222222",
  selectedAt: "2026-08-18T08:00:00.000Z",
};

test("legacy advisory projects do not acquire a new semantic gate", () => {
  assert.deepEqual(
    inspectArchitectureRulebook({ validation: "advisory", stage: "final" }),
    { enabled: false, rules: [], issues: [] },
  );
});

test("a complete checkpoint contract validates every routed rule", () => {
  const result = validateArchitectureRulebook(checkpointInput("greenfield"));
  assert.equal(result.enabled, true);
  assert.equal(result.rules.length, 6);
});

test("checkpoint validation rejects missing, duplicate, and blocked rule evidence", () => {
  const missing = checkpointInput("greenfield");
  const options = optionsObject(inputDigest(missing));
  options.rules = options.rules.filter((rule) => rule.ruleId !== "DATA-001");
  missing.architectureOptions = contract(options);
  assertIssue(missing, "OPTIONS_MISSING");

  const duplicate = checkpointInput("greenfield");
  duplicate.discoveryContext = `${duplicate.discoveryContext}\n${duplicate.discoveryContext}`;
  assertIssue(duplicate, "CONTRACT_DUPLICATE");

  const blocked = checkpointInput("greenfield");
  const discovery = discoveryObject("greenfield", inputDigest(blocked));
  discovery.packs[0]!.status = "blocked";
  discovery.packs[0]!.blockerOwner = "platform owner";
  blocked.discoveryContext = contract(discovery);
  assertIssue(blocked, "DISCOVERY_PACK_BLOCKED");
});

test("placeholder evidence cannot route every rule pack out of scope", () => {
  const input = checkpointInput("greenfield");
  const catalogDigest = inputDigest(input);
  const discovery = discoveryObject("greenfield", catalogDigest);
  discovery.packs = discovery.packs.map((pack) => ({
    ...pack,
    status: "not_applicable" as const,
    triggerEvidenceRefs: ["{evidence}"],
    affectedScopeIds: [],
    loadedPath: null,
    blockerOwner: null,
  }));
  input.discoveryContext = contract(discovery);
  const options = optionsObject(catalogDigest);
  options.rules = [];
  input.architectureOptions = contract(options);
  const architecture = architectureObject("awaiting_selection", catalogDigest);
  architecture.packs = architecture.packs.map((pack) => ({
    ...pack,
    status: "not_applicable" as const,
    ruleIds: [],
  }));
  input.architectureIndex = contract(architecture);
  assertIssue(input, "CONTRACT_SCHEMA_INVALID");

  for (const unresolved of [
    "TBD",
    "None",
    "Pending confirmation",
    "Not provided",
    "[evidence]",
    "**TBD**",
    "`TBD`",
    "~~None~~",
    "[TBD](https://example.invalid)",
    "evidence",
    "source",
    "reference",
    "ref",
  ]) {
    const unresolvedInput = checkpointInput("greenfield");
    const unresolvedDiscovery = discoveryObject("greenfield", inputDigest(unresolvedInput));
    unresolvedDiscovery.packs[0]!.triggerEvidenceRefs = [unresolved];
    unresolvedInput.discoveryContext = contract(unresolvedDiscovery);
    assertIssue(unresolvedInput, "CONTRACT_SCHEMA_INVALID");
  }
});

test("the machine block rejects duplicate JSON keys and unknown fields", () => {
  const input = checkpointInput("greenfield");
  input.architectureOptions = [
    "<!-- ai-sdlc:architecture-rulebook:v1 -->",
    "```json",
    '{"schemaVersion":1,"schemaVersion":1,"document":"options","rules":[]}',
    "```",
  ].join("\n");
  assertIssue(input, "CONTRACT_JSON_INVALID");

  const unknown = checkpointInput("greenfield");
  unknown.architectureOptions = contract({ ...optionsObject(inputDigest(unknown)), unknown: true });
  assertIssue(unknown, "CONTRACT_SCHEMA_INVALID");

  const trailingComma = checkpointInput("greenfield");
  const trailingJson = JSON.stringify(optionsObject(inputDigest(trailingComma)), null, 2)
    .replace(/\n\}$/u, ",\n}");
  trailingComma.architectureOptions = [
    "<!-- ai-sdlc:architecture-rulebook:v1 -->",
    "```json",
    trailingJson,
    "```",
  ].join("\n");
  assertIssue(trailingComma, "CONTRACT_JSON_INVALID");

  const comment = checkpointInput("greenfield");
  comment.architectureOptions = contract(optionsObject(inputDigest(comment)))
    .replace("{\n", "{\n  # YAML comments are not canonical JSON\n");
  assertIssue(comment, "CONTRACT_JSON_INVALID");
});

test("a complete final contract closes every applicable rule exactly once", () => {
  const input = finalInput("greenfield");
  assert.equal(validateArchitectureRulebook(input).issues.length, 0);
});

test("final dispositions cannot silently change a reviewed Options trigger state", () => {
  const selectedConstraint = finalInput("greenfield");
  const selectedConstraintPatterns = patternsObject("greenfield", inputDigest(selectedConstraint));
  selectedConstraintPatterns.dispositions.find((item) => item.ruleId === "API-001")!.state = "not_triggered";
  selectedConstraint.architecturePatterns = contract(selectedConstraintPatterns);
  assertIssue(selectedConstraint, "RULE_TRIGGER_CHANGED_RESELECTION_REQUIRED");

  const newlyTriggered = finalInput("greenfield");
  const newlyTriggeredOptions = optionsObject(inputDigest(newlyTriggered));
  const dormantApiRule = newlyTriggeredOptions.rules.find((item) => item.ruleId === "API-001")!;
  dormantApiRule.state = "not_triggered";
  dormantApiRule.affectedOptionIds = [];
  newlyTriggered.architectureOptions = contract(newlyTriggeredOptions);
  assertIssue(newlyTriggered, "RULE_TRIGGER_CHANGED_RESELECTION_REQUIRED");
});

test("final dispositions preserve consistent and non-selected Options trigger states", () => {
  const consistentlyDormant = finalInput("greenfield");
  const dormantOptions = optionsObject(inputDigest(consistentlyDormant));
  const dormantApiRule = dormantOptions.rules.find((item) => item.ruleId === "API-001")!;
  dormantApiRule.state = "not_triggered";
  dormantApiRule.affectedOptionIds = [];
  consistentlyDormant.architectureOptions = contract(dormantOptions);
  const dormantPatterns = patternsObject("greenfield", inputDigest(consistentlyDormant));
  dormantPatterns.dispositions.find((item) => item.ruleId === "API-001")!.state = "not_triggered";
  consistentlyDormant.architecturePatterns = contract(dormantPatterns);
  assert.equal(validateArchitectureRulebook(consistentlyDormant).issues.length, 0);

  const affectsAnotherOption = finalInput("greenfield");
  const otherOptionRules = optionsObject(inputDigest(affectsAnotherOption));
  otherOptionRules.rules.find((item) => item.ruleId === "API-001")!.affectedOptionIds = ["B"];
  affectsAnotherOption.architectureOptions = contract(otherOptionRules);
  const otherOptionPatterns = patternsObject("greenfield", inputDigest(affectsAnotherOption));
  otherOptionPatterns.dispositions.find((item) => item.ruleId === "API-001")!.state = "not_triggered";
  affectsAnotherOption.architecturePatterns = contract(otherOptionPatterns);
  assert.equal(validateArchitectureRulebook(affectsAnotherOption).issues.length, 0);
});

test("a rulebook change invalidates the reviewed checkpoint digest", () => {
  const input = checkpointInput("greenfield");
  input.rulebook = {
    ...input.rulebook!,
    packMarkdownByPath: {
      ...input.rulebook!.packMarkdownByPath,
      "rules/api.md": `${input.rulebook!.packMarkdownByPath["rules/api.md"]}\nChanged rule meaning.`,
    },
  };
  assertIssue(input, "RULEBOOK_DIGEST_MISMATCH");
});

test("configured project mode participates in the digest and must match Discovery", () => {
  const auto = rulebookSource();
  const brownfield = { ...rulebookSource(), projectMode: "brownfield" as const };
  assert.notEqual(
    calculateArchitectureRulebookDigest(auto),
    calculateArchitectureRulebookDigest(brownfield),
  );
  const catalogDigest = calculateArchitectureRulebookDigest(brownfield);
  const input: ArchitectureRulebookValidationInput = {
    validation: "required",
    stage: "checkpoint",
    rulebook: brownfield,
    discoveryContext: contract(discoveryObject("greenfield", catalogDigest)),
    architectureOptions: contract(optionsObject(catalogDigest)),
    architectureIndex: contract(architectureObject("awaiting_selection", catalogDigest)),
    documentedOptionIds: ["A", "B", "C"],
  };
  assertIssue(input, "PROJECT_MODE_MISMATCH");
});

test("final contract is bound to the exact platform selection evidence", () => {
  const input = finalInput("greenfield");
  input.architectureSelection = { ...selectionEvidence, optionId: "B" };
  assertIssue(input, "ARCHITECTURE_SELECTION_MISMATCH");

  const patternsMismatch = finalInput("greenfield");
  const patterns = patternsObject("greenfield", inputDigest(patternsMismatch));
  patterns.selection = { ...selectionEvidence, optionId: "B" };
  patternsMismatch.architecturePatterns = contract(patterns);
  assertIssue(patternsMismatch, "PATTERNS_SELECTION_MISMATCH");

  const artifactMismatch = finalInput("greenfield");
  artifactMismatch.architectureNfrs = artifactMismatch.architectureNfrs?.replace(
    '"optionId":"A"',
    '"optionId":"B"',
  );
  assertIssue(artifactMismatch, "SELECTION_MARKER_MISMATCH");
});

test("Hybrid final validation requires every applicable rule on every affected scope", () => {
  const input = hybridFinalInput();
  assert.equal(validateArchitectureRulebook(input).issues.length, 0);

  const incomplete = hybridFinalInput();
  const patterns = hybridPatternsObject(inputDigest(incomplete));
  patterns.dispositions = patterns.dispositions.filter(
    (item) => !(item.ruleId === "API-001" && item.scopeId === "legacy-web"),
  );
  incomplete.architecturePatterns = contract(patterns);
  assertIssue(incomplete, "DISPOSITION_MISSING");
});

test("final validation blocks missing dispositions and unapproved exceptions", () => {
  const missing = finalInput("greenfield");
  const patterns = patternsObject("greenfield", inputDigest(missing));
  patterns.dispositions = patterns.dispositions.filter((item) => item.ruleId !== "SEC-001");
  missing.architecturePatterns = contract(patterns);
  assertIssue(missing, "DISPOSITION_MISSING");

  const exception = finalInput("greenfield");
  const exceptionPatterns = patternsObject("greenfield", inputDigest(exception));
  const api = exceptionPatterns.dispositions.find((item) => item.ruleId === "API-001")!;
  api.state = "exception";
  api.decisionRef = "ADR-001";
  exception.architecturePatterns = contract(exceptionPatterns);
  const architecture = architectureObject("ready_for_human_acceptance", inputDigest(exception));
  architecture.packs.find((pack) => pack.id === "api")!.exceptionRuleIds = ["API-001"];
  exception.architectureIndex = contract(architecture);
  assertIssue(exception, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("a rule exception needs an existing accepted ADR with human evidence", () => {
  const input = finalInput("greenfield");
  const patterns = patternsObject("greenfield", inputDigest(input));
  const api = patterns.dispositions.find((item) => item.ruleId === "API-001")!;
  api.state = "exception";
  api.decisionRef = "accepted-adr:ADR-001";
  input.architecturePatterns = contract(patterns);
  const architecture = architectureObject("ready_for_human_acceptance", inputDigest(input));
  architecture.packs.find((pack) => pack.id === "api")!.exceptionRuleIds = ["API-001"];
  input.architectureIndex = contract(architecture);
  setAdrFiles(input, [{
    relativePath: "ADR-001-api-exception.md",
    content: [
    "# ADR-001: Permit the API exception",
    "",
    "**Status:** Accepted",
    "**Related architecture rules:** API-001",
    "**Related scopes:** web-app",
    "**Rule effect:** Deviates from",
    "",
    "## Context",
    "",
    "The selected API needs a documented exception.",
    "",
    "## Human Approval",
    "",
    "**Approved by:** Architecture owner",
    "**Approval evidence:** review-123",
    "",
    ].join("\n"),
  }]);
  input.architectureAdrsRevisionSource = "human";
  assert.equal(validateArchitectureRulebook(input).issues.length, 0);

  const wrongScope = structuredClone(input);
  wrongScope.architectureAdrFiles = wrongScope.architectureAdrFiles?.map((file) => ({
    ...file,
    content: file.content.replace("**Related scopes:** web-app", "**Related scopes:** another-scope"),
  }));
  assertIssue(wrongScope, "DISPOSITION_EXCEPTION_UNAPPROVED");

  input.architectureAdrsRevisionSource = "ai";
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("ADR approval cannot borrow metadata from another aggregated file", () => {
  const input = finalInputWithApiException();
  setAdrFiles(input, [
    {
      relativePath: "ADR-001-api-exception.md",
      content: [
        "# ADR-001: Permit the API exception",
        "",
        "**Status:** Accepted",
        "**Related architecture rules:** API-001",
        "**Related scopes:** web-app",
        "**Rule effect:** Deviates from",
        "",
        "## Human Approval",
        "",
        "**Approved by:** Architecture owner",
      ].join("\n"),
    },
    {
      relativePath: "README.md",
      content: ["# Approval notes", "", "**Approval evidence:** review-123"].join("\n"),
    },
  ]);
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("an ADR heading and metadata embedded in README is not an ADR file", () => {
  const input = finalInputWithApiException();
  setAdrFiles(input, [{
    relativePath: "README.md",
    content: acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from"),
  }]);
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("aggregate-looking boundaries embedded in 00-selection cannot manufacture an ADR file", () => {
  const input = finalInputWithApiException();
  const fakeAdr = acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from");
  const selectionFile = `${selectionMarker("markdown")}\n\n## ADR-001-api-exception.md\n\n${fakeAdr}`;
  input.architectureAdrFiles = [{ relativePath: "00-selection.md", content: selectionFile }];
  input.architectureAdrs = `## 00-selection.md\n\n${selectionFile}`;
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("a README cannot manufacture the required root 00-selection file", () => {
  const input = finalInput("greenfield");
  input.architectureAdrFiles = [{
    relativePath: "README.md",
    content: `# Notes\n\n## 00-selection.md\n\n${selectionMarker("markdown")}`,
  }];
  assertIssue(input, "SELECTION_MARKER_MISSING");
});

test("ADR metadata inside a fenced code example is not approval evidence", () => {
  const input = finalInputWithApiException();
  setAdrFiles(input, [{
    relativePath: "ADR-001-api-exception.md",
    content: [
    "# ADR-001: Permit the API exception",
    "",
    "**Status:** Accepted",
    "**Related architecture rules:** API-001",
    "**Related scopes:** web-app",
    "**Rule effect:** Deviates from",
    "",
    "## Human Approval",
    "",
    "```markdown",
    "**Approved by:** Architecture owner",
    "**Approval evidence:** review-123",
    "```",
    ].join("\n"),
  }]);
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("hidden HTML cannot supply ADR approval evidence", () => {
  for (const hiddenApproval of [
    [
      "<!--",
      "**Approved by:** Hidden actor",
      "**Approval evidence:** hidden-review",
      "-->",
    ].join("\n"),
    [
      "<div hidden>",
      "**Approved by:** Hidden actor",
      "**Approval evidence:** hidden-review",
      "</div>",
    ].join("\n"),
  ]) {
    const input = finalInputWithApiException();
    setAdrFiles(input, [{
      relativePath: "ADR-001-api-exception.md",
      content: [
        "# ADR-001: Permit the API exception",
        "",
        "**Status:** Accepted",
        "**Related architecture rules:** API-001",
        "**Related scopes:** web-app",
        "**Rule effect:** Deviates from",
        "",
        "## Human Approval",
        "",
        hiddenApproval,
      ].join("\n"),
    }]);
    assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
  }
});

test("a visible Markdown autolink is valid ADR approval evidence", () => {
  const input = finalInputWithApiException();
  input.architectureAdrsRevisionSource = "human";
  setAdrFiles(input, [{
    relativePath: "ADR-001-api-exception.md",
    content: acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from")
      .replace("**Approval evidence:** review-123", "**Approval evidence:** <https://review.example/123>"),
  }]);
  assert.equal(validateArchitectureRulebook(input).issues.length, 0);
});

test("Markdown formatting cannot disguise an unapproved ADR placeholder", () => {
  for (const [approvedBy, approvalEvidence] of [
    ["**Not approved**", "review-123"],
    ["Architecture owner", "`Not provided`"],
    ["~~Not approved~~", "architecture-review-456"],
  ]) {
    const input = finalInputWithApiException();
    input.architectureAdrsRevisionSource = "human";
    setAdrFiles(input, [{
      relativePath: "ADR-001-api-exception.md",
      content: acceptedAdr(
        "ADR-001",
        "API-001",
        "web-app",
        "Deviates from",
        approvedBy,
        approvalEvidence,
      ),
    }]);
    assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
  }
});

test("an accepted ADR id must resolve to exactly one matching ADR file", () => {
  const input = finalInputWithApiException();
  const acceptedBody = acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from");
  setAdrFiles(input, [
    { relativePath: "ADR-001-api-exception.md", content: acceptedBody },
    { relativePath: "nested/ADR-001-duplicate.md", content: acceptedBody },
  ]);
  assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
});

test("runtime ADR loading accepts the normal template approval section", async () => {
  const input = finalInputWithApiException();
  input.architectureAdrsRevisionSource = "human";
  await withActualAdrDirectory([
    { relativePath: "00-selection.md", content: selectionMarker("markdown") },
    {
      relativePath: "ADR-001-api-exception.md",
      content: acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from"),
    },
  ], ({ aggregate, files }) => {
    input.architectureAdrs = aggregate;
    input.architectureAdrFiles = files;
    assert.equal(validateArchitectureRulebook(input).issues.length, 0);
  });
});

test("runtime ADR loading does not trust a fake file boundary embedded in README", async () => {
  const input = finalInputWithApiException();
  input.architectureAdrsRevisionSource = "human";
  const fakeAdr = acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from");
  await withActualAdrDirectory([
    { relativePath: "00-selection.md", content: selectionMarker("markdown") },
    {
      relativePath: "README.md",
      content: `# Examples\n\n## ADR-001-api-exception.md\n\n${fakeAdr}`,
    },
  ], ({ aggregate, files }) => {
    assert.deepEqual(files.map((file) => file.relativePath), ["00-selection.md", "README.md"]);
    input.architectureAdrs = aggregate;
    input.architectureAdrFiles = files;
    assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
  });
});

test("runtime ADR loading rejects a duplicated ADR id across real files", async () => {
  const input = finalInputWithApiException();
  input.architectureAdrsRevisionSource = "human";
  const body = acceptedAdr("ADR-001", "API-001", "web-app", "Deviates from");
  await withActualAdrDirectory([
    { relativePath: "00-selection.md", content: selectionMarker("markdown") },
    { relativePath: "ADR-001-api-exception.md", content: body },
    { relativePath: "nested/ADR-001-duplicate.md", content: body },
  ], ({ aggregate, files }) => {
    input.architectureAdrs = aggregate;
    input.architectureAdrFiles = files;
    assertIssue(input, "DISPOSITION_EXCEPTION_UNAPPROVED");
  });
});

test("only a DEFAULT with Reason allowed may deviate without an ADR", () => {
  const input = finalInput("greenfield");
  const patterns = patternsObject("greenfield", inputDigest(input));
  const api = patterns.dispositions.find((item) => item.ruleId === "API-001")!;
  api.state = "justified_deviation";
  input.architecturePatterns = contract(patterns);
  const architecture = architectureObject("ready_for_human_acceptance", inputDigest(input));
  architecture.packs.find((pack) => pack.id === "api")!.justifiedDeviationRuleIds = ["API-001"];
  input.architectureIndex = contract(architecture);
  assert.equal(validateArchitectureRulebook(input).issues.length, 0);

  const invalid = finalInput("greenfield");
  const invalidPatterns = patternsObject("greenfield", inputDigest(invalid));
  invalidPatterns.dispositions.find((item) => item.ruleId === "FE-002")!.state = "justified_deviation";
  invalid.architecturePatterns = contract(invalidPatterns);
  const invalidArchitecture = architectureObject("ready_for_human_acceptance", inputDigest(invalid));
  invalidArchitecture.packs.find((pack) => pack.id === "frontend")!.justifiedDeviationRuleIds = ["FE-002"];
  invalid.architectureIndex = contract(invalidArchitecture);
  assertIssue(invalid, "DISPOSITION_DEVIATION_POLICY_INVALID");
});

test("Greenfield frontend defaults cannot be forced onto a Brownfield scope", () => {
  const input = finalInput("brownfield");
  assertIssue(input, "BROWNFIELD_DEFAULT_FORCED");

  const compatible = finalInput("brownfield");
  const compatibleOptions = optionsObject(inputDigest(compatible));
  const compatibleFrontendRule = compatibleOptions.rules.find((item) => item.ruleId === "FE-002")!;
  compatibleFrontendRule.state = "not_triggered";
  compatibleFrontendRule.affectedOptionIds = [];
  compatible.architectureOptions = contract(compatibleOptions);
  const patterns = patternsObject("brownfield", inputDigest(compatible));
  const frontend = patterns.dispositions.find((item) => item.ruleId === "FE-002")!;
  frontend.state = "not_triggered";
  compatible.architecturePatterns = contract(patterns);
  assert.equal(validateArchitectureRulebook(compatible).issues.length, 0);

  const migrated = finalInput("brownfield");
  const migrationPatterns = patternsObject("brownfield", inputDigest(migrated));
  const migration = migrationPatterns.dispositions.find((item) => item.ruleId === "FE-002")!;
  migration.decisionRef = "accepted-adr:ADR-002";
  migrated.architecturePatterns = contract(migrationPatterns);
  migrated.architectureAdrsRevisionSource = "human";
  setAdrFiles(migrated, [{
    relativePath: "ADR-002-frontend-migration.md",
    content: acceptedAdr("ADR-002", "FE-002", "web-app", "Implements", "Frontend owner", "architecture-review-456"),
  }]);
  assert.equal(validateArchitectureRulebook(migrated).issues.length, 0);
});

function finalInputWithApiException(): ArchitectureRulebookValidationInput {
  const input = finalInput("greenfield");
  const patterns = patternsObject("greenfield", inputDigest(input));
  const api = patterns.dispositions.find((item) => item.ruleId === "API-001")!;
  api.state = "exception";
  api.decisionRef = "accepted-adr:ADR-001";
  input.architecturePatterns = contract(patterns);
  const architecture = architectureObject("ready_for_human_acceptance", inputDigest(input));
  architecture.packs.find((pack) => pack.id === "api")!.exceptionRuleIds = ["API-001"];
  input.architectureIndex = contract(architecture);
  input.architectureAdrsRevisionSource = "human";
  return input;
}

function checkpointInput(mode: "greenfield" | "brownfield"): ArchitectureRulebookValidationInput {
  const rulebook = rulebookSource();
  const catalogDigest = calculateArchitectureRulebookDigest(rulebook);
  return {
    validation: "required",
    stage: "checkpoint",
    rulebook,
    discoveryContext: contract(discoveryObject(mode, catalogDigest)),
    architectureOptions: contract(optionsObject(catalogDigest)),
    architectureIndex: contract(architectureObject("awaiting_selection", catalogDigest)),
    documentedOptionIds: ["A", "B", "C"],
  };
}

function finalInput(mode: "greenfield" | "brownfield"): ArchitectureRulebookValidationInput {
  const input = checkpointInput(mode);
  const catalogDigest = calculateArchitectureRulebookDigest(input.rulebook!);
  return {
    ...input,
    stage: "final",
    architectureIndex: contract(architectureObject("ready_for_human_acceptance", catalogDigest)),
    architecturePatterns: contract(patternsObject(mode, catalogDigest)),
    architectureSelection: selectionEvidence,
    ...selectionBoundArtifacts(),
  };
}

function hybridFinalInput(): ArchitectureRulebookValidationInput {
  const rulebook = { ...rulebookSource(), projectMode: "hybrid" as const };
  const catalogDigest = calculateArchitectureRulebookDigest(rulebook);
  return {
    validation: "required",
    stage: "final",
    rulebook,
    discoveryContext: contract(hybridDiscoveryObject(catalogDigest)),
    architectureOptions: contract(optionsObject(catalogDigest)),
    architectureIndex: contract(architectureObject("ready_for_human_acceptance", catalogDigest)),
    architecturePatterns: contract(hybridPatternsObject(catalogDigest)),
    documentedOptionIds: ["A", "B", "C"],
    architectureSelection: selectionEvidence,
    ...selectionBoundArtifacts(),
  };
}

function rulebookSource() {
  return {
    projectMode: "auto" as const,
    indexMarkdown: [
      "[core rules](rules/core.md)",
      ...architectureRulePackIds.map((id) => `[${id} rules](rules/${id}.md)`),
    ].join("\n"),
    packMarkdownByPath: {
      "rules/core.md": "# Core rules\n",
      ...Object.fromEntries(architectureRulePackIds.map((id) => [
        `rules/${id}.md`,
        [
          "| ID | Level | Deviation | Trigger | Requirement | Required evidence |",
          "|----|-------|-----------|---------|-------------|-------------------|",
          `| \`${ruleIds[id]}\` | \`${id === "api" || id === "frontend" ? "DEFAULT" : "MUST"}\` | \`${id === "api" ? "Reason allowed" : id === "frontend" ? "ADR required" : "N/A"}\` | trigger | rule | evidence |`,
        ].join("\n"),
      ])),
    },
  };
}

function discoveryObject(mode: "greenfield" | "brownfield", catalogDigest: string) {
  return {
    schemaVersion: 1,
    document: "discovery",
    catalogDigest,
    scopes: [{
      id: "web-app",
      mode,
      boundary: mode === "greenfield" ? "new" : "existing",
      evidenceRefs: ["package manifest"],
    }],
    packs: architectureRulePackIds.map((id) => ({
      id,
      status: "applicable",
      triggerEvidenceRefs: [`${id} trigger`],
      affectedScopeIds: ["web-app"],
      loadedPath: `rules/${id}.md`,
      blockerOwner: null,
    })),
  };
}

function hybridDiscoveryObject(catalogDigest: string) {
  return {
    schemaVersion: 1,
    document: "discovery",
    catalogDigest,
    scopes: [
      {
        id: "legacy-web",
        mode: "hybrid",
        boundary: "existing",
        evidenceRefs: ["packages/legacy-web/package.json"],
      },
      {
        id: "new-web-boundary",
        mode: "hybrid",
        boundary: "new",
        evidenceRefs: ["approved isolated frontend scope"],
      },
    ],
    packs: architectureRulePackIds.map((id) => ({
      id,
      status: "applicable",
      triggerEvidenceRefs: [`${id} hybrid trigger`],
      affectedScopeIds: id === "frontend" ? ["new-web-boundary"] : ["legacy-web", "new-web-boundary"],
      loadedPath: `rules/${id}.md`,
      blockerOwner: null,
    })),
  };
}

function optionsObject(catalogDigest: string) {
  return {
    schemaVersion: 1,
    document: "options",
    catalogDigest,
    rules: architectureRulePackIds.map((id) => ({
      ruleId: ruleIds[id],
      state: "constrains",
      affectedOptionIds: ["A", "B", "C"],
      evidenceRefs: [`${id} option comparison`],
    })),
  };
}

function architectureObject(
  state: "awaiting_selection" | "ready_for_human_acceptance",
  catalogDigest: string,
) {
  return {
    schemaVersion: 1,
    document: "architecture",
    catalogDigest,
    state,
    selection: state === "awaiting_selection" ? null : selectionEvidence,
    packs: architectureRulePackIds.map((id) => ({
      id,
      status: "applicable",
      ruleIds: [ruleIds[id]],
      justifiedDeviationRuleIds: [],
      exceptionRuleIds: [],
      blockedRuleIds: [],
    })),
  };
}

function patternsObject(mode: "greenfield" | "brownfield", catalogDigest: string) {
  return {
    schemaVersion: 1,
    document: "patterns",
    catalogDigest,
    selection: selectionEvidence,
    dispositions: architectureRulePackIds.map((id) => ({
      ruleId: ruleIds[id],
      scopeId: "web-app",
      state: id === "frontend" && mode === "brownfield" ? "satisfied" : "satisfied",
      evidenceRefs: [`${id} implementation evidence`],
      decisionRef: null,
    })),
  };
}

function hybridPatternsObject(catalogDigest: string) {
  return {
    schemaVersion: 1,
    document: "patterns",
    catalogDigest,
    selection: selectionEvidence,
    dispositions: architectureRulePackIds.flatMap((id) => (
      id === "frontend" ? ["new-web-boundary"] : ["legacy-web", "new-web-boundary"]
    ).map((scopeId) => ({
      ruleId: ruleIds[id],
      scopeId,
      state: "satisfied",
      evidenceRefs: [`${id} evidence for ${scopeId}`],
      decisionRef: null,
    }))),
  };
}

function contract(value: unknown): string {
  return [
    "<!-- ai-sdlc:architecture-rulebook:v1 -->",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
  ].join("\n");
}

function selectionBoundArtifacts() {
  const selectionContent = selectionMarker("markdown");
  return {
    architectureC4Context: selectionMarker("mermaid"),
    architectureC4Containers: selectionMarker("mermaid"),
    architectureAdrs: `## 00-selection.md\n\n${selectionContent}`,
    architectureAdrFiles: [{ relativePath: "00-selection.md", content: selectionContent }],
    architectureAdrsRevisionSource: "ai" as const,
    architectureNfrs: selectionMarker("markdown"),
    architectureAdversarial: selectionMarker("markdown"),
  };
}

function setAdrFiles(
  input: ArchitectureRulebookValidationInput,
  additionalFiles: Array<{ relativePath: string; content: string }>,
): void {
  const files = [
    { relativePath: "00-selection.md", content: selectionMarker("markdown") },
    ...additionalFiles,
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  input.architectureAdrFiles = files;
  input.architectureAdrs = files
    .map((file) => `## ${file.relativePath}\n\n${file.content}`)
    .join("\n\n");
}

function acceptedAdr(
  adrId: string,
  ruleId: string,
  scopeId: string,
  effect: string,
  approvedBy = "Architecture owner",
  approvalEvidence = "review-123",
): string {
  return [
    `# ${adrId}: Approved architecture decision`,
    "",
    "**Status:** Accepted",
    `**Related architecture rules:** ${ruleId}`,
    `**Related scopes:** ${scopeId}`,
    `**Rule effect:** ${effect}`,
    "",
    "## Context",
    "",
    "This decision applies to the selected architecture.",
    "",
    "## Human Approval",
    "",
    `**Approved by:** ${approvedBy}`,
    `**Approval evidence:** ${approvalEvidence}`,
    "",
  ].join("\n");
}

async function withActualAdrDirectory(
  files: Array<{ relativePath: string; content: string }>,
  operation: (loaded: {
    aggregate: string;
    files: Array<{ relativePath: string; content: string }>;
  }) => void | Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-real-adrs-"));
  const relativeDirectory = "docs/ai-native/architecture/04-adrs";
  const directory = path.join(projectRoot, relativeDirectory);
  try {
    await mkdir(directory, { recursive: true });
    for (const file of files) {
      const target = path.join(directory, ...file.relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const aggregate = await readArtifactContent(directory, 2_000_000);
    const loaded = await readArchitectureAdrFiles(projectRoot, {
      content: aggregate,
      filePath: relativeDirectory,
    });
    await operation({ aggregate, files: loaded });
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function selectionMarker(style: "markdown" | "mermaid"): string {
  const json = JSON.stringify(selectionEvidence);
  return style === "mermaid"
    ? `%% ai-sdlc:architecture-selection:v1 ${json}`
    : `<!-- ai-sdlc:architecture-selection:v1 ${json} -->`;
}

function inputDigest(input: ArchitectureRulebookValidationInput): string {
  return calculateArchitectureRulebookDigest(input.rulebook!);
}

function assertIssue(input: ArchitectureRulebookValidationInput, code: string): void {
  assert.throws(
    () => validateArchitectureRulebook(input),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "ARCHITECTURE_RULEBOOK_INVALID");
      const issues = (error.details as { issues: Array<{ code: string }> }).issues;
      assert.ok(issues.some((issue) => issue.code === code), JSON.stringify(issues, null, 2));
      return true;
    },
  );
}
