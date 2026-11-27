/**
 * Agent runtime 进程意外退出的原因分类（自官方 agent-crash-diagnostic 搬移的子集）。
 * 纯函数、无 IO；完整 crash 诊断 / 脱敏上报不在本仓库当前范围。
 */

/**
 * Chromium / PartitionAlloc 在 Windows 上内存分配失败时用来终止进程的异常码
 * （base 与 partition_alloc 中的 kOomExceptionCode）。Agent runtime 以 ELECTRON_RUN_AS_NODE
 * 运行在同一个 Electron 可执行文件里，系统可提交内存耗尽时以它退出，且不写 stderr。
 */
export const WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE = 0xe0000008;

export type AgentProcessExitCause = "native_out_of_memory";

/**
 * 只认能确定说明原因的退出码。其他平台没有同等确定的签名：Linux/macOS 上 Chromium 分配失败走
 * IMMEDIATE_CRASH（SIGTRAP/SIGILL，与任意 CHECK 失败相同），内核 OOM killer 与 macOS jetsam
 * 发 SIGKILL（与手动 kill -9 相同），因此不按信号推断内存不足。
 */
export function classifyAgentProcessExitCause(
  exitCode: number | null | undefined,
): AgentProcessExitCause | undefined {
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) return undefined;
  // Windows 退出码是 DWORD；Node 报无符号值，个别通道可能给出有符号 int32，统一按 32 位无符号比较。
  return exitCode >>> 0 === WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE
    ? "native_out_of_memory"
    : undefined;
}
