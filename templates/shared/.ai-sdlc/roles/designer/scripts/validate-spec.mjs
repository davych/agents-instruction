#!/usr/bin/env node
/* global console, process */

import fs from "node:fs";
import path from "node:path";
import { loadComponentCatalog } from "./component-query.mjs";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const fileArg = args.find((arg) => arg !== "--json");
const deferredEvidenceTypes = new Set([
  "browser-run",
  "screenshot",
  "keyboard-log",
  "accessibility-report",
  "contrast-report",
  "motion-evidence",
]);

if (!fileArg) {
  console.error("Usage: validate-spec.mjs [--json] <SPEC.md>");
  process.exit(2);
}

const file = path.resolve(fileArg);
if (!fs.existsSync(file)) {
  console.error(`SPEC does not exist: ${file}`);
  process.exit(2);
}

const source = fs.readFileSync(file, "utf8");
const lines = source.split(/\r?\n/u);
const block = /^\s*```json\s*([\s\S]*?)```/iu.exec(source);
const results = [];
const failures = [];
const lineOf = (needle) => Math.max(1, lines.findIndex((line) => line.includes(String(needle))) + 1);
const fail = (id, detail, needle = "```json") => failures.push({
  id,
  status: "FAIL",
  detail,
  line: lineOf(needle)
});
const pass = (id, detail) => results.push({ id, status: "PASS", detail });

let spec;
if (!block) {
  fail("SCHEMA", "SPEC must start with a machine-readable ```json block.");
} else {
  try {
    spec = JSON.parse(block[1]);
  } catch (error) {
    fail("SCHEMA", `Invalid machine JSON: ${error.message}`);
  }
}

if (spec) {
  const markdownBody = source.slice(block.index + block[0].length);
  validateSchema(spec);
  await validateComponents(spec);
  validateStates(spec);
  validateAcceptanceCriteria(spec, markdownBody);
  validateHandoff(spec, markdownBody);
}

function validateSchema(value) {
  if (String(value.spec_version ?? "") !== "1.0") {
    fail("SCHEMA", "spec_version must be 1.0.", "spec_version");
  }
  for (const key of ["title", "mode", "status", "source"]) {
    if (value[key] === undefined || value[key] === "") fail("SCHEMA", `Missing ${key}.`, key);
  }
  if (!["new", "change"].includes(value.mode)) fail("SCHEMA", "mode must be new or change.", "mode");
  if (!["draft", "blocked", "ready-for-engineering"].includes(value.status)) {
    fail("SCHEMA", "status must be draft, blocked, or ready-for-engineering.", "status");
  }
  if (value.mode === "change" && !value.extends) fail("SCHEMA", "A change SPEC must declare extends.", "mode");
  if (!Array.isArray(value.source)) fail("SCHEMA", "source must be an array.", "source");
  if (value.framework !== undefined && typeof value.framework !== "string") {
    fail("SCHEMA", "framework must be a string when present.", "framework");
  }
  if (!Array.isArray(value.screens) || !value.screens.length) {
    fail("SCHEMA", "screens must contain at least one screen.", "screens");
  }
  if (!Array.isArray(value.components)) fail("SCHEMA", "components must be an array.", "components");
  if (!Array.isArray(value.acceptance_criteria)) {
    fail("SCHEMA", "acceptance_criteria must be an array.", "acceptance_criteria");
  }
  if (!Array.isArray(value.blockers)) {
    fail("SCHEMA", "blockers must be an array.", "blockers");
  } else if (value.status === "ready-for-engineering" && value.blockers.length) {
    fail("SCHEMA", "ready-for-engineering requires an empty blockers array.", "blockers");
  } else if (value.status === "blocked" && !value.blockers.length) {
    fail("SCHEMA", "blocked requires at least one blocker.", "blockers");
  }
  validateDeferredValidations(value);
  if (!failures.some((item) => item.id === "SCHEMA")) pass("SCHEMA", "SPEC structure is valid.");
}

function validateDeferredValidations(value) {
  if (!Array.isArray(value.deferred_validations)) {
    fail("SCHEMA", "deferred_validations must be an array.", "deferred_validations");
    return;
  }
  const blockerIds = new Set((Array.isArray(value.blockers) ? value.blockers : [])
    .map((blocker) => {
      if (blocker && typeof blocker === "object" && !Array.isArray(blocker)) {
        return String(blocker.id ?? "").trim().toUpperCase();
      }
      return /^\s*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\b/u.exec(String(blocker))?.[1]?.toUpperCase() ?? "";
    })
    .filter(Boolean));
  const seen = new Set();
  for (const validation of value.deferred_validations) {
    if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
      fail("SCHEMA", "Every deferred validation must be an object.", "deferred_validations");
      continue;
    }
    const id = String(validation.id ?? "").trim();
    const normalizedId = id.toUpperCase();
    if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(normalizedId)) {
      fail("SCHEMA", "Every deferred validation needs a stable ID such as B-04 or DES-VERIFY-01.", "deferred_validations");
    } else if (seen.has(normalizedId)) {
      fail("SCHEMA", `Duplicate deferred validation ${id}.`, id);
    } else {
      seen.add(normalizedId);
    }
    if (blockerIds.has(normalizedId)) {
      fail("SCHEMA", `${id} cannot appear in both blockers and deferred_validations.`, id);
    }
    if (String(validation.owner ?? "").trim().toLowerCase() !== "tester") {
      fail("SCHEMA", `${id || "Deferred validation"} must use owner tester.`, id || "deferred_validations");
    }
    if (String(validation.phase ?? "").trim().toLowerCase() !== "verification") {
      fail("SCHEMA", `${id || "Deferred validation"} must use phase verification.`, id || "deferred_validations");
    }
    if (String(validation.status ?? "").trim().toLowerCase() !== "deferred") {
      fail("SCHEMA", `${id || "Deferred validation"} must use status deferred.`, id || "deferred_validations");
    }
    if (String(validation.on_fail ?? "").trim().toLowerCase() !== "block_verification") {
      fail("SCHEMA", `${id || "Deferred validation"} must use on_fail block_verification.`, id || "deferred_validations");
    }
    if (String(validation.on_missing ?? "").trim().toLowerCase() !== "block_verification") {
      fail("SCHEMA", `${id || "Deferred validation"} must use on_missing block_verification.`, id || "deferred_validations");
    }
    for (const field of ["prerequisite", "pass_criteria", "evidence_required", "release_impact"]) {
      if (!meaningfulContractText(validation[field])) {
        fail("SCHEMA", `${id || "Deferred validation"} needs ${field}.`, id || "deferred_validations");
      }
    }
    if (
      meaningfulContractText(validation.release_impact)
      && !meaningfulReleaseImpact(validation.release_impact)
    ) {
      fail("SCHEMA", `${id || "Deferred validation"} release_impact must state the Verification or Release consequence.`, id || "deferred_validations");
    }
    if (
      meaningfulContractText(validation.prerequisite)
      && (
        negatesRunnableImplementationPrerequisite(validation.prerequisite)
        || indicatesCurrentVerificationIsAvailable(validation.prerequisite)
        || !/(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,32}(?:完成|落地|可运行|可用|就绪|部署)|\b(?:runnable|running|completed?|implemented|deployed|available|ready)\b[- ]?(?:implementation|code|application|app|page|feature|build)\b|\b(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,24}\b(?:runnable|running|completed?|implemented|deployed|available|ready)\b|post[- ]implementation/iu.test(validation.prerequisite)
      )
    ) {
      fail("SCHEMA", `${id || "Deferred validation"} prerequisite must explicitly require a runnable implementation.`, id || "deferred_validations");
    }
    for (const field of ["targets", "checks"]) {
      if (
        !Array.isArray(validation[field])
        || !validation[field].length
        || validation[field].some((entry) => !meaningfulContractText(entry))
      ) {
        fail("SCHEMA", `${id || "Deferred validation"} needs non-empty ${field}.`, id || "deferred_validations");
      }
    }
    if (
      !Array.isArray(validation.evidence_types)
      || !validation.evidence_types.length
      || new Set(validation.evidence_types).size !== validation.evidence_types.length
      || validation.evidence_types.some((type) => !deferredEvidenceTypes.has(type))
    ) {
      fail("SCHEMA", `${id || "Deferred validation"} needs unique supported evidence_types.`, id || "deferred_validations");
    }
  }
}

function meaningfulContractText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length >= 3
    && /[\p{L}\p{N}]/u.test(text)
    && !/^(?:n\/?a|none|tbd|todo|unknown|<.*>|\{\{.*\}\})[.!]?$/iu.test(text)
    && !/\b(?:tbd|todo|placeholder|fill\s+in\s+later|evidence\s+pending)\b|(?:待补|占位|稍后补)/iu.test(text)
    && !/^(?:not\s+applicable|none\s+needed|no\s+(?:target|check|pass\s+criteri(?:on|a)|evidence|result)s?\s+(?:is\s+|are\s+)?required|不适用|(?:无需|不需要)(?:目标|检查|通过标准|证据|结果)(?:要求)?)[.!。]?$/iu.test(text);
}

function negatesRunnableImplementationPrerequisite(value) {
  return /(?:do\s+not|don['’]?t|does\s+not|doesn['’]?t|need\s+not|no\s+need\s+to|without)\b[^.;\n]{0,48}\b(?:wait|implementation|code|application|app|page|feature|build|ready|runnable|complete)/iu.test(value)
    || /\b(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,24}\b(?:unavailable|not\s+(?:ready|runnable|running|complete|completed|available)|never\s+(?:ready|runnable|running|complete|completed|available)|incomplete)\b/iu.test(value)
    || /\b(?:ready|runnable|running|complete|completed|available)\b[^.;\n]{0,16}\b(?:is|are)\s+(?:not\s+required|optional)\b/iu.test(value)
    || /(?:无需|不必|不要|不用)[^。；;\n]{0,24}(?:等待)?[^。；;\n]{0,16}(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,16}(?:完成|可运行|可用|就绪)?/iu.test(value)
    || /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,12}(?:尚未|未|不|无需|不必)[^。；;\n]{0,8}(?:完成|可运行|可用|就绪)/iu.test(value);
}

function indicatesCurrentVerificationIsAvailable(value) {
  const currentIndex = firstMatchIndex(value, [
    /(?:现在|立即|当下)[^。；;\n]{0,32}(?:验证|测试|检查|使用)/iu,
    /(?:现有|当前|已有)(?:的)?(?:原型|设计稿|产品|页面|应用)[^。；;\n]{0,32}(?:可|能够|用于|验证|测试|检查)/iu,
    /\b(?:now|immediately|currently)\b[^.;\n]{0,40}\b(?:verify|validate|test|check|use)\b/iu,
    /\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b[^.;\n]{0,40}\b(?:verify|validate|test|check|available|usable)\b/iu,
    /\b(?:verify|validate|test|check|use)\b[^.;\n]{0,48}\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b[^.;\n]{0,24}\b(?:now|immediately|currently)\b/iu,
  ]);
  if (currentIndex < 0) return false;
  const futurePrerequisiteIndex = firstMatchIndex(value, [
    /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,32}(?:完成(?:后)?|落地(?:后)?|可运行(?:后)?|可用(?:后)?|就绪(?:后)?|部署(?:后)?)/iu,
    /(?:after|once|when)\s+(?:the\s+)?(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,32}\b(?:complete|implemented|runnable|running|available|ready|deployed)\b/iu,
    /post[- ]implementation/iu,
  ]);
  return futurePrerequisiteIndex < 0 || currentIndex < futurePrerequisiteIndex;
}

function firstMatchIndex(value, patterns) {
  const indexes = patterns
    .map((pattern) => pattern.exec(value)?.index ?? -1)
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function meaningfulReleaseImpact(value) {
  if (/\b(?:(?:does?|will|would|must|should)\s+not|doesn['’]?t|won['’]?t)\s+(?:block|prevent|affect)\b|\bunaffected\b|\b(?:informational|advisory)\s+only\b|(?:不会|不影响|不阻止|无需阻止|仅供参考)/iu.test(value)) return false;
  const failure = /\b(?:fail(?:ure|ed)?|missing|absent|blocked|untested|incomplete)\b|(?:失败|缺失|未通过|未验证|阻塞)/iu.test(value);
  const consequence = /\b(?:block(?:s|ed|ing)?|prevent(?:s|ed|ing)?|cannot|must\s+not|not\s+eligible)\b|(?:阻止|不能通过|不得|不可|不予)/iu.test(value);
  const gate = /\b(?:verification|release|approval|ship(?:ping)?|launch)\b|(?:验证|发布|放行|上线|批准)/iu.test(value);
  return failure && consequence && gate;
}

async function validateComponents(value) {
  const declared = Array.isArray(value.components) ? value.components : [];
  const catalogBacked = declared.filter((component) =>
    component && typeof component === "object" && ["project", "library"].includes(component.source)
  );
  let catalog = { configured: false, components: [] };

  if (catalogBacked.length) {
    try {
      catalog = await loadComponentCatalog();
    } catch (error) {
      fail("COMPONENTS", `Component catalog failed: ${error.message}`, "components");
      return;
    }
    if (!catalog.configured) {
      fail("COMPONENTS", "Component catalog is not configured; project or library components cannot be verified.", "components");
      return;
    }
  }

  const byName = new Map();
  for (const component of catalog.components ?? []) {
    for (const name of [component.name, ...(component.aliases ?? [])]) {
      byName.set(String(name).toLowerCase(), component);
    }
  }

  for (const component of declared) {
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      fail("COMPONENTS", "Every component must be an object.", "components");
      continue;
    }
    if (!component.name) {
      fail("COMPONENTS", "Component is missing name.", "components");
      continue;
    }
    if (!["project", "library", "custom"].includes(component.source)) {
      fail("COMPONENTS", `${component.name} has unsupported source ${component.source}.`, component.name);
      continue;
    }
    if (component.source === "custom") {
      if (!["feature", "project", "shared"].includes(component.scope)) {
        fail("COMPONENTS", `${component.name} custom component needs scope feature, project, or shared.`, component.name);
      }
      if (typeof component.reason !== "string" || !component.reason.trim()) {
        fail("COMPONENTS", `${component.name} custom component needs a reason.`, component.name);
      }
      continue;
    }

    const known = byName.get(String(component.name).toLowerCase());
    if (!known) {
      fail("COMPONENTS", `Unknown component ${component.name}.`, component.name);
      continue;
    }
    if (value.framework && known.frameworks?.length && !known.frameworks.includes(value.framework)) {
      fail("COMPONENTS", `${component.name} is not verified for framework ${value.framework}.`, component.name);
    }
    validateNamedValues(component.name, "prop", component.props, known.props, fail);
    validateNamedList(component.name, "event", component.events, known.events, fail);
    validateNamedList(component.name, "slot", component.slots, known.slots, fail);
  }

  if (!failures.some((item) => item.id === "COMPONENTS")) {
    pass("COMPONENTS", catalogBacked.length ? "Declared components match the configured catalog." : "Custom or empty component declarations are valid.");
  }
}

function validateNamedValues(componentName, kind, declared = {}, known = [], report) {
  if (!declared || Array.isArray(declared) || typeof declared !== "object") {
    if (declared !== undefined) report("COMPONENTS", `${componentName} ${kind}s must be an object.`, componentName);
    return;
  }
  const knownMap = new Map((known ?? []).map((item) => [typeof item === "string" ? item : item.name, item]));
  for (const [name, value] of Object.entries(declared)) {
    const definition = knownMap.get(name);
    if (!definition) {
      report("COMPONENTS", `${componentName} has no verified ${kind} ${name}.`, componentName);
    } else if (Array.isArray(definition.values) && !definition.values.includes(value)) {
      report("COMPONENTS", `${componentName}.${name}=${value} is not in the verified catalog values.`, componentName);
    }
  }
}

function validateNamedList(componentName, kind, declared, known = [], report) {
  if (declared === undefined) return;
  if (!Array.isArray(declared)) {
    report("COMPONENTS", `${componentName} ${kind}s must be an array.`, componentName);
    return;
  }
  const knownNames = new Set((known ?? []).map((item) => typeof item === "string" ? item : item.name));
  for (const name of declared) {
    if (!knownNames.has(name)) report("COMPONENTS", `${componentName} has no verified ${kind} ${name}.`, componentName);
  }
}

function validateStates(value) {
  const screens = Array.isArray(value.screens) ? value.screens : [];
  for (const screen of screens) {
    if (!screen || typeof screen !== "object" || Array.isArray(screen)) {
      fail("STATES", "Every screen must be an object.", "screens");
      continue;
    }
    if (!screen.id) fail("STATES", "Screen is missing id.", "screens");
    if (!screen.layout) fail("STATES", `Screen ${screen.id ?? "(unnamed)"} is missing layout.`, screen.id ?? "screens");
    if (!Array.isArray(screen.states) || !screen.states.includes("default")) {
      fail("STATES", `Screen ${screen.id ?? "(unnamed)"} must include the default state.`, screen.id ?? "screens");
    } else if (new Set(screen.states).size !== screen.states.length) {
      fail("STATES", `Screen ${screen.id} has duplicate states.`, screen.id);
    }
  }
  if (!failures.some((item) => item.id === "STATES")) pass("STATES", "Screen layout and state declarations are valid.");
}

function validateAcceptanceCriteria(value, body) {
  const declared = new Set();
  const criteria = Array.isArray(value.acceptance_criteria) ? value.acceptance_criteria : [];
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      fail("TRACEABILITY", "Every acceptance criterion must be an object.", "acceptance_criteria");
      continue;
    }
    if (!criterion.id) {
      fail("TRACEABILITY", "Acceptance criterion is missing id.", "acceptance_criteria");
      continue;
    }
    if (declared.has(criterion.id)) fail("TRACEABILITY", `Duplicate acceptance criterion ${criterion.id}.`, criterion.id);
    declared.add(criterion.id);
    if (!criterion.requirement || !criterion.design_response) {
      fail("TRACEABILITY", `${criterion.id} needs requirement and design_response.`, criterion.id);
    }
    if (!body.includes(criterion.id)) fail("TRACEABILITY", `${criterion.id} is not referenced in the Markdown body.`, criterion.id);
  }
  if (!failures.some((item) => item.id === "TRACEABILITY")) {
    pass("TRACEABILITY", "Acceptance criteria are mapped to the design body.");
  }
}

function validateHandoff(value, body) {
  if (value.status === "draft") {
    pass("HANDOFF", "Draft SPEC is not eligible for engineering handoff.");
    return;
  }

  const handoffHeading = "## Handoff to Software Engineer";
  if (!body.includes(handoffHeading)) {
    fail("HANDOFF", `A ${value.status} SPEC needs ${handoffHeading}.`, "status");
  }
  if (!body.includes("**Next owner:** Software Engineer")) {
    fail("HANDOFF", "The handoff must name Software Engineer as the next owner.", handoffHeading);
  }

  const requiredSections = value.status === "ready-for-engineering"
    ? ["Build scope", "Behavior to preserve", "Do not infer", "Allowed design flexibility", "Validation evidence", "Deferred verification", "Open decisions and blockers"]
    : ["Open decisions and blockers"];
  for (const section of requiredSections) {
    if (!body.includes(`### ${section}`)) {
      fail("HANDOFF", `The handoff is missing ${section}.`, handoffHeading);
    }
  }

  if (value.status === "ready-for-engineering") {
    const criteria = Array.isArray(value.acceptance_criteria) ? value.acceptance_criteria : [];
    if (!criteria.length) {
      fail("HANDOFF", "ready-for-engineering requires at least one acceptance criterion.", "acceptance_criteria");
    }
    for (const section of ["Build scope", "Behavior to preserve", "Validation evidence"]) {
      if (!hasMeaningfulSectionContent(body, section)) {
        fail("HANDOFF", `${section} needs real, non-placeholder content before engineering handoff.`, `### ${section}`);
      }
    }
    const deferred = Array.isArray(value.deferred_validations) ? value.deferred_validations : [];
    if (deferred.length > 0 && !hasMeaningfulSectionContent(body, "Deferred verification")) {
      fail("HANDOFF", "Deferred verification needs the obligation IDs and real handoff details.", "### Deferred verification");
    }
    for (const validation of deferred) {
      const id = validation && typeof validation === "object" ? String(validation.id ?? "").trim() : "";
      if (id && !body.includes(id)) {
        fail("HANDOFF", `Deferred verification ${id} is not referenced in the handoff.`, "### Deferred verification");
      }
    }
  }

  if (!failures.some((item) => item.id === "HANDOFF")) {
    pass("HANDOFF", `${value.status} handoff structure is valid.`);
  }
}

function hasMeaningfulSectionContent(body, heading) {
  const marker = `### ${heading}`;
  const start = body.indexOf(marker);
  if (start < 0) return false;
  const afterHeading = body.slice(start + marker.length);
  const nextHeading = afterHeading.search(/^#{1,3}\s+/mu);
  const content = (nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading))
    .replace(/^[-*]\s*/gmu, "")
    .trim();
  const withoutPlaceholders = content.replace(/<[^>]+>/gu, "").trim();
  return Boolean(withoutPlaceholders) && !/^none[.!]?$/iu.test(withoutPlaceholders);
}

const ordered = [...results, ...failures].sort((left, right) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : left.status < right.status ? -1 : left.status > right.status ? 1 : 0
);

if (jsonMode) {
  console.log(JSON.stringify({ file, results: ordered, failures: failures.length }, null, 2));
} else {
  for (const result of ordered) {
    console.log(`${result.id} ${result.status}${result.line ? ` ${file}:${result.line}` : ""} — ${result.detail}`);
  }
}
process.exit(failures.length ? 1 : 0);
