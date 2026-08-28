import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { AppError } from "../domain/errors.js";

export interface AccessControlOptions {
  accessToken?: string;
  allowedOrigins?: string[];
}

export function normalizeAccessToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (
    value !== token
    || token.length < 24
    || token.length > 4_096
    || /[\u0000-\u001f\u007f\s]/u.test(token)
    || isExampleAccessToken(token)
  ) {
    throw new Error(
      "AI_SDLC_ACCESS_TOKEN 必须是随机生成的 24～4096 个不含空白或控制字符的字符，不能使用示例占位值",
    );
  }
  return token;
}

function isExampleAccessToken(token: string): boolean {
  const normalized = token.toLocaleLowerCase("en-US");
  return [
    "replace-with-at-least-24-random-characters",
    "replace-with-a-long-random-access-token",
    "change-me-to-a-random-access-token",
  ].includes(normalized)
    || /^(?:replace[-_]?me|change[-_]?me|your[-_]?token|example[-_]?token|placeholder)/u.test(normalized);
}

export function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const origins = value.split(",").map((entry) => normalizeOrigin(entry)).filter(Boolean);
  if (origins.length === 0) return undefined;
  return [...new Set(origins)];
}

export function normalizeAllowedOrigins(origins: string[] | undefined): string[] {
  if (!origins?.length) return [];
  return [...new Set(origins.map(normalizeOrigin))];
}

export function assertSafeNetworkBinding(host: string, accessToken: string | undefined): void {
  if (isLoopbackHost(host) || accessToken) return;
  throw new Error(
    "非 loopback HOST 必须配置 AI_SDLC_ACCESS_TOKEN；未认证的 Cloud API 不会启动",
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "127.0.0.1", "::1"].includes(normalized)) return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

export function isOriginAllowed(
  origin: string | undefined,
  configuredOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }
  if (configuredOrigins.length > 0) return configuredOrigins.includes(normalized);
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertBearerAuthorization(
  authorization: string | undefined,
  expectedToken: string | undefined,
): void {
  if (!expectedToken) return;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
  const actualToken = match?.[1];
  if (!actualToken || !constantTimeTokenEqual(actualToken, expectedToken)) {
    throw new AppError("访问令牌无效或缺失", 401, "AUTHENTICATION_REQUIRED");
  }
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`CORS origin 无效：${trimmed}`);
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`远程 CORS origin 必须使用 HTTPS：${trimmed}`);
  }
  return parsed.origin;
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
