import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type pg from "pg";

import { buildApp } from "../src/app.js";
import {
  assertBearerAuthorization,
  assertSafeNetworkBinding,
  isOriginAllowed,
  normalizeAccessToken,
  parseAllowedOrigins,
} from "../src/services/access-control.js";
import { createGitCredentialRegistryFromEnv } from "../src/services/git-credential-registry.js";
import { RepositoryPolicy } from "../src/services/repository-policy.js";

test("CLOUD-AC-15: non-loopback binding fails closed without an access token", () => {
  assert.doesNotThrow(() => assertSafeNetworkBinding("127.0.0.1", undefined));
  assert.doesNotThrow(() => assertSafeNetworkBinding("::1", undefined));
  assert.throws(
    () => assertSafeNetworkBinding("0.0.0.0", undefined),
    /必须配置 AI_SDLC_ACCESS_TOKEN/u,
  );
  assert.doesNotThrow(() => assertSafeNetworkBinding("0.0.0.0", "x".repeat(32)));
});

test("CLOUD-AC-15: bearer access is exact and token validation rejects weak formatting", () => {
  const token = normalizeAccessToken("a".repeat(32));
  assert.equal(token, "a".repeat(32));
  assert.doesNotThrow(() => assertBearerAuthorization(`Bearer ${token}`, token));
  assert.throws(
    () => assertBearerAuthorization(`Bearer ${"b".repeat(32)}`, token),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && (error as { code?: string }).code === "AUTHENTICATION_REQUIRED"
    ),
  );
  assert.throws(() => normalizeAccessToken("short"), /24～4096/u);
  assert.throws(() => normalizeAccessToken(`${"a".repeat(24)}\n`), /24～4096/u);
  assert.throws(
    () => normalizeAccessToken("replace-with-at-least-24-random-characters"),
    /示例占位值/u,
  );
});

test("CLOUD-AC-15: configured CORS origins use exact normalized matches", () => {
  const origins = parseAllowedOrigins("https://cloud.example.com, http://localhost:5174");
  assert.deepEqual(origins, ["https://cloud.example.com", "http://localhost:5174"]);
  assert.equal(isOriginAllowed("https://cloud.example.com", origins ?? []), true);
  assert.equal(isOriginAllowed("https://cloud.example.com.evil.test", origins ?? []), false);
  assert.equal(isOriginAllowed("https://cloud.example.com/path", origins ?? []), false);
  assert.equal(isOriginAllowed(undefined, origins ?? []), true);
  assert.throws(
    () => parseAllowedOrigins("http://cloud.example.com"),
    /必须使用 HTTPS/u,
  );
});

test("CLOUD-AC-15: health is public while every operational API requires bearer auth", async () => {
  const token = "cloud-access-token-for-acceptance";
  const app = await buildApp({
    pool: {} as pg.Pool,
    fakeCodex: true,
    accessToken: token,
    allowedOrigins: ["https://cloud.example.com"],
  });
  try {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json().authentication, { required: true });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/auth/check" });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/auth/check",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cloud.example.com",
      },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().authenticated, true);
    assert.equal(
      authenticated.headers["access-control-allow-origin"],
      "https://cloud.example.com",
    );
  } finally {
    await app.close();
  }
});

test("CLOUD-AC-01/14: Cloud project creation rejects legacy-local host paths", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-cloud-create-"));
  const app = await buildApp({
    pool: {
      query: async () => ({ rows: [] }),
    } as unknown as pg.Pool,
    fakeCodex: true,
    cloud: {
      managedRoot,
      repositoryPolicy: new RepositoryPolicy({
        allowedOrigins: ["https://git.example.test"],
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
      credentials: createGitCredentialRegistryFromEnv({}),
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        sourceKind: "legacy-local",
        name: "must-not-bind-host",
        summary: "Cloud must be remote-only",
        rootPath: "/private/operator/project",
        initialize: false,
        agentClient: "codex",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assert.doesNotMatch(response.body, /private\/operator/u);
  } finally {
    await app.close();
    await rm(managedRoot, { recursive: true, force: true });
  }
});

test("CLOUD-AC-14: legacy-local resources stay hidden behind ID-only Cloud routes", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-cloud-legacy-"));
  let ownershipLookups = 0;
  const pool = {
    query: async (query: string) => {
      if (
        query.includes("FROM artifacts a")
        || query.includes("FROM executions e")
        || query.includes("FROM ask_threads at")
      ) {
        ownershipLookups += 1;
        return { rows: [{ source_kind: "legacy_local" }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    fakeCodex: true,
    cloud: {
      managedRoot,
      repositoryPolicy: new RepositoryPolicy({
        allowedOrigins: ["https://git.example.test"],
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
      credentials: createGitCredentialRegistryFromEnv({}),
    },
  });
  const artifactId = "11111111-1111-4111-8111-111111111111";
  const executionId = "22222222-2222-4222-8222-222222222222";
  const threadId = "33333333-3333-4333-8333-333333333333";
  try {
    const requests = [
      { method: "GET" as const, url: `/api/artifacts/${artifactId}` },
      { method: "POST" as const, url: `/api/artifacts/${artifactId}/revisions`, payload: {} },
      { method: "GET" as const, url: `/api/executions/${executionId}/events` },
      { method: "GET" as const, url: `/api/ask-threads/${threadId}` },
      { method: "POST" as const, url: `/api/ask-threads/${threadId}/messages`, payload: {} },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
      assert.equal(response.json().error.code, "CLOUD_PROJECT_NOT_FOUND");
    }
    assert.equal(ownershipLookups, requests.length);
  } finally {
    await app.close();
    await rm(managedRoot, { recursive: true, force: true });
  }
});
