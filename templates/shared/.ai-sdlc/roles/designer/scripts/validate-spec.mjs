#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadComponentCatalog } from "./component-query.mjs";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const fileArg = args.find((arg) => arg !== "--json");

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
  if (!failures.some((item) => item.id === "SCHEMA")) pass("SCHEMA", "SPEC structure is valid.");
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
    ? ["Build scope", "Behavior to preserve", "Do not infer", "Allowed design flexibility", "Validation evidence", "Open decisions and blockers"]
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
