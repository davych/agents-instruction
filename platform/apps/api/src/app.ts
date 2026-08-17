import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CodexReasoningEffort,
  createArtifactRevisionSchema,
  createProjectSchema,
  createRunSchema,
  executePhaseSchema,
  phaseIdSchema,
  reviewPhaseSchema,
  updateTicketStatusSchema
} from "@ai-sdlc/contracts";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { z, ZodError } from "zod";

import { PgWorkflowStore } from "./db/store.js";
import { AppError } from "./domain/errors.js";
import { CodexTerminalRunner } from "./services/codex-runner.js";
import { CodexExecutionCapabilities } from "./services/codex-execution-capabilities.js";
import { FigmaMcpIntegration } from "./services/figma-mcp-integration.js";
import { ProjectPathPolicy } from "./services/project-paths.js";
import { WorkflowService } from "./services/workflow-service.js";

export interface AppOptions {
  pool: pg.Pool;
  logger?: boolean;
  allowedProjectRoots?: string[];
  codexBinary?: string;
  fakeCodex?: boolean;
  codexTimeoutMs?: number;
  codexAllowedModels?: string[];
  codexAllowedReasoningEfforts?: CodexReasoningEffort[];
  codexDefaultModel?: string;
  codexDefaultReasoningEffort?: CodexReasoningEffort;
  codexHome?: string;
  cliPath?: string;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const phaseParamsSchema = z.object({ id: z.string().uuid(), phaseId: phaseIdSchema });
const ticketParamsSchema = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() });
const figmaIntegrationQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional()
});
const artifactRevisionBodyLimit = 12_100_000;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin)) callback(null, true);
      else callback(new Error("Origin not allowed"), false);
    }
  });
  const runner = new CodexTerminalRunner({
    binary: options.codexBinary,
    fake: options.fakeCodex,
    timeoutMs: options.codexTimeoutMs
  });
  const figmaIntegration = new FigmaMcpIntegration({ binary: options.codexBinary });
  const codexCapabilities = new CodexExecutionCapabilities({
    binary: options.codexBinary,
    allowedModels: options.codexAllowedModels,
    allowedReasoningEfforts: options.codexAllowedReasoningEfforts,
    defaultModel: options.codexDefaultModel,
    defaultReasoningEffort: options.codexDefaultReasoningEffort,
    codexHome: options.codexHome
  });
  const service = new WorkflowService(
    new PgWorkflowStore(options.pool),
    new ProjectPathPolicy(options.allowedProjectRoots ?? [defaultRepositoryRoot()]),
    runner,
    options.cliPath,
    figmaIntegration,
    codexCapabilities
  );

  app.setErrorHandler((error, _request, reply) => {
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({
        error: { code: "REQUEST_BODY_TOO_LARGE", message: "请求体超过允许大小" }
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "请求参数无效", details: error.flatten() }
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details }
      });
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    runner: {
      mode: runner.mode(),
      command: runner.commandLabel()
    }
  }));
  app.get("/api/integrations/figma", async () => figmaIntegration.status());

  app.get("/api/projects", async () => ({ projects: await service.listProjects() }));
  app.post("/api/projects", async (request, reply) => {
    const result = await service.createProject(createProjectSchema.parse(request.body));
    return reply.status(201).send(result);
  });
  app.get("/api/projects/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getProject(id);
  });

  app.get("/api/projects/:id/runs", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { runs: await service.listRuns(id) };
  });
  app.post("/api/projects/:id/runs", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const run = await service.createRun(id, createRunSchema.parse(request.body));
    return reply.status(201).send({ run });
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getRun(id);
  });
  app.get("/api/runs/:id/integrations/figma", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { force } = figmaIntegrationQuerySchema.parse(request.query);
    return service.getFigmaIntegration(id, { force: force === "true" });
  });
  app.get("/api/runs/:id/integrations/figma/plans", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { force } = figmaIntegrationQuerySchema.parse(request.query);
    return service.getFigmaPlans(id, { force: force === "true" });
  });
  app.get("/api/runs/:id/codex/capabilities", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getCodexCapabilities(id);
  });
  app.get("/api/runs/:id/tickets", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { tickets: await service.listTickets(id) };
  });
  app.get("/api/runs/:id/tickets/:ticketId", async (request) => {
    const { id, ticketId } = ticketParamsSchema.parse(request.params);
    return { ticket: await service.getTicket(id, ticketId) };
  });
  app.patch("/api/runs/:id/tickets/:ticketId/status", async (request) => {
    const { id, ticketId } = ticketParamsSchema.parse(request.params);
    const { status } = updateTicketStatusSchema.parse(request.body);
    return { ticket: await service.updateTicketStatus(id, ticketId, status) };
  });
  app.post("/api/runs/:id/phases/:phaseId/execute", async (request, reply) => {
    const { id, phaseId } = phaseParamsSchema.parse(request.params);
    const execution = await service.executePhase(id, phaseId, executePhaseSchema.parse(request.body ?? {}));
    return reply.status(202).send({ execution });
  });
  app.post("/api/runs/:id/phases/:phaseId/review", async (request) => {
    const { id, phaseId } = phaseParamsSchema.parse(request.params);
    return service.reviewPhase(id, phaseId, reviewPhaseSchema.parse(request.body));
  });

  app.get("/api/artifacts/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { artifact: await service.getArtifact(id) };
  });
  app.post("/api/artifacts/:id/revisions", { bodyLimit: artifactRevisionBodyLimit }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const artifact = await service.createArtifactRevision(
      id,
      createArtifactRevisionSchema.parse(request.body),
    );
    return reply.status(201).send({ artifact });
  });
  app.get("/api/executions/:id/events", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { events: await service.getExecutionEvents(id) };
  });

  app.addHook("onClose", async () => {
    await service.waitForIdle();
  });
  return app;
}

function defaultRepositoryRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
