import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";

import { buildApp, type DeepWikiGenerationServiceLike } from "../src/app.ts";

test("runtime shutdown drains background DeepWiki work before closing the database pool", async () => {
  const order: string[] = [];
  const waitStarted = deferred<void>();
  const releaseWait = deferred<void>();
  const pool = {
    async end() {
      order.push("pool.end");
    },
  } as unknown as pg.Pool;
  const deepWikiGenerations: DeepWikiGenerationServiceLike = {
    async getLatest() { return null; },
    async getLatestPublished() { return null; },
    async generate() { throw new Error("not used"); },
    async waitForIdle() {
      order.push("deepwiki.wait.start");
      waitStarted.resolve();
      await releaseWait.promise;
      order.push("deepwiki.wait.end");
    },
  };
  const app = await buildApp({
    pool,
    fakeCodex: true,
    closePoolOnClose: true,
    deepWikiGenerations,
  });

  await app.ready();
  const closing = app.close();
  await waitStarted.promise;
  assert.deepEqual(order, ["deepwiki.wait.start"]);

  releaseWait.resolve();
  await closing;
  assert.deepEqual(order, [
    "deepwiki.wait.start",
    "deepwiki.wait.end",
    "pool.end",
  ]);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
