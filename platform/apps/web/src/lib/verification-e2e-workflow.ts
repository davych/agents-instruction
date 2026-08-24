import type { VerificationE2eFlowState } from "./types.js";

export type VerificationE2eActionKind =
  | "configure"
  | "preflight"
  | "author"
  | "review_script"
  | "execute"
  | "review_verification"
  | "wait";

export interface VerificationE2ePrimaryAction {
  kind: VerificationE2eActionKind;
  label: string;
  loading: boolean;
}

export interface VerificationE2eStandardGate {
  explicitlyUnconfigured: boolean;
  stateUncertain: boolean;
  standardTesterLocked: boolean;
}

export function verificationE2eStandardGate(input: {
  flowLoaded: boolean;
  flowState?: VerificationE2eFlowState;
  flowHasWorkspace: boolean;
  workspaceLoaded: boolean;
  workspaceConfigured: boolean;
}): VerificationE2eStandardGate {
  const configured = input.flowHasWorkspace || input.workspaceConfigured;
  const explicitlyUnconfigured = !configured && (input.flowLoaded
    ? input.flowState === "unconfigured"
    : input.workspaceLoaded && !input.workspaceConfigured);
  return {
    explicitlyUnconfigured,
    stateUncertain: !explicitlyUnconfigured && !input.flowLoaded,
    standardTesterLocked: !explicitlyUnconfigured,
  };
}

export function verificationE2ePrimaryAction(
  state: VerificationE2eFlowState,
): VerificationE2ePrimaryAction {
  switch (state) {
    case "unconfigured":
      return { kind: "configure", label: "配置独立 E2E 项目", loading: false };
    case "preflight_blocked":
      return { kind: "preflight", label: "检查或重新预检", loading: false };
    case "needs_authoring":
      return { kind: "author", label: "生成或更新 E2E 脚本", loading: false };
    case "authoring":
      return { kind: "wait", label: "正在独立生成脚本", loading: true };
    case "awaiting_script_review":
      return { kind: "review_script", label: "审核完整可执行脚本基线", loading: false };
    case "ready_to_execute":
      return { kind: "execute", label: "运行真实 Chromium 测试", loading: false };
    case "executing":
      return { kind: "wait", label: "正在运行真实 Chromium", loading: true };
    case "awaiting_verification_review":
      return { kind: "review_verification", label: "审核 Verification 证据", loading: false };
    case "failed":
      return { kind: "execute", label: "重新运行真实 Chromium", loading: false };
  }
}
