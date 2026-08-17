export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "BAD_REQUEST",
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(entity: string): AppError {
  return new AppError(`${entity} 不存在`, 404, "NOT_FOUND");
}
