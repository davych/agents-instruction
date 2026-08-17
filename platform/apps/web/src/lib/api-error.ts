export interface ParsedApiErrorBody {
  message?: string;
  code?: string;
  details?: unknown;
}

export function parseApiErrorBody(body: unknown): ParsedApiErrorBody {
  if (typeof body === "string") return { message: body || undefined };
  if (!body || typeof body !== "object") return {};

  const payload = body as Record<string, unknown>;
  const nested = payload.error && typeof payload.error === "object"
    ? payload.error as Record<string, unknown>
    : undefined;
  return {
    message:
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : typeof nested?.message === "string"
            ? nested.message
            : typeof payload.details === "string"
              ? payload.details
              : undefined,
    code:
      typeof payload.code === "string"
        ? payload.code
        : typeof nested?.code === "string"
          ? nested.code
          : undefined,
    details: nested?.details !== undefined ? nested.details : payload.details,
  };
}
