import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { buildApp } from "../src/app.ts";

test("manual revisions between Fastify's default 1 MiB and the public 2 MB limit reach the route", async () => {
  const pool = {
    async query() { return { rows: [] }; },
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    logger: false,
    fakeCodex: true,
    allowedProjectRoots: [process.cwd()],
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/${crypto.randomUUID()}/revisions`,
      payload: {
        content: "a".repeat(1_100_000),
        expectedContentHash: "a".repeat(64),
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("decoded UTF-8 content still obeys the service's 2 MB byte limit", async () => {
  const pool = {} as pg.Pool;
  const app = await buildApp({
    pool,
    logger: false,
    fakeCodex: true,
    allowedProjectRoots: [process.cwd()],
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/${crypto.randomUUID()}/revisions`,
      payload: {
        content: "中".repeat(700_000),
        expectedContentHash: "a".repeat(64),
      },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, "ARTIFACT_TOO_LARGE");
  } finally {
    await app.close();
  }
});

test("raw request bodies beyond the revision parser allowance retain a stable 413 response", async () => {
  const pool = {} as pg.Pool;
  const app = await buildApp({
    pool,
    logger: false,
    fakeCodex: true,
    allowedProjectRoots: [process.cwd()],
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/artifacts/${crypto.randomUUID()}/revisions`,
      payload: {
        content: "a".repeat(12_100_000),
        expectedContentHash: "a".repeat(64),
      },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, "REQUEST_BODY_TOO_LARGE");
  } finally {
    await app.close();
  }
});
