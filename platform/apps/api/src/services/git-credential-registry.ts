import {
  credentialProfileIdSchema,
  credentialProfileSummarySchema,
  type CredentialProfileSummaryDto,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../domain/errors.js";
import type { ValidatedRepositoryUrl } from "./repository-policy.js";

const profileConfigSchema = z.object({
  id: credentialProfileIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  origin: z.string().trim().min(1).max(500),
  username: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .default("git"),
  secretEnv: z.string().trim().min(1).max(200)
    .regex(/^[A-Z_][A-Z0-9_]*$/u),
}).strict();

const profileListSchema = z.array(profileConfigSchema).max(200);

interface RegisteredCredentialProfile {
  id: string;
  label: string;
  origin: string;
  host: string;
  username: string;
  secretEnv: string;
  secret: string | null;
}

export interface ResolvedGitCredential {
  profileId: string;
  username: string;
  secret: string;
}

export class GitCredentialRegistry {
  private readonly profiles: ReadonlyMap<string, RegisteredCredentialProfile>;

  constructor(profiles: readonly RegisteredCredentialProfile[]) {
    const byId = new Map<string, RegisteredCredentialProfile>();
    for (const profile of profiles) {
      if (byId.has(profile.id)) throw new Error(`Git Credential Profile ID 重复：${profile.id}`);
      byId.set(profile.id, { ...profile });
    }
    this.profiles = byId;
  }

  summaries(host?: string): CredentialProfileSummaryDto[] {
    const normalizedHost = host?.trim().toLowerCase();
    return [...this.profiles.values()]
      .filter((profile) => !normalizedHost || profile.host === normalizedHost)
      .map((profile) => credentialProfileSummarySchema.parse({
        id: profile.id,
        label: profile.label,
        host: profile.host,
        available: profile.secret !== null,
      }))
      .sort((left, right) => compareText(left.id, right.id));
  }

  summary(id: string): CredentialProfileSummaryDto | null {
    const profile = this.profiles.get(id);
    if (!profile) return null;
    return credentialProfileSummarySchema.parse({
      id: profile.id,
      label: profile.label,
      host: profile.host,
      available: profile.secret !== null,
    });
  }

  resolve(
    id: string | null | undefined,
    repository: Pick<ValidatedRepositoryUrl, "origin">,
  ): ResolvedGitCredential | null {
    if (!id) return null;
    const profile = this.profiles.get(id);
    if (!profile || !profile.secret) {
      throw new AppError(
        "所选 Git Credential Profile 不存在或 Secret 未配置",
        422,
        "GIT_CREDENTIAL_UNAVAILABLE",
      );
    }
    if (profile.origin !== repository.origin) {
      throw new AppError(
        "Git Credential Profile 与仓库 origin 不匹配",
        403,
        "GIT_CREDENTIAL_ORIGIN_MISMATCH",
      );
    }
    return {
      profileId: profile.id,
      username: profile.username,
      secret: profile.secret,
    };
  }
}

export function createGitCredentialRegistryFromEnv(
  environment: NodeJS.ProcessEnv,
): GitCredentialRegistry {
  const encoded = environment.AI_SDLC_GIT_CREDENTIAL_PROFILES?.trim();
  if (!encoded) return new GitCredentialRegistry([]);
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    throw new Error("AI_SDLC_GIT_CREDENTIAL_PROFILES 必须是有效 JSON array");
  }
  const configs = profileListSchema.parse(raw);
  const profiles = configs.map((config): RegisteredCredentialProfile => {
    const parsedOrigin = parseExactOrigin(config.origin);
    const rawSecret = environment[config.secretEnv];
    const secret = rawSecret === undefined || rawSecret === ""
      ? null
      : validateSecret(rawSecret);
    return {
      ...config,
      origin: parsedOrigin.origin,
      host: parsedOrigin.host.toLowerCase(),
      secret,
    };
  });
  return new GitCredentialRegistry(profiles);
}

function parseExactOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Git Credential Profile origin 必须是有效 HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Git Credential Profile origin 必须是精确 HTTPS origin");
  }
  return parsed;
}

function validateSecret(value: string): string {
  if (value.length > 16_384 || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Git Credential Secret 格式无效");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
