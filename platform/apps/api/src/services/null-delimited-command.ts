import { spawn } from "node:child_process";

export type NullDelimitedCommandFailureReason =
  | "aborted"
  | "timeout"
  | "spawn"
  | "exit"
  | "stderr-limit"
  | "record-limit"
  | "malformed";

export class NullDelimitedCommandError extends Error {
  constructor(
    readonly reason: NullDelimitedCommandFailureReason,
    readonly exitCode: number | null = null,
    readonly systemCode?: string,
  ) {
    super(`NUL-delimited command failed: ${reason}`);
    this.name = "NullDelimitedCommandError";
  }
}

export interface NullDelimitedCommandOptions {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStderrBytes: number;
  maxRecordBytes: number;
  signal?: AbortSignal;
  /** Return false after a complete record to finish successfully as truncated. */
  onRecord: (record: Buffer) => boolean;
}

/**
 * Streams a NUL-delimited command without retaining aggregate stdout. Only the
 * unfinished record is buffered, so callers can enforce their semantic item
 * limit before a long repository listing consumes an aggregate output buffer.
 */
export function streamNullDelimitedCommand(
  options: NullDelimitedCommandOptions,
): Promise<{ truncated: boolean }> {
  if (options.signal?.aborted) {
    return Promise.reject(new NullDelimitedCommandError("aborted"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let pending = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let stoppedEarly = false;
    let failure: Error | undefined;

    const stopWithFailure = (error: Error): void => {
      if (failure || stoppedEarly || settled) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const stopSuccessfully = (): void => {
      if (failure || stoppedEarly || settled) return;
      stoppedEarly = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stopWithFailure(new NullDelimitedCommandError("timeout")),
      options.timeoutMs,
    );
    const abort = (): void => stopWithFailure(new NullDelimitedCommandError("aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (failure || stoppedEarly || settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const input = pending.length > 0 ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      while (start < input.length) {
        const separator = input.indexOf(0, start);
        if (separator < 0) break;
        const record = input.subarray(start, separator);
        if (record.length > options.maxRecordBytes) {
          stopWithFailure(new NullDelimitedCommandError("record-limit"));
          return;
        }
        try {
          if (!options.onRecord(record)) {
            stopSuccessfully();
            return;
          }
        } catch (error) {
          stopWithFailure(error instanceof Error
            ? error
            : new NullDelimitedCommandError("malformed"));
          return;
        }
        start = separator + 1;
      }
      pending = Buffer.from(input.subarray(start));
      if (pending.length > options.maxRecordBytes) {
        stopWithFailure(new NullDelimitedCommandError("record-limit"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (failure || stoppedEarly || settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > options.maxStderrBytes) {
        stopWithFailure(new NullDelimitedCommandError("stderr-limit"));
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure ?? new NullDelimitedCommandError("spawn", null, error.code));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      if (stoppedEarly) {
        resolve({ truncated: true });
        return;
      }
      if (code !== 0) {
        reject(new NullDelimitedCommandError("exit", code));
        return;
      }
      if (pending.length > 0) {
        reject(new NullDelimitedCommandError("malformed", code));
        return;
      }
      resolve({ truncated: false });
    });

    function cleanup(): void {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  });
}
