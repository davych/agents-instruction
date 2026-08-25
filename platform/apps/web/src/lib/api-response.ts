export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasStringFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && fields.every((field) => typeof value[field] === "string");
}

function invalidApiResponse(label: string, expected: string): ApiError {
  return new ApiError(
    `本地服务返回的${label}结构无效，可能是 Web 与 API 版本不一致。请刷新页面或更新服务后重试。`,
    502,
    "INVALID_API_RESPONSE",
    { expected },
  );
}

export function parseCollectionResponse<T>(
  body: unknown,
  key: string,
  label: string,
  isItem: (value: unknown) => value is T,
): T[] {
  const collection = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body[key])
      ? body[key]
      : null;

  if (!collection || !collection.every(isItem)) {
    throw invalidApiResponse(label, `数组或包含 ${key} 数组的对象`);
  }

  return collection;
}

export function parseEntityResponse<T>(
  body: unknown,
  key: string,
  label: string,
  isEntity: (value: unknown) => value is T,
): T {
  const entity = isRecord(body) && key in body ? body[key] : body;
  if (!isEntity(entity)) {
    throw invalidApiResponse(label, `对象或包含 ${key} 对象的响应`);
  }

  return entity;
}

export function parseDirectResponse<T>(
  body: unknown,
  label: string,
  isEntity: (value: unknown) => value is T,
): T {
  if (!isEntity(body)) {
    throw invalidApiResponse(label, "符合约定的对象");
  }

  return body;
}
