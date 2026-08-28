import assert from "node:assert/strict";
import test from "node:test";

import type { ZodTypeAny } from "zod";

import {
  agentEventSchema,
  agentHumanGateSchema,
  agentMessageSchema,
  agentProviderCapabilitiesSchema,
  agentSessionRepositorySchema,
  agentSessionSchema,
  agentToolCallSchema,
  bindRemoteRepositorySchema,
  createAgentSessionSchema,
  deepWikiGenerationSchema,
  generateDeepWikiSchema,
  projectAgentSettingsSchema,
  repoAliasSchema,
  sendAgentMessageSchema,
  updateProjectAgentSettingsSchema,
} from "../src/index.ts";

const publicSchemas: Array<[string, ZodTypeAny]> = [
  ["ProjectAgentSettings", projectAgentSettingsSchema],
  ["AgentSessionRepository", agentSessionRepositorySchema],
  ["AgentSession", agentSessionSchema],
  ["AgentMessage", agentMessageSchema],
  ["AgentEvent", agentEventSchema],
  ["AgentToolCall", agentToolCallSchema],
  ["AgentHumanGate", agentHumanGateSchema],
  ["DeepWikiGeneration", deepWikiGenerationSchema],
];

const inputSchemas: Array<[string, ZodTypeAny]> = [
  ["BindRemoteRepository", bindRemoteRepositorySchema],
  ["UpdateProjectAgentSettings", updateProjectAgentSettingsSchema],
  ["CreateAgentSession", createAgentSessionSchema],
  ["SendAgentMessage", sendAgentMessageSchema],
  ["GenerateDeepWiki", generateDeepWikiSchema],
];

test("CHAT-AC-05/06/09/15: chat-agent public DTO and request object layers are strict", () => {
  for (const [name, schema] of [...publicSchemas, ...inputSchemas]) {
    const objects = objectDefinitions(schema);
    assert.ok(objects.length > 0, `${name} must contain an object contract`);
    for (const definition of objects) {
      assert.equal(definition.unknownKeys, "strict", `${name} must reject unknown fields`);
    }
  }
});

test("CHAT-AC-05/10: public DTOs cannot expose secrets or server execution details", () => {
  const forbiddenKeys = new Set([
    "workspaceId",
    "rootPath",
    "hostPath",
    "image",
    "imageName",
    "command",
    "endpoint",
    "apiKey",
    "secret",
    "secretValue",
    "token",
    "arguments",
    "rawArguments",
    "output",
    "rawOutput",
  ]);

  for (const [name, schema] of publicSchemas) {
    const keys = schemaKeys(schema);
    assert.deepEqual(
      [...keys].filter((key) => forbiddenKeys.has(key)),
      [],
      `${name} leaks a forbidden public field`,
    );
  }
});

test("CHAT-AC-05/06/09/15/16: public persistence DTOs retain the required audit facts", () => {
  assertKeys(projectAgentSettingsSchema, [
    "defaultProviderId",
    "sandboxBlueprintId",
    "sandboxBlueprintVersion",
    "enabledMcpServerIds",
  ]);
  assertKeys(sendAgentMessageSchema, [
    "clientMessageId",
    "expectedSequence",
    "content",
  ]);
  assertKeys(agentMessageSchema, ["sequence", "role", "content", "providerId", "model"]);
  assertKeys(agentEventSchema, ["sequence", "kind", "status", "summary"]);
  assertKeys(agentToolCallSchema, ["mcpServerId", "toolName", "permissionClass", "status"]);
  assertKeys(agentSessionSchema, [
    "turnState",
    "currentProviderId",
    "lastMessageSequence",
    "lastEventSequence",
    "repositories",
    "sandbox",
  ]);
  assertKeys(deepWikiGenerationSchema, [
    "revision",
    "providerId",
    "model",
    "usage",
    "content",
    "citations",
    "generatedAt",
    "staleAt",
  ]);
});

test("CHAT-AC-01/04: repository aliases are bounded identifiers, not authority-bearing free text", () => {
  for (const alias of ["backend", "repo-2", "web-app"]) {
    assert.equal(repoAliasSchema.safeParse(alias).success, true, alias);
  }
  for (const alias of ["", "@backend", "../backend", "backend/repo", "backend\nadmin"]) {
    assert.equal(repoAliasSchema.safeParse(alias).success, false, alias);
  }
});

test("CHAT-AC-07: Provider capability contract distinguishes chat, DeepWiki, and tool calling", () => {
  const keys = schemaKeys(agentProviderCapabilitiesSchema);
  assert.equal(keys.has("chat"), true);
  assert.equal(keys.has("deepWiki"), true);
  assert.equal(keys.has("toolCalling"), true);
});

function assertKeys(schema: ZodTypeAny, expected: string[]): void {
  const keys = schemaKeys(schema);
  for (const key of expected) assert.equal(keys.has(key), true, `missing ${key}`);
}

function schemaKeys(schema: ZodTypeAny): Set<string> {
  const keys = new Set<string>();
  visitSchema(schema, (definition) => {
    const shape = readShape(definition);
    if (!shape) return;
    for (const key of Object.keys(shape)) keys.add(key);
  });
  return keys;
}

function objectDefinitions(schema: ZodTypeAny): Array<Record<string, unknown>> {
  const definitions: Array<Record<string, unknown>> = [];
  visitSchema(schema, (definition) => {
    if (readShape(definition)) definitions.push(definition);
  });
  return definitions;
}

function readShape(definition: Record<string, unknown>): Record<string, ZodTypeAny> | null {
  const shape = definition.shape;
  if (typeof shape === "function") return shape() as Record<string, ZodTypeAny>;
  if (shape && typeof shape === "object") return shape as Record<string, ZodTypeAny>;
  return null;
}

function visitSchema(
  schema: ZodTypeAny,
  visitor: (definition: Record<string, unknown>) => void,
  seen = new Set<ZodTypeAny>(),
): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const definition = schema._def as Record<string, unknown>;
  visitor(definition);

  const shape = readShape(definition);
  if (shape) for (const child of Object.values(shape)) visitSchema(child, visitor, seen);

  for (const property of ["schema", "innerType", "type", "valueType", "rest"] as const) {
    const child = definition[property];
    if (child && typeof child === "object" && "_def" in child) {
      visitSchema(child as ZodTypeAny, visitor, seen);
    }
  }
  for (const property of ["options", "items"] as const) {
    const children = definition[property];
    if (Array.isArray(children)) {
      for (const child of children) visitSchema(child as ZodTypeAny, visitor, seen);
    } else if (children instanceof Map) {
      for (const child of children.values()) visitSchema(child as ZodTypeAny, visitor, seen);
    }
  }
}
