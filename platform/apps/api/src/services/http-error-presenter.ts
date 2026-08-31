import {
  askProviderAvailabilitySchema,
  askProviderIdSchema,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../domain/errors.js";

export interface PublicErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const boundedText = z.string().trim().min(1).max(4_000);
const engineeringEvidenceDetailsSchema = z.object({
  issues: z.array(boundedText).max(200),
});
const implementationReadinessDetailsSchema = z.object({
  issues: z.array(z.object({
    code: z.enum([
      "ACCEPTANCE_CRITERIA_MISSING",
      "PRODUCT_BLOCKED",
      "DESIGN_BLOCKED",
      "ARCHITECTURE_BLOCKED",
    ]),
    role: z.enum(["pm-ba", "designer", "architect"]),
    artifactKey: z.enum(["user-stories", "prd", "design-spec", "architecture"]),
    title: boundedText,
    detail: boundedText,
    blockerIds: z.array(z.string().trim().min(1).max(160)).max(20),
    blockers: z.array(z.object({
      id: z.string().trim().max(160),
      decision: z.string().trim().max(2_000),
      owner: z.string().trim().max(300),
      nextAction: z.string().trim().max(2_000),
    })).max(50),
  })).max(100),
  acceptanceCriteriaCount: z.number().int().min(0).max(10_000),
});
const askDetailsSchema = z.object({
  providerId: askProviderIdSchema.optional(),
  availability: askProviderAvailabilitySchema.optional(),
  retryable: z.boolean().optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
});
const agentSessionRunDetailsSchema = z.object({
  sessionId: z.string().uuid(),
});

type DetailsParser = (details: unknown) => unknown;

/**
 * Only these error codes may publish structured details. Every parser builds a
 * new value from a closed field set, so nested paths, credentials, command
 * output and Error objects cannot accidentally cross the HTTP boundary.
 */
const publicDetailsByCode: Readonly<Record<string, DetailsParser>> = Object.freeze({
  AGENT_SESSION_RUN_REQUIRES_SESSION_ADVANCE: schemaParser(agentSessionRunDetailsSchema),
  AGENT_SESSION_RUN_COMPLETED_IMMUTABLE: schemaParser(agentSessionRunDetailsSchema),
  ENGINEERING_EVIDENCE_GATE_FAILED: schemaParser(engineeringEvidenceDetailsSchema),
  IMPLEMENTATION_NOT_READY: schemaParser(implementationReadinessDetailsSchema),
  ASK_PROVIDER_NOT_CONFIGURED: schemaParser(askDetailsSchema),
  ASK_CANCELLED: schemaParser(askDetailsSchema),
  ASK_FAILED: schemaParser(askDetailsSchema),
  ASK_PROVIDER_AUTHENTICATION_FAILED: schemaParser(askDetailsSchema),
  ASK_PROVIDER_REQUEST_INVALID: schemaParser(askDetailsSchema),
  ASK_PROVIDER_CANCELLED: schemaParser(askDetailsSchema),
  ASK_PROVIDER_TIMEOUT: schemaParser(askDetailsSchema),
  ASK_PROVIDER_UNREACHABLE: schemaParser(askDetailsSchema),
  ASK_PROVIDER_RATE_LIMITED: schemaParser(askDetailsSchema),
  ASK_PROVIDER_MODEL_UNAVAILABLE: schemaParser(askDetailsSchema),
  ASK_PROVIDER_REQUEST_REJECTED: schemaParser(askDetailsSchema),
  ASK_PROVIDER_RESPONSE_TOO_LARGE: schemaParser(askDetailsSchema),
  ASK_PROVIDER_PROTOCOL_ERROR: schemaParser(askDetailsSchema),
  ASK_MODEL_RESPONSE_INVALID: schemaParser(askDetailsSchema),
  ASK_REPOSITORY_UNAVAILABLE: schemaParser(askDetailsSchema),
  ASK_REVISION_MISMATCH: schemaParser(askDetailsSchema),
  ASK_KNOWLEDGE_MISMATCH: schemaParser(askDetailsSchema),
  ASK_ABORTED: schemaParser(askDetailsSchema),
});

export function presentAppError(error: AppError): PublicErrorBody {
  const parser = publicDetailsByCode[error.code];
  const details = parser?.(error.details);
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function schemaParser(schema: z.ZodType): DetailsParser {
  return (details) => {
    const parsed = schema.safeParse(details);
    return parsed.success ? parsed.data : undefined;
  };
}
