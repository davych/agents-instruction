import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { repositoryRefSchema, repositoryUrlSchema } from "@ai-sdlc/contracts";

import { AppError } from "../domain/errors.js";

export interface RepositoryAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedRepositoryUrl {
  url: string;
  origin: string;
  host: string;
  hostname: string;
  requestedRef: string;
  addresses: RepositoryAddress[];
}

export interface RepositoryPolicyOptions {
  allowedOrigins: readonly string[];
  lookup?: (hostname: string) => Promise<RepositoryAddress[]>;
  lookupTimeoutMs?: number;
  /** Test/development escape hatch. Production Cloud configuration should keep this false. */
  allowPrivateAddresses?: boolean;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

export class RepositoryPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly lookup: (hostname: string) => Promise<RepositoryAddress[]>;
  private readonly lookupTimeoutMs: number;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: RepositoryPolicyOptions) {
    this.allowedOrigins = new Set(options.allowedOrigins.map(normalizeAllowedOrigin));
    this.lookup = options.lookup ?? lookupAll;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async validate(
    repositoryUrl: string,
    requestedRef: string,
    signal?: AbortSignal,
  ): Promise<ValidatedRepositoryUrl> {
    assertActive(signal);
    const rawUrl = repositoryUrlSchema.parse(repositoryUrl);
    const safeRef = validateRepositoryRef(requestedRef);
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
    const normalizedUrl = normalizeRepositoryUrl(parsed);
    if (!this.allowedOrigins.has(parsed.origin)) {
      throw new AppError(
        "仓库 origin 未被管理员允许",
        403,
        "REPOSITORY_ORIGIN_FORBIDDEN",
      );
    }
    if (isObviouslyLocalHostname(hostname)) {
      throw new AppError(
        "仓库地址不能指向本机或保留网络",
        403,
        "REPOSITORY_ADDRESS_FORBIDDEN",
      );
    }
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await withTimeout(this.lookup(hostname), this.lookupTimeoutMs, signal);
    assertActive(signal);
    if (addresses.length === 0) {
      throw new AppError(
        "仓库 host 没有可用 DNS 地址",
        422,
        "REPOSITORY_DNS_EMPTY",
      );
    }
    const invalidAddress = addresses.find(({ address }) => !isPublicNetworkAddress(address));
    if (invalidAddress && !this.allowPrivateAddresses) {
      throw new AppError(
        "仓库 DNS 解析到了本机、私网或保留地址",
        403,
        "REPOSITORY_ADDRESS_FORBIDDEN",
      );
    }
    return {
      url: normalizedUrl,
      origin: parsed.origin,
      host: parsed.host,
      hostname,
      requestedRef: safeRef,
      addresses: addresses.map(({ address, family }) => ({ address, family })),
    };
  }
}

export function validateRepositoryRef(value: string): string {
  return repositoryRefSchema.parse(value);
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizeAllowedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Git allowed origin 必须是有效 HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Git allowed origin 必须是没有 path、凭据、query 或 fragment 的 HTTPS origin");
  }
  return parsed.origin;
}

function normalizeRepositoryUrl(parsed: URL): string {
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function lookupAll(hostname: string): Promise<RepositoryAddress[]> {
  const addresses = await nodeLookup(hostname, { all: true, verbatim: true });
  return addresses
    .filter((entry): entry is { address: string; family: 4 | 6 } => (
      entry.family === 4 || entry.family === 6
    ))
    .map(({ address, family }) => ({ address, family }));
}

function isObviouslyLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal");
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) {
    return isPublicNetworkAddress(normalized.slice("::ffff:".length));
  }
  const words = parseIpv6Words(normalized);
  if (!words) return false;
  const first = words[0]!;
  const second = words[1]!;
  // Global unicast is currently 2000::/3. Deny special-purpose allocations
  // inside it rather than assuming every 2xxx/3xxx address is reachable.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second < 0x0200) return false; // 2001::/23 special registry
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // deprecated 6to4
  if (first === 0x3fff && second < 0x1000) return false; // documentation 3fff::/20
  return true;
}

function parseIpv6Words(address: string): number[] | null {
  if (address.includes("%") || address.includes(".")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const raw = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  if (raw.length !== 8 || raw.some((word) => !/^[a-f0-9]{1,4}$/u.test(word))) return null;
  return raw.map((word) => Number.parseInt(word, 16));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Repository DNS timeout 必须是正数");
  }
  assertActive(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(new AppError(
      "仓库操作已取消",
      499,
      "REPOSITORY_CANCELLED",
    )));
    timer = setTimeout(() => {
      finish(() => reject(new AppError(
        "仓库 DNS 查询超时",
        504,
        "REPOSITORY_DNS_TIMEOUT",
      )));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppError("仓库操作已取消", 499, "REPOSITORY_CANCELLED");
}
