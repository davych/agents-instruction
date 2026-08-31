import assert from "node:assert/strict";
import test from "node:test";

import { parsePositiveIntegerSetting } from "../src/services/environment-config.ts";

test("Cloud numeric resource settings fail startup when an explicit value is invalid", () => {
  assert.equal(parsePositiveIntegerSetting(undefined, "LIMIT"), undefined);
  assert.equal(parsePositiveIntegerSetting(" 42 ", "LIMIT"), 42);
  for (const value of ["", " ", "0", "-1", "1.5", "NaN", "oops", "9007199254740992"]) {
    assert.throws(
      () => parsePositiveIntegerSetting(value, "AI_SDLC_GIT_MAX_REPOSITORY_BYTES"),
      /AI_SDLC_GIT_MAX_REPOSITORY_BYTES/u,
      `explicit ${JSON.stringify(value)} must not silently fall back to a wider default`,
    );
  }
});
