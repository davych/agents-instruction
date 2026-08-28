import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  askProviderConfigurationCheckSchema,
  askProviderIdSchema,
  askProviderProtocolSchema,
  type AskProviderId,
  type AskProviderProtocol,
} from "@ai-sdlc/contracts";
import { z } from "zod";

const CONTROL_DIRECTORY_NAME = ".control-plane";
const KEY_FILE_NAME = "provider-master.key";
const VAULT_FILE_NAME = "provider-config.vault";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_VAULT_BYTES = 1_048_576;
const VAULT_AAD = Buffer.from("ai-sdlc-provider-configuration-v1", "utf8");

const storedProviderConfigurationSchema = z.object({
  providerId: askProviderIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(256)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .nullable(),
  protocol: askProviderProtocolSchema,
  endpoint: z.string().trim().min(1).max(4_096)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .nullable(),
  credential: z.string().min(1).max(16_384)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .nullable(),
  structuredOutput: z.boolean(),
  toolCalling: z.boolean(),
  allowInsecureHttp: z.boolean(),
  version: z.number().int().positive(),
  configVersion: z.number().int().positive(),
  lastCheck: askProviderConfigurationCheckSchema.nullable(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict().superRefine((configuration, context) => {
  if (configuration.version < configuration.configVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message: "Provider Vault 记录版本早于配置版本",
    });
  }
  if (
    configuration.lastCheck
    && (
      configuration.lastCheck.providerId !== configuration.providerId
      || configuration.lastCheck.configVersion !== configuration.configVersion
      || configuration.lastCheck.version > configuration.version
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lastCheck"],
      message: "Provider Vault 检查版本不一致",
    });
  }
  if (configuration.enabled && configuration.lastCheck?.state !== "ready") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["enabled"],
      message: "Provider Vault 中启用的配置没有当前 ready 检查",
    });
  }
});

const providerVaultDocumentSchema = z.object({
  format: z.literal("ai-sdlc-provider-configuration"),
  formatVersion: z.literal(1),
  providers: z.array(storedProviderConfigurationSchema).length(4),
}).strict().superRefine(({ providers }, context) => {
  const ids = providers.map(({ providerId }) => providerId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providers"],
      message: "Provider Vault 包含重复配置",
    });
  }
  for (const expected of askProviderIdSchema.options) {
    if (!ids.includes(expected)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providers"],
        message: `Provider Vault 缺少 ${expected}`,
      });
    }
  }
});

const encryptedEnvelopeSchema = z.object({
  format: z.literal("ai-sdlc-provider-vault"),
  formatVersion: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  nonce: z.string().min(1).max(128),
  authenticationTag: z.string().min(1).max(128),
  ciphertext: z.string().min(1).max(MAX_VAULT_BYTES * 2),
}).strict();

export type StoredProviderConfiguration = z.infer<typeof storedProviderConfigurationSchema>;
export type ProviderVaultDocument = z.infer<typeof providerVaultDocumentSchema>;

export interface ProviderVaultPaths {
  directory: string;
  key: string;
  ciphertext: string;
}

export class ProviderConfigurationVaultError extends Error {
  constructor(message = "Provider 配置 Vault 不可用；API 已拒绝加载或覆盖现有配置") {
    super(message);
    this.name = "ProviderConfigurationVaultError";
  }
}

/**
 * Single-process encrypted Provider configuration store.
 *
 * The key and ciphertext are separate regular files. The key is never written
 * into the encrypted document, database, repository workspace, or Provider
 * registry. Every ciphertext replacement is fsync + same-directory rename +
 * directory fsync, so an interrupted write leaves the previous file intact.
 */
export class ProviderConfigurationVault {
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private document: ProviderVaultDocument,
    private readonly key: Buffer,
    readonly paths: ProviderVaultPaths,
  ) {}

  static async open(managedRoot: string): Promise<ProviderConfigurationVault> {
    const paths = await prepareVaultPaths(managedRoot);
    const [hasKey, hasCiphertext] = await Promise.all([
      fileExists(paths.key),
      fileExists(paths.ciphertext),
    ]);
    if (hasKey !== hasCiphertext) {
      throw new ProviderConfigurationVaultError(
        "Provider 配置 Vault 的主密钥与密文不完整；API 已拒绝创建替代文件",
      );
    }
    const key = await loadOrCreateKey(paths);
    const stored = hasCiphertext ? await loadDocument(paths.ciphertext, key) : null;
    if (hasCiphertext && !stored) throw new ProviderConfigurationVaultError();
    const document = stored ?? createDefaultProviderVaultDocument();
    // A brand-new empty directory is initialized as one explicit key/cipher
    // pair. If the process dies between those operations, the next start sees
    // an incomplete pair and fails closed for operator recovery.
    if (!hasCiphertext) await writeDocument(paths, key, document);
    return new ProviderConfigurationVault(document, key, paths);
  }

  snapshot(): ProviderVaultDocument {
    return structuredClone(this.document);
  }

  async update<T>(
    operation: (draft: ProviderVaultDocument) => T,
  ): Promise<T> {
    const queued = this.operationTail.then(async () => {
      const draft = structuredClone(this.document);
      const result = operation(draft);
      const next = parseVaultDocument(draft);
      await writeDocument(this.paths, this.key, next);
      this.document = next;
      return result;
    });
    this.operationTail = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

export function createDefaultProviderVaultDocument(): ProviderVaultDocument {
  const defaults: Record<AskProviderId, {
    label: string;
    protocol: AskProviderProtocol;
    endpoint: string | null;
    model: string | null;
    structuredOutput: boolean;
    toolCalling: boolean;
  }> = {
    openai: {
      label: "OpenAI",
      protocol: "openai-responses",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      structuredOutput: true,
      toolCalling: true,
    },
    lmstudio: {
      label: "LM Studio",
      protocol: "openai-responses",
      endpoint: "http://127.0.0.1:1234/v1",
      model: null,
      structuredOutput: true,
      toolCalling: false,
    },
    ollama: {
      label: "Ollama",
      protocol: "ollama-chat",
      endpoint: "http://127.0.0.1:11434",
      model: null,
      structuredOutput: true,
      toolCalling: false,
    },
    custom: {
      label: "自定义 Provider",
      protocol: "openai-responses",
      endpoint: null,
      model: null,
      structuredOutput: true,
      toolCalling: false,
    },
  };
  return providerVaultDocumentSchema.parse({
    format: "ai-sdlc-provider-configuration",
    formatVersion: 1,
    providers: askProviderIdSchema.options.map((providerId) => ({
      providerId,
      ...defaults[providerId],
      credential: null,
      allowInsecureHttp: false,
      enabled: false,
      version: 1,
      configVersion: 1,
      lastCheck: null,
      createdAt: null,
      updatedAt: null,
    })),
  });
}

function parseVaultDocument(value: unknown): ProviderVaultDocument {
  try {
    return providerVaultDocumentSchema.parse(value);
  } catch {
    throw new ProviderConfigurationVaultError();
  }
}

async function prepareVaultPaths(managedRoot: string): Promise<ProviderVaultPaths> {
  const resolvedRoot = path.resolve(managedRoot);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(resolvedRoot);
  const directory = path.join(canonicalRoot, CONTROL_DIRECTORY_NAME);
  await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new ProviderConfigurationVaultError();
  }
  assertOwnedByProcess(directoryStats);
  await chmod(directory, 0o700);
  const canonicalDirectory = await realpath(directory);
  if (canonicalDirectory !== directory || path.dirname(canonicalDirectory) !== canonicalRoot) {
    throw new ProviderConfigurationVaultError();
  }
  await assertNoResidualTemporaryFiles(canonicalDirectory);
  return {
    directory,
    key: path.join(directory, KEY_FILE_NAME),
    ciphertext: path.join(directory, VAULT_FILE_NAME),
  };
}

async function assertNoResidualTemporaryFiles(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new ProviderConfigurationVaultError();
  }
  const prefix = `.${VAULT_FILE_NAME}.`;
  if (entries.some((name) => name.startsWith(prefix) && name.endsWith(".tmp"))) {
    // Do not delete an ambiguous interrupted generation. An operator must
    // inspect it and the current ciphertext together before choosing recovery.
    throw new ProviderConfigurationVaultError(
      "Provider 配置 Vault 存在未处理的原子写临时文件；API 已拒绝继续",
    );
  }
}

async function loadOrCreateKey(paths: ProviderVaultPaths): Promise<Buffer> {
  const existing = await readSecureFile(paths.key, KEY_BYTES);
  if (existing) return validateKey(existing);
  if (await fileExists(paths.ciphertext)) {
    throw new ProviderConfigurationVaultError(
      "Provider 配置密文存在但主密钥缺失；API 拒绝生成替代密钥",
    );
  }
  const generated = randomBytes(KEY_BYTES);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      paths.key,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(generated);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(paths.directory);
    return generated;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readSecureFile(paths.key, KEY_BYTES);
      if (raced) return validateKey(raced);
    }
    throw new ProviderConfigurationVaultError();
  }
}

function validateKey(value: Buffer): Buffer {
  if (value.length !== KEY_BYTES) throw new ProviderConfigurationVaultError();
  return Buffer.from(value);
}

async function loadDocument(
  ciphertextPath: string,
  key: Buffer,
): Promise<ProviderVaultDocument | null> {
  const encoded = await readSecureFile(ciphertextPath, MAX_VAULT_BYTES);
  if (!encoded) return null;
  let envelope: z.infer<typeof encryptedEnvelopeSchema>;
  try {
    envelope = encryptedEnvelopeSchema.parse(JSON.parse(encoded.toString("utf8")));
  } catch {
    throw new ProviderConfigurationVaultError();
  }
  const nonce = canonicalBase64(envelope.nonce, NONCE_BYTES);
  const authenticationTag = canonicalBase64(envelope.authenticationTag, TAG_BYTES);
  const ciphertext = canonicalBase64(envelope.ciphertext);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_VAULT_BYTES) throw new ProviderConfigurationVaultError();
    return parseVaultDocument(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof ProviderConfigurationVaultError) throw error;
    throw new ProviderConfigurationVaultError();
  }
}

async function writeDocument(
  paths: ProviderVaultPaths,
  key: Buffer,
  document: ProviderVaultDocument,
): Promise<void> {
  const plaintext = Buffer.from(JSON.stringify(parseVaultDocument(document)), "utf8");
  if (plaintext.length > MAX_VAULT_BYTES) throw new ProviderConfigurationVaultError();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(VAULT_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = encryptedEnvelopeSchema.parse({
    format: "ai-sdlc-provider-vault",
    formatVersion: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  const serialized = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (serialized.length > MAX_VAULT_BYTES) throw new ProviderConfigurationVaultError();
  const temporary = path.join(
    paths.directory,
    `.${VAULT_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.ciphertext);
    await syncDirectory(paths.directory);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new ProviderConfigurationVaultError();
  }
}

async function readSecureFile(filePath: string, maximumBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || stats.size < 1
      || stats.size > maximumBytes
      || (stats.mode & 0o777) !== 0o600
    ) {
      throw new ProviderConfigurationVaultError();
    }
    assertOwnedByProcess(stats);
    return await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ProviderConfigurationVaultError) throw error;
    throw new ProviderConfigurationVaultError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function canonicalBase64(value: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ProviderConfigurationVaultError();
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0
    || decoded.toString("base64") !== value
    || (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new ProviderConfigurationVaultError();
  }
  return decoded;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ProviderConfigurationVaultError();
  }
}

function assertOwnedByProcess(stats: { uid: number }): void {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ProviderConfigurationVaultError();
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | noFollowFlag());
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
