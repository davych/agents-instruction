import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiError,
  hasStringFields,
  parseCollectionResponse,
  parseDirectResponse,
  parseEntityResponse,
} from "../src/lib/api-response.ts";

interface Item {
  id: string;
  title: string;
}

const isItem = (value: unknown): value is Item =>
  hasStringFields(value, ["id", "title"]);

test("collection parser accepts direct arrays and named envelopes", () => {
  const items = [{ id: "one", title: "First" }];

  assert.deepEqual(parseCollectionResponse(items, "items", "列表响应", isItem), items);
  assert.deepEqual(
    parseCollectionResponse({ items }, "items", "列表响应", isItem),
    items,
  );
  assert.deepEqual(parseCollectionResponse({ items: [] }, "items", "列表响应", isItem), []);
});

test("collection parser rejects malformed successful responses instead of inventing empty state", () => {
  for (const response of [{}, { items: null }, { items: [{}] }, "unexpected"]) {
    assert.throws(
      () => parseCollectionResponse(response, "items", "列表响应", isItem),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "INVALID_API_RESPONSE");
        assert.match(error.message, /Web 与 API 版本不一致/);
        return true;
      },
    );
  }
});

test("entity parser accepts direct and named responses and rejects invalid entities", () => {
  const item = { id: "one", title: "First" };

  assert.deepEqual(parseEntityResponse(item, "item", "详情响应", isItem), item);
  assert.deepEqual(parseEntityResponse({ item }, "item", "详情响应", isItem), item);
  assert.throws(
    () => parseEntityResponse({ item: { id: "one" } }, "item", "详情响应", isItem),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});

test("direct response parser rejects a malformed detail payload", () => {
  const item = { id: "one", title: "First" };

  assert.deepEqual(parseDirectResponse(item, "详情响应", isItem), item);
  assert.throws(
    () => parseDirectResponse({ item }, "详情响应", isItem),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});
