import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors.js";
import { presentAppError } from "../src/services/http-error-presenter.js";

test("Cloud HTTP errors drop unknown details recursively", () => {
  const pathMarker = "/private/host/workspaces/PATH_MARKER";
  const tokenMarker = "TOKEN_MARKER_super-secret";
  const keyMarker = "KEY_MARKER_sk-secret";
  const response = presentAppError(new AppError(
    "固定的公开错误消息",
    422,
    "UNSAFE_INTERNAL_FAILURE",
    {
      path: pathMarker,
      nested: [{ token: tokenMarker, provider: { apiKey: keyMarker } }],
    },
  ));

  assert.deepEqual(response, {
    error: { code: "UNSAFE_INTERNAL_FAILURE", message: "固定的公开错误消息" },
  });
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /PATH_MARKER/u);
  assert.doesNotMatch(serialized, /TOKEN_MARKER/u);
  assert.doesNotMatch(serialized, /KEY_MARKER/u);
});

test("Cloud HTTP errors rebuild allowlisted details and strip nested extra fields", () => {
  const response = presentAppError(new AppError(
    "当前输入还不能开始写代码",
    409,
    "IMPLEMENTATION_NOT_READY",
    {
      acceptanceCriteriaCount: 0,
      secretPath: "/private/PATH_MARKER",
      issues: [{
        code: "ACCEPTANCE_CRITERIA_MISSING",
        role: "pm-ba",
        artifactKey: "user-stories",
        title: "缺少验收标准",
        detail: "请先补齐可测试的 AC",
        blockerIds: [],
        blockers: [],
        token: "TOKEN_MARKER",
        nested: { apiKey: "KEY_MARKER" },
      }],
    },
  ));

  assert.equal(response.error.details !== undefined, true);
  const serialized = JSON.stringify(response);
  assert.match(serialized, /缺少验收标准/u);
  assert.doesNotMatch(serialized, /PATH_MARKER|TOKEN_MARKER|KEY_MARKER/u);
});
