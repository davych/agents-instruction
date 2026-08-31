const ASK_REVISION_CONFLICT_CODES = new Set([
  "ASK_REVISION_MISMATCH",
  "ASK_THREAD_REVISION_MISMATCH",
]);

const ASK_NEW_THREAD_REQUIRED_CODES = new Set([
  "ASK_THREAD_LIMIT",
  "ASK_THREAD_ARCHIVED",
]);

/** Only errors that prove the page and server disagree on revision need a new Thread. */
export function isAskRevisionConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && typeof candidate.code === "string"
    && ASK_REVISION_CONFLICT_CODES.has(candidate.code);
}

/** A full or archived Thread cannot accept a retry; recovery requires a new Thread. */
export function isAskNewThreadRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && typeof candidate.code === "string"
    && ASK_NEW_THREAD_REQUIRED_CODES.has(candidate.code);
}
