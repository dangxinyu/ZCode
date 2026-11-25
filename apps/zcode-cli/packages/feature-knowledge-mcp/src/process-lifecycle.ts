// stdio MCP 进程生命周期守卫（先例 node-repl-host/process-lifecycle.ts）。
// 父进程退出 / 输出管道关闭时优雅 shutdown，避免孤儿进程；异步错误降级 stderr 不击穿协议 stdout。
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUTPUT_CLOSED_ERROR_CODES = new Set(["EPIPE", "EIO", "ENXIO", "EBADF", "ERR_STREAM_DESTROYED"]);

function isOutputClosedError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && OUTPUT_CLOSED_ERROR_CODES.has(code);
}

export function installMcpProcessGuards(input: {
  onOutputClosed: (error: Error) => void;
  process: Pick<NodeJS.Process, "on">;
  writeStderr: (text: string) => void;
}): void {
  let outputClosed = false;
  const describe = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  const report = (kind: string, reason: unknown): void => {
    if (outputClosed) return;
    if (isOutputClosedError(reason)) {
      outputClosed = true;
      input.onOutputClosed(reason);
      return;
    }
    try {
      input.writeStderr(`feature_knowledge ${kind} (process kept alive): ${describe(reason)}\n`);
    } catch (error) {
      if (!isOutputClosedError(error)) throw error;
      outputClosed = true;
      input.onOutputClosed(error);
    }
  };
  input.process.on("unhandledRejection", (reason) => report("unhandledRejection", reason));
  input.process.on("uncaughtException", (error) => report("uncaughtException", error));
}

export function installMcpShutdownTriggers(input: {
  process: Pick<NodeJS.Process, "once">;
  shutdown: () => void;
  stdin: Pick<NodeJS.ReadStream, "once">;
}): void {
  let shutdownStarted = false;
  const shutdownOnce = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    input.shutdown();
  };
  // stdio transport 不监听 stdin end/close；父进程异常退出时据此收尾，不做孤儿。
  input.stdin.once("end", shutdownOnce);
  input.stdin.once("close", shutdownOnce);
  input.process.once("SIGINT", shutdownOnce);
  input.process.once("SIGTERM", shutdownOnce);
}

export async function isDirectMcpEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined,
): Promise<boolean> {
  if (!argvPath) return false;
  try {
    // macOS /tmp、/var 解析到 /private/...；realpath 兼容 symlink 安装目录，避免误判“被 import”。
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(importMetaUrl)),
      realpath(argvPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return false;
  }
}