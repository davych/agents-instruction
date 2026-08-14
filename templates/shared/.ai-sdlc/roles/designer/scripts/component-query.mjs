#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "../../../..");
const configuredCatalogModule = "__AI_SDLC_COMPONENT_CATALOG_MODULE__";

const emptyCatalog = () => ({
  configured: false,
  components: [],
  tokens: [],
  icons: []
});

/**
 * Project customization point.
 *
 * Return a catalog directly here, or provide a project-relative .mjs module during
 * initialization. A catalog component may contain:
 * name, aliases, category, frameworks, props, events, slots, and usage.
 */
export async function loadLocalComponentCatalog() {
  return emptyCatalog();
}

export async function loadComponentCatalog() {
  if (configuredCatalogModule) {
    const modulePath = path.resolve(repoRoot, configuredCatalogModule);
    const relative = path.relative(repoRoot, modulePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("The component catalog module must stay inside the project.");
    }
    const module = await import(pathToFileURL(modulePath).href);
    const loader = module.loadComponentCatalog ?? module.default;
    if (typeof loader !== "function") {
      throw new Error("The component catalog module must export loadComponentCatalog() or a default function.");
    }
    return normalizeCatalog(await loader({ repoRoot }), true);
  }
  return normalizeCatalog(await loadLocalComponentCatalog(), false);
}

function normalizeCatalog(value, configuredByModule) {
  if (!value || typeof value !== "object") {
    throw new Error("The component catalog loader must return an object.");
  }
  const catalog = {
    configured: value.configured ?? configuredByModule,
    components: value.components ?? [],
    tokens: value.tokens ?? [],
    icons: value.icons ?? []
  };
  for (const key of ["components", "tokens", "icons"]) {
    if (!Array.isArray(catalog[key])) throw new Error(`catalog.${key} must be an array.`);
  }
  catalog.components = catalog.components.map((component) => {
    if (!component || typeof component.name !== "string" || !component.name.trim()) {
      throw new Error("Every catalog component needs a name.");
    }
    return {
      ...component,
      name: component.name.trim(),
      aliases: arrayOfStrings(component.aliases),
      frameworks: arrayOfStrings(component.frameworks),
      props: Array.isArray(component.props) ? component.props : [],
      events: Array.isArray(component.events) ? component.events : [],
      slots: Array.isArray(component.slots) ? component.slots : []
    };
  });
  return catalog;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function componentNames(component) {
  return [component.name, ...component.aliases].map((name) => name.toLowerCase());
}

function matchesText(value, query) {
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

async function main(args) {
  const json = args.includes("--json");
  const values = args.filter((arg) => arg !== "--json");
  const [command, query] = values;
  const catalog = await loadComponentCatalog();
  const emit = (value, text) => console.log(json ? JSON.stringify(value, null, 2) : text);

  if (!catalog.configured) {
    console.error("Component catalog is not configured; edit loadLocalComponentCatalog() or initialize with a catalog module.");
  }

  if (command === "component") {
    if (!query) return usage("component requires a name");
    const wanted = query.toLowerCase();
    const matched = catalog.components.find((component) => componentNames(component).includes(wanted));
    const suggestions = matched
      ? []
      : catalog.components.filter((component) => matchesText(componentNames(component), query)).slice(0, 8);
    emit(
      { configured: catalog.configured, matched: Boolean(matched), component: matched ?? null, suggestions },
      matched ? formatComponent(matched) : `No component matched ${query}.${suggestions.length ? ` Related: ${suggestions.map((item) => item.name).join(", ")}` : ""}`
    );
    return;
  }

  if (command === "components") {
    const categoryIndex = values.indexOf("--category");
    const category = categoryIndex >= 0 ? values[categoryIndex + 1] : null;
    const term = values
      .filter((value, index) => index > 0 && index !== categoryIndex && index !== categoryIndex + 1)
      .join(" ");
    if (!category && !term) return usage("components requires a term or --category");
    const matches = catalog.components.filter((component) =>
      (!category || component.category === category) && (!term || matchesText(component, term))
    );
    emit(matches, matches.map((component) => component.name).join("\n"));
    return;
  }

  if (command === "tokens" || command === "icons") {
    if (!query) return usage(`${command} requires a term`);
    const matches = catalog[command].filter((item) => matchesText(item, query));
    emit(matches, matches.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n"));
    return;
  }

  usage();
}

function formatComponent(component) {
  const lines = [component.name];
  if (component.aliases.length) lines.push(`aliases: ${component.aliases.join(", ")}`);
  if (component.category) lines.push(`category: ${component.category}`);
  if (component.frameworks.length) lines.push(`frameworks: ${component.frameworks.join(", ")}`);
  if (component.props.length) lines.push(`props: ${component.props.map((prop) => prop.name ?? prop).join(", ")}`);
  if (component.events.length) lines.push(`events: ${component.events.map((event) => event.name ?? event).join(", ")}`);
  if (component.slots.length) lines.push(`slots: ${component.slots.map((slot) => slot.name ?? slot).join(", ")}`);
  if (component.usage) lines.push(`usage:\n${component.usage}`);
  return lines.join("\n");
}

function usage(error) {
  if (error) console.error(error);
  console.error("Usage: component-query.mjs component|components|tokens|icons <query> [--category name] [--json]");
  process.exitCode = 2;
}

const entryPath = process.argv[1];
if (
  entryPath &&
  existsSync(entryPath) &&
  realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
