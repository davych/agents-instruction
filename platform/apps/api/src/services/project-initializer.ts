import { fileURLToPath, pathToFileURL } from "node:url";

import { AppError } from "../domain/errors.js";

export interface InitializerOptions {
  cliPath?: string;
  timeoutMs?: number;
}

interface InitializerModule {
  run(
    args: string[],
    context: {
      cwd: string;
      prompt: (question: string) => Promise<string>;
      output: (message: string) => void;
    }
  ): Promise<number>;
}

export async function initializeCodexProject(
  rootPath: string,
  name: string,
  summary: string,
  options: InitializerOptions = {}
): Promise<void> {
  const cliPath = options.cliPath
    ?? fileURLToPath(new URL("../../../../../bin/cli.js", import.meta.url));
  const answers = [
    singleLine(name),
    singleLine(summary) || "由 AI SDLC 平台管理的项目",
    "3",
    "",
    ""
  ];
  let answerIndex = 0;
  let output = "";

  try {
    const initializer = await import(pathToFileURL(cliPath).href) as InitializerModule;
    if (typeof initializer.run !== "function") {
      throw new Error("CLI 未导出 run() 函数");
    }
    const exitCode = await withTimeout(
      initializer.run(["init", rootPath], {
        cwd: rootPath,
        prompt: async () => answers[answerIndex++] ?? "",
        output: (message) => {
          if (output.length < 8_000) output += message;
        }
      }),
      options.timeoutMs ?? 30_000
    );
    if (exitCode !== 0) {
      throw new Error(`exit ${exitCode}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError(
      `项目初始化失败：${detail || output.trim() || "未知错误"}`,
      400,
      "INITIALIZE_FAILED"
    );
  }
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AppError("项目初始化超时", 504, "INITIALIZE_TIMEOUT")),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
