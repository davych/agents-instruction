import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AppError } from "../domain/errors.js";
import { assertRuntimePath } from "./artifact-workspace.js";
import { isWithin } from "./project-paths.js";

export const E2E_WORKSPACE_CONFIG_VERSION = 1 as const;
export const E2E_WORKSPACE_SIDECAR_PATH = ".ai-sdlc/e2e-workspace.json";
export const E2E_TEST_SCRIPT = "test:e2e";
export const E2E_TEST_SCRIPT_COMMAND = "playwright test";
export const DEFAULT_E2E_PLAYWRIGHT_VERSION = "1.62.1";

const npmScriptIdentifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u;
const exactPackageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const safePackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

const configSchema = z.object({
  version: z.literal(E2E_WORKSPACE_CONFIG_VERSION),
  e2eRoot: z.string().trim().min(1),
  packageManager: z.literal("npm"),
  testScript: z.string().regex(npmScriptIdentifier),
  sourceStartScript: z.string().regex(npmScriptIdentifier),
  baseUrl: z.string().url(),
  browser: z.literal("chromium"),
  playwrightVersion: z.string().regex(exactPackageVersion),
}).strict();

export interface E2eWorkspaceConfig {
  version: typeof E2E_WORKSPACE_CONFIG_VERSION;
  e2eRoot: string;
  packageManager: "npm";
  testScript: string;
  sourceStartScript: string;
  baseUrl: string;
  browser: "chromium";
  playwrightVersion: string;
}

export interface InitializeE2eWorkspaceInput {
  productRoot: string;
  e2eRoot: string;
  sourceStartScript: string;
  baseUrl: string;
  playwrightVersion?: string;
  packageName?: string;
}

export type E2eReadinessState = "ready" | "missing" | "invalid" | "failed" | "not_checked";

export interface E2eReadinessComponent {
  state: E2eReadinessState;
  code: string;
  detail: string;
}

export interface E2eWorkspaceReadiness {
  ready: boolean;
  workspace: E2eReadinessComponent;
  package: E2eReadinessComponent;
  startScript: E2eReadinessComponent;
  testScript: E2eReadinessComponent;
  browser: E2eReadinessComponent & {
    executablePath?: string;
    version?: string;
  };
}

export interface BrowserLaunchProbeResult {
  executablePath: string;
  version: string;
}

export type BrowserLaunchProbe = (
  e2eRoot: string,
  timeoutMs: number,
) => Promise<BrowserLaunchProbeResult>;

export interface E2eSetupCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2eSetupProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type E2eSetupProcessRunner = (
  command: string,
  args: readonly string[],
  options: E2eSetupProcessOptions,
) => Promise<E2eSetupCommandResult>;

export interface E2eWorkspacePrepareResult {
  prepared: true;
  commands: Array<{ command: string; args: string[]; cwd: string; exitCode: number }>;
}

export interface E2eWorkspaceServiceOptions {
  allowedRoots: readonly string[];
  browserLaunchProbe?: BrowserLaunchProbe;
  browserProbeTimeoutMs?: number;
  setupProcessRunner?: E2eSetupProcessRunner;
  setupTimeoutMs?: number;
  setupMaxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Owns the file-backed link between a product repository and its standalone
 * E2E project. The sidecar is deliberately a local control file, not database
 * state, so initialized projects can adopt it incrementally.
 */
export class E2eWorkspaceService {
  private readonly allowedRoots: string[];
  private readonly browserLaunchProbe: BrowserLaunchProbe;
  private readonly browserProbeTimeoutMs: number;
  private readonly setupProcessRunner: E2eSetupProcessRunner;
  private readonly setupTimeoutMs: number;
  private readonly setupMaxOutputBytes: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: E2eWorkspaceServiceOptions) {
    if (options.allowedRoots.length === 0) {
      throw new Error("E2E workspace requires at least one allowed root");
    }
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.browserLaunchProbe = options.browserLaunchProbe ?? launchChromiumProbe;
    this.browserProbeTimeoutMs = options.browserProbeTimeoutMs ?? 20_000;
    this.setupProcessRunner = options.setupProcessRunner ?? runSetupProcess;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 10 * 60_000;
    this.setupMaxOutputBytes = options.setupMaxOutputBytes ?? 2 * 1024 * 1024;
    this.environment = options.environment ?? process.env;
  }

  async initialize(input: InitializeE2eWorkspaceInput): Promise<E2eWorkspaceConfig> {
    const productRoot = await this.resolveExistingRoot(input.productRoot, "product");
    assertNoRawTraversal(input.e2eRoot);
    if (!path.isAbsolute(input.e2eRoot)) {
      throw new AppError(
        "E2E workspace root must be an absolute path",
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    const e2eRoot = await this.resolveCandidateRoot(input.e2eRoot);
    assertSeparateRoots(productRoot, e2eRoot);
    assertLocalBaseUrl(input.baseUrl);
    assertScriptIdentifier(input.sourceStartScript, "sourceStartScript");
    const playwrightVersion = input.playwrightVersion ?? DEFAULT_E2E_PLAYWRIGHT_VERSION;
    if (!exactPackageVersion.test(playwrightVersion)) {
      throw new AppError(
        "Playwright version must be an exact package version",
        400,
        "E2E_WORKSPACE_CONFIG_INVALID",
      );
    }
    const packageName = input.packageName ?? `${path.basename(productRoot).toLowerCase()}-e2e`;
    if (!safePackageName.test(packageName)) {
      throw new AppError("E2E package name is invalid", 400, "E2E_WORKSPACE_CONFIG_INVALID");
    }

    const sidecarPath = path.join(productRoot, ...E2E_WORKSPACE_SIDECAR_PATH.split("/"));
    await assertSafeMissingFile(productRoot, sidecarPath);
    const rootWasCreated = await ensureEmptyRoot(e2eRoot);
    const writtenPaths: string[] = [];
    try {
      const packageJsonPath = path.join(e2eRoot, "package.json");
      const playwrightConfigPath = path.join(e2eRoot, "playwright.config.mjs");
      const testsPath = path.join(e2eRoot, "tests");
      const fixturesPath = path.join(e2eRoot, "fixtures");
      await mkdir(testsPath);
      writtenPaths.push(testsPath);
      await mkdir(fixturesPath);
      writtenPaths.push(fixturesPath);
      await writeFile(
        packageJsonPath,
        `${JSON.stringify({
          name: packageName,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { [E2E_TEST_SCRIPT]: E2E_TEST_SCRIPT_COMMAND },
          devDependencies: { "@playwright/test": playwrightVersion },
        }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      writtenPaths.push(packageJsonPath);
      await writeFile(playwrightConfigPath, canonicalPlaywrightConfigSource(), {
        encoding: "utf8",
        flag: "wx",
      });
      writtenPaths.push(playwrightConfigPath);

      const config: E2eWorkspaceConfig = {
        version: E2E_WORKSPACE_CONFIG_VERSION,
        e2eRoot,
        packageManager: "npm",
        testScript: E2E_TEST_SCRIPT,
        sourceStartScript: input.sourceStartScript,
        baseUrl: input.baseUrl,
        browser: "chromium",
        playwrightVersion,
      };
      await writeJsonAtomically(productRoot, sidecarPath, config);
      return config;
    } catch (error) {
      for (const target of writtenPaths.reverse()) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      if (rootWasCreated) {
        await rm(e2eRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async load(productRootInput: string): Promise<E2eWorkspaceConfig> {
    const productRoot = await this.resolveExistingRoot(productRootInput, "product");
    const sidecarPath = path.join(productRoot, ...E2E_WORKSPACE_SIDECAR_PATH.split("/"));
    await assertRuntimePath(productRoot, sidecarPath);
    await assertSafeRegularFile(productRoot, sidecarPath, "E2E workspace sidecar");
    let parsed: E2eWorkspaceConfig;
    try {
      parsed = configSchema.parse(JSON.parse(await readFile(sidecarPath, "utf8")));
    } catch (error) {
      throw new AppError(
        "E2E workspace sidecar is invalid",
        400,
        "E2E_WORKSPACE_CONFIG_INVALID",
        error,
      );
    }
    assertNoRawTraversal(parsed.e2eRoot);
    assertLocalBaseUrl(parsed.baseUrl);
    const e2eRoot = await this.resolveExistingRoot(parsed.e2eRoot, "e2e");
    assertSeparateRoots(productRoot, e2eRoot);
    if (e2eRoot !== parsed.e2eRoot) {
      throw new AppError(
        "E2E workspace root must be stored as its exact canonical path",
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    return { ...parsed, e2eRoot };
  }

  async readiness(productRootInput: string): Promise<E2eWorkspaceReadiness> {
    let config: E2eWorkspaceConfig;
    let productRoot: string;
    try {
      productRoot = await this.resolveExistingRoot(productRootInput, "product");
      config = await this.load(productRoot);
    } catch (error) {
      const detail = safeError(error);
      const unavailable: E2eReadinessComponent = {
        state: "not_checked",
        code: "E2E_WORKSPACE_NOT_READY",
        detail: "Workspace configuration must be valid before this check can run.",
      };
      return {
        ready: false,
        workspace: { state: "invalid", code: errorCode(error), detail },
        package: unavailable,
        startScript: unavailable,
        testScript: unavailable,
        browser: unavailable,
      };
    }

    const productPackage = await readPackageJson(path.join(productRoot, "package.json"), productRoot);
    const e2ePackage = await readPackageJson(
      path.join(config.e2eRoot, "package.json"),
      config.e2eRoot,
    );
    const startScript = packageScriptReadiness(
      productPackage,
      config.sourceStartScript,
      "E2E_SOURCE_START_SCRIPT_MISSING",
    );
    const testScript = packageScriptReadiness(
      e2ePackage,
      config.testScript,
      "E2E_TEST_SCRIPT_MISSING",
      E2E_TEST_SCRIPT_COMMAND,
    );
    const e2eControls = testScript.state === "ready"
      ? await canonicalPlaywrightConfigReadiness(config.e2eRoot)
      : testScript;
    const packageReadiness = await dependencyReadiness(config, e2ePackage);

    let browser: E2eWorkspaceReadiness["browser"];
    if (packageReadiness.state !== "ready") {
      browser = {
        state: "not_checked",
        code: "E2E_BROWSER_NOT_CHECKED",
        detail: "Browser launch is checked only after the locked Playwright package is installed.",
      };
    } else {
      try {
        const result = await this.browserLaunchProbe(config.e2eRoot, this.browserProbeTimeoutMs);
        browser = {
          state: "ready",
          code: "E2E_BROWSER_READY",
          detail: "The configured Chromium launched and closed successfully in headless mode.",
          executablePath: result.executablePath,
          version: result.version,
        };
      } catch (error) {
        const detail = safeError(error);
        const missing = /executable.*(?:doesn.?t exist|missing)|browser.*not.*install/iu.test(detail);
        browser = {
          state: missing ? "missing" : "failed",
          code: missing ? "E2E_BROWSER_MISSING" : "E2E_BROWSER_LAUNCH_FAILED",
          detail,
        };
      }
    }

    const workspace: E2eReadinessComponent = {
      state: "ready",
      code: "E2E_WORKSPACE_READY",
      detail: `Standalone E2E workspace: ${config.e2eRoot}`,
    };
    return {
      ready: [packageReadiness, startScript, e2eControls, browser]
        .every((component) => component.state === "ready"),
      workspace,
      package: packageReadiness,
      startScript,
      testScript: e2eControls,
      browser,
    };
  }

  /**
   * Explicit one-time setup invoked by a user action. Ordinary Verification
   * never calls this method and therefore never downloads dependencies or a
   * browser implicitly.
   */
  async prepare(productRootInput: string): Promise<E2eWorkspacePrepareResult> {
    const config = await this.load(productRootInput);
    const commands: E2eWorkspacePrepareResult["commands"] = [];
    const install = await this.setupProcessRunner(
      "npm",
      ["install", "--ignore-scripts"],
      {
        cwd: config.e2eRoot,
        shell: false,
        env: setupEnvironment(this.environment),
        timeoutMs: this.setupTimeoutMs,
        maxOutputBytes: this.setupMaxOutputBytes,
      },
    );
    commands.push({
      command: "npm",
      args: ["install", "--ignore-scripts"],
      cwd: config.e2eRoot,
      exitCode: install.exitCode,
    });
    if (install.exitCode !== 0) {
      throw new AppError(
        `E2E npm install failed with exit ${install.exitCode}`,
        502,
        "E2E_SETUP_PACKAGE_INSTALL_FAILED",
        { exitCode: install.exitCode, stderrHash: hashE2eFile(install.stderr) },
      );
    }

    const playwrightBinary = path.join(
      config.e2eRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "playwright.cmd" : "playwright",
    );
    await assertSafeLocalExecutable(config.e2eRoot, playwrightBinary);
    const browserInstall = await this.setupProcessRunner(
      playwrightBinary,
      ["install", "chromium"],
      {
        cwd: config.e2eRoot,
        shell: false,
        env: setupEnvironment(this.environment),
        timeoutMs: this.setupTimeoutMs,
        maxOutputBytes: this.setupMaxOutputBytes,
      },
    );
    commands.push({
      command: playwrightBinary,
      args: ["install", "chromium"],
      cwd: config.e2eRoot,
      exitCode: browserInstall.exitCode,
    });
    if (browserInstall.exitCode !== 0) {
      throw new AppError(
        `Playwright Chromium install failed with exit ${browserInstall.exitCode}`,
        502,
        "E2E_SETUP_BROWSER_INSTALL_FAILED",
        { exitCode: browserInstall.exitCode, stderrHash: hashE2eFile(browserInstall.stderr) },
      );
    }
    return { prepared: true, commands };
  }

  private async resolveExistingRoot(candidate: string, label: string): Promise<string> {
    const requested = path.resolve(candidate);
    let stats;
    try {
      stats = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(`${label} root does not exist`, 400, "E2E_WORKSPACE_PATH_MISSING");
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AppError(
        `${label} root must be a real directory, not a symlink`,
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    const canonical = await realpath(requested);
    if (canonical !== requested) {
      throw new AppError(
        `${label} root must use its exact canonical path`,
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    await this.assertAllowed(canonical);
    return canonical;
  }

  private async resolveCandidateRoot(candidate: string): Promise<string> {
    const requested = path.resolve(candidate);
    let cursor = requested;
    const missing: string[] = [];
    while (true) {
      try {
        const stats = await lstat(cursor);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new AppError(
            "E2E workspace path traverses a non-directory or symlink",
            400,
            "E2E_WORKSPACE_PATH_UNSAFE",
          );
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
    const canonical = path.join(await realpath(cursor), ...missing);
    if (canonical !== requested) {
      throw new AppError(
        "E2E workspace path must not traverse symlinks",
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    await this.assertAllowed(canonical);
    return canonical;
  }

  private async assertAllowed(candidate: string): Promise<void> {
    const allowed = await Promise.all(this.allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }));
    if (!allowed.some((root) => isWithin(root, candidate))) {
      throw new AppError(
        "E2E workspace is outside the configured project roots",
        403,
        "E2E_WORKSPACE_PATH_FORBIDDEN",
      );
    }
  }
}

function assertSeparateRoots(productRoot: string, e2eRoot: string): void {
  if (isWithin(productRoot, e2eRoot) || isWithin(e2eRoot, productRoot)) {
    throw new AppError(
      "Product and E2E roots must be distinct, non-nested directories",
      400,
      "E2E_WORKSPACE_ROOTS_OVERLAP",
    );
  }
}

function assertNoRawTraversal(candidate: string): void {
  if (candidate.split(/[\\/]+/u).some((component) => component === "." || component === "..")) {
    throw new AppError(
      "E2E workspace path must not contain . or .. traversal components",
      400,
      "E2E_WORKSPACE_PATH_UNSAFE",
    );
  }
}

function assertScriptIdentifier(value: string, field: string): void {
  if (!npmScriptIdentifier.test(value)) {
    throw new AppError(
      `${field} must be a fixed npm script identifier`,
      400,
      "E2E_WORKSPACE_CONFIG_INVALID",
    );
  }
}

function assertLocalBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("E2E baseUrl is invalid", 400, "E2E_WORKSPACE_CONFIG_INVALID");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    parsed.protocol !== "http:"
    || !localHosts.has(parsed.hostname)
    || Boolean(parsed.username || parsed.password || parsed.hash)
  ) {
    throw new AppError(
      "E2E baseUrl must be an unauthenticated local HTTP URL",
      400,
      "E2E_WORKSPACE_CONFIG_INVALID",
    );
  }
}

async function ensureEmptyRoot(root: string): Promise<boolean> {
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AppError(
        "E2E workspace target must be a real directory",
        400,
        "E2E_WORKSPACE_PATH_UNSAFE",
      );
    }
    if ((await readdir(root)).length > 0) {
      throw new AppError(
        "E2E workspace initialization requires an empty directory",
        409,
        "E2E_WORKSPACE_NOT_EMPTY",
      );
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root);
    return true;
  }
}

async function assertSafeMissingFile(root: string, target: string): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError("Unsafe E2E sidecar path", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const parent = path.dirname(target);
  if (await pathExists(parent)) {
    const parentStats = await lstat(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new AppError("E2E sidecar parent is unsafe", 400, "E2E_WORKSPACE_PATH_UNSAFE");
    }
    if (await pathExists(target)) {
      throw new AppError(
        "E2E workspace is already configured",
        409,
        "E2E_WORKSPACE_ALREADY_CONFIGURED",
      );
    }
  }
}

async function assertSafeRegularFile(root: string, target: string, label: string): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError(`${label} path is unsafe`, 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError(`${label} is missing`, 404, "E2E_WORKSPACE_NOT_CONFIGURED");
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AppError(`${label} must be a regular file`, 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
}

async function writeJsonAtomically(root: string, target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new AppError("E2E sidecar directory is unsafe", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const temporary = path.join(directory, `.e2e-workspace-${randomUUID()}.tmp`);
  if (!isWithin(root, temporary)) {
    throw new AppError("E2E sidecar path escaped product root", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, target);
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

async function readPackageJson(
  target: string,
  root?: string,
): Promise<PackageJsonShape | undefined> {
  try {
    if (root) await assertRuntimePath(root, target);
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
    const parsed = JSON.parse(await readFile(target, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as PackageJsonShape : undefined;
  } catch {
    return undefined;
  }
}

function packageScriptReadiness(
  packageJson: PackageJsonShape | undefined,
  script: string,
  missingCode: string,
  expectedCommand?: string,
): E2eReadinessComponent {
  if (!packageJson) {
    return { state: "missing", code: missingCode, detail: "package.json is missing or invalid." };
  }
  const command = packageJson.scripts?.[script];
  if (typeof command !== "string" || !command.trim()) {
    return { state: "missing", code: missingCode, detail: `npm script ${script} is missing.` };
  }
  if (expectedCommand !== undefined && command !== expectedCommand) {
    return {
      state: "invalid",
      code: "E2E_TEST_SCRIPT_CHANGED",
      detail: `npm script ${script} must remain exactly ${expectedCommand}.`,
    };
  }
  if (expectedCommand !== undefined) {
    const lifecycleHooks = [`pre${script}`, `post${script}`]
      .filter((hook) => Object.prototype.hasOwnProperty.call(packageJson.scripts ?? {}, hook));
    if (lifecycleHooks.length > 0) {
      return {
        state: "invalid",
        code: "E2E_TEST_LIFECYCLE_HOOK_FORBIDDEN",
        detail: `npm lifecycle hooks are forbidden for the fixed E2E script: ${lifecycleHooks.join(", ")}.`,
      };
    }
  }
  return {
    state: "ready",
    code: missingCode.replace(/_MISSING$/u, "_READY"),
    detail: `npm script ${script} is declared.`,
  };
}

async function canonicalPlaywrightConfigReadiness(
  e2eRoot: string,
): Promise<E2eReadinessComponent> {
  const target = path.join(e2eRoot, "playwright.config.mjs");
  try {
    await assertRuntimePath(e2eRoot, target);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
    const content = await readFile(target, "utf8");
    if (content !== canonicalPlaywrightConfigSource()) {
      return {
        state: "invalid",
        code: "E2E_PLAYWRIGHT_CONFIG_CHANGED",
        detail: "playwright.config.mjs differs from the reviewed platform scaffold.",
      };
    }
    return {
      state: "ready",
      code: "E2E_TEST_SCRIPT_READY",
      detail: "The fixed Playwright script and canonical config are intact.",
    };
  } catch {
    return {
      state: "invalid",
      code: "E2E_PLAYWRIGHT_CONFIG_CHANGED",
      detail: "playwright.config.mjs is missing, unsafe, or unreadable.",
    };
  }
}

async function dependencyReadiness(
  config: E2eWorkspaceConfig,
  packageJson: PackageJsonShape | undefined,
): Promise<E2eReadinessComponent> {
  if (!packageJson) {
    return {
      state: "missing",
      code: "E2E_PACKAGE_JSON_MISSING",
      detail: "Standalone E2E package.json is missing or invalid.",
    };
  }
  const declared = packageJson.devDependencies?.["@playwright/test"]
    ?? packageJson.dependencies?.["@playwright/test"];
  if (declared !== config.playwrightVersion) {
    return {
      state: "invalid",
      code: "E2E_PLAYWRIGHT_VERSION_UNPINNED",
      detail: `@playwright/test must be pinned to ${config.playwrightVersion}.`,
    };
  }
  const lockPath = path.join(config.e2eRoot, "package-lock.json");
  let lockReady = false;
  try {
    const lockStats = await lstat(lockPath);
    lockReady = lockStats.isFile() && !lockStats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!lockReady) {
    return {
      state: "missing",
      code: "E2E_PACKAGE_LOCK_MISSING",
      detail: "Run npm install once to create the locked dependency graph.",
    };
  }
  const installed = await readPackageJson(
    path.join(config.e2eRoot, "node_modules", "@playwright", "test", "package.json"),
    config.e2eRoot,
  );
  const installedVersion = (installed as { version?: unknown } | undefined)?.version;
  if (installedVersion !== config.playwrightVersion) {
    return {
      state: "missing",
      code: "E2E_PLAYWRIGHT_NOT_INSTALLED",
      detail: `Installed @playwright/test must exactly match ${config.playwrightVersion}.`,
    };
  }
  return {
    state: "ready",
    code: "E2E_PACKAGE_READY",
    detail: `Locked @playwright/test ${config.playwrightVersion} is installed.`,
  };
}

async function launchChromiumProbe(
  e2eRoot: string,
  timeoutMs: number,
): Promise<BrowserLaunchProbeResult> {
  const source = [
    'const { createRequire } = await import("node:module");',
    'const require = createRequire(`${process.cwd()}/package.json`);',
    'const { chromium } = require("@playwright/test");',
    "const executablePath = chromium.executablePath();",
    "const browser = await chromium.launch({ headless: true });",
    "const version = browser.version();",
    "await browser.close();",
    "process.stdout.write(JSON.stringify({ executablePath, version }));",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: e2eRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: probeEnvironment(process.env),
    detached: process.platform !== "win32",
  });
  const { exitCode, stdout, stderr } = await collectProcess(child, timeoutMs, 128 * 1024, true);
  if (exitCode !== 0) throw new Error(stderr.trim() || `Chromium launch probe exited ${exitCode}`);
  let result: BrowserLaunchProbeResult;
  try {
    result = JSON.parse(stdout) as BrowserLaunchProbeResult;
  } catch {
    throw new Error("Chromium launch probe returned invalid output");
  }
  if (!result.executablePath || !result.version) {
    throw new Error("Chromium launch probe returned incomplete output");
  }
  return result;
}

async function runSetupProcess(
  command: string,
  args: readonly string[],
  options: E2eSetupProcessOptions,
): Promise<E2eSetupCommandResult> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  return collectProcess(child, options.timeoutMs, options.maxOutputBytes, true);
}

async function assertSafeLocalExecutable(root: string, target: string): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError(
      "Playwright executable escaped the E2E workspace",
      400,
      "E2E_SETUP_EXECUTABLE_UNSAFE",
    );
  }
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError(
        "Local Playwright executable is missing after npm install",
        409,
        "E2E_SETUP_EXECUTABLE_MISSING",
      );
    }
    throw error;
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new AppError(
      "Local Playwright executable is not a file",
      400,
      "E2E_SETUP_EXECUTABLE_UNSAFE",
    );
  }
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new AppError(
      "Local Playwright executable resolves outside the E2E workspace",
      400,
      "E2E_SETUP_EXECUTABLE_UNSAFE",
    );
  }
}

function collectProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  maxBytes: number,
  processGroup = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      terminateProcess(child, "SIGKILL", processGroup);
      finish(() => reject(new Error("Chromium launch probe timed out")));
    }, timeoutMs);
    timer.unref();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes < maxBytes) stdout.push(bytes.subarray(0, maxBytes - stdoutBytes));
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxBytes) terminateProcess(child, "SIGKILL", processGroup);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes < maxBytes) stderr.push(bytes.subarray(0, maxBytes - stderrBytes));
      stderrBytes += bytes.length;
      if (stderrBytes > maxBytes) terminateProcess(child, "SIGKILL", processGroup);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (stdoutBytes > maxBytes || stderrBytes > maxBytes) {
        reject(new Error("Chromium launch probe output exceeded the limit"));
      } else {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    }));
  });
}

function terminateProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  if (processGroup && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
        return;
      }
    }
  }
  child.kill(signal);
}

function probeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "PLAYWRIGHT_BROWSERS_PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

function setupEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "PLAYWRIGHT_BROWSERS_PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NPM_CONFIG_REGISTRY", "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

export function canonicalPlaywrightConfigSource(): string {
  return [
    'import { defineConfig } from "@playwright/test";',
    "",
    "const baseURL = process.env.AI_SDLC_E2E_BASE_URL;",
    'if (!baseURL) throw new Error("AI_SDLC_E2E_BASE_URL is required");',
    "",
    "export default defineConfig({",
    '  testDir: "./tests",',
    '  outputDir: "test-results/artifacts",',
    '  reporter: [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]],',
    "  use: {",
    "    baseURL,",
    '    trace: "retain-on-failure",',
    '    screenshot: "only-on-failure",',
    '    video: "retain-on-failure",',
    "  },",
    "});",
    "",
  ].join("\n");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "E2E_WORKSPACE_CHECK_FAILED";
}

export function hashE2eFile(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
