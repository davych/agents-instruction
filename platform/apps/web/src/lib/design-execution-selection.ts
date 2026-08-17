import type { FigmaTarget } from "./types";

export const FIGMA_HANDOFF_OUTPUT_KEY = "figma-handoff";

export const INITIAL_DESIGN_OUTPUT_KEYS = [
  "design-baseline",
  "design-spec",
] as const;

export type FigmaExecutionOptions = {
  figmaTarget?: FigmaTarget;
};

export type FigmaExecutionOptionsResult =
  | {
      valid: true;
      options: FigmaExecutionOptions;
    }
  | {
      valid: false;
      reason: "FIGMA_INTEGRATION_NOT_READY" | "FIGMA_TARGET_REQUIRED";
    };

interface FigmaExecutionSelectionInput {
  selectedOutputKeys: readonly string[];
  figmaIntegrationReady: boolean;
  figmaTarget?: FigmaTarget;
}

interface CapabilityConfirmationInput {
  dataReady: boolean;
  isFetching: boolean;
  isError: boolean;
  refreshPending: boolean;
  refreshError: boolean;
}

interface FigmaPlanSelection {
  key: string;
  writable: boolean;
}

/**
 * Changes Figma output intent only in response to an explicit user choice.
 * Integration readiness and target discovery must never call this helper.
 */
export function setFigmaRequested(
  selectedOutputKeys: readonly string[],
  requested: boolean,
): string[] {
  const uniqueOutputKeys = [...new Set(selectedOutputKeys)];
  const withoutFigma = uniqueOutputKeys.filter(
    (key) => key !== FIGMA_HANDOFF_OUTPUT_KEY,
  );
  return requested ? [...withoutFigma, FIGMA_HANDOFF_OUTPUT_KEY] : withoutFigma;
}

export function isFigmaRequested(selectedOutputKeys: readonly string[]): boolean {
  return selectedOutputKeys.includes(FIGMA_HANDOFF_OUTPUT_KEY);
}

export function isCapabilityConfirmed(input: CapabilityConfirmationInput): boolean {
  return input.dataReady
    && !input.isFetching
    && !input.isError
    && !input.refreshPending
    && !input.refreshError;
}

/**
 * Reconciles a selected plan only after a fresh successful plan response.
 * Loading and error states deliberately preserve the user's current choice.
 */
export function reconcileFigmaPlanSelection(
  currentPlanKey: string,
  plans: readonly FigmaPlanSelection[],
  plansConfirmed: boolean,
): string {
  if (!plansConfirmed) return currentPlanKey;
  const writablePlans = plans.filter((plan) => plan.writable);
  if (writablePlans.some((plan) => plan.key === currentPlanKey)) return currentPlanKey;
  return writablePlans.length === 1 ? writablePlans[0].key : "";
}

/**
 * Produces the Figma subset of api.executePhase options.
 *
 * A stale target is deliberately omitted when Figma is not selected. When it
 * is selected, an incomplete target or unavailable integration is represented
 * as a controlled invalid result so callers can disable submission without
 * discarding the user's selection intent.
 */
export function buildFigmaExecutionOptions(
  input: FigmaExecutionSelectionInput,
): FigmaExecutionOptionsResult {
  if (!isFigmaRequested(input.selectedOutputKeys)) {
    return { valid: true, options: {} };
  }
  if (!input.figmaIntegrationReady) {
    return { valid: false, reason: "FIGMA_INTEGRATION_NOT_READY" };
  }
  if (!isCompleteFigmaTarget(input.figmaTarget)) {
    return { valid: false, reason: "FIGMA_TARGET_REQUIRED" };
  }
  return {
    valid: true,
    options: { figmaTarget: input.figmaTarget },
  };
}

function isCompleteFigmaTarget(target: FigmaTarget | undefined): target is FigmaTarget {
  if (!target) return false;
  if (target.mode === "new_private_draft") {
    return Boolean(target.planKey.trim() && target.fileName.trim());
  }
  return Boolean(target.fileUrl.trim());
}
