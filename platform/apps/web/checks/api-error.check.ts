import assert from "node:assert/strict";
import test from "node:test";

import { parseApiErrorBody } from "../src/lib/api-error.ts";

test("API error parsing retains nested status-independent code and details", () => {
  assert.deepEqual(
    parseApiErrorBody({
      error: {
        code: "ARTIFACT_WORKSPACE_DIVERGED",
        message: "workspace changed",
        details: { artifactId: "artifact-1" },
      },
    }),
    {
      code: "ARTIFACT_WORKSPACE_DIVERGED",
      message: "workspace changed",
      details: { artifactId: "artifact-1" },
    },
  );
});

test("API error parsing supports top-level and text error responses", () => {
  assert.deepEqual(
    parseApiErrorBody({ code: "TOP_LEVEL", message: "failed", details: "detail" }),
    { code: "TOP_LEVEL", message: "failed", details: "detail" },
  );
  assert.deepEqual(parseApiErrorBody("plain failure"), { message: "plain failure" });
  assert.deepEqual(parseApiErrorBody(null), {});
});
