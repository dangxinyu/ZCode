import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyAgentProcessExitCause,
  WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE,
} from "./agent-crash-diagnostic.js";

test("Windows 0xE0000008 退出码判定为系统内存不足", () => {
  assert.equal(WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE, 0xe0000008);
  assert.equal(
    classifyAgentProcessExitCause(WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE),
    "native_out_of_memory",
  );
});

test("有符号 int32 通道给出的同一退出码按 32 位无符号比较", () => {
  // 0xE0000008 的有符号 int32 表示；个别通道可能给出负值。
  const signed = WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE | 0;
  assert.equal(signed, -536870904);
  assert.equal(classifyAgentProcessExitCause(signed), "native_out_of_memory");
});

test("其他退出码 / 缺失退出码不推断原因", () => {
  // 非零退出、正常退出、信号退出（code=null）与非数值都不给出确定原因。
  assert.equal(classifyAgentProcessExitCause(1), undefined);
  assert.equal(classifyAgentProcessExitCause(0), undefined);
  assert.equal(classifyAgentProcessExitCause(null), undefined);
  assert.equal(classifyAgentProcessExitCause(undefined), undefined);
  assert.equal(classifyAgentProcessExitCause(Number.NaN), undefined);
});
