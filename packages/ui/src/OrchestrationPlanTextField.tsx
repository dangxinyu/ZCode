// 计划节点文本字段的 IME 安全受控钩子（用户需求 2026-11-03：节点输入框无法写中文，
// 输入法候选窗一弹出就被强制终止——受控 value 在合成中途被父级重渲染回写会打断 IME）。
// 策略：合成（composition）期间文本只进本地镜像、不提交父级，compositionEnd 一次性提交；
// 外部值变化（撤销/重做、服务端事实补丁、切换编辑节点）仅在非合成期间同步本地。
import { useEffect, useRef, useState } from "react";
import type { ChangeEventHandler, CompositionEventHandler, FormEventHandler } from "react";

export function useImeSafeText<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onCommit: (next: string) => void,
): {
  text: string;
  fieldProps: {
    value: string;
    onChange: ChangeEventHandler<E>;
    onCompositionStart: CompositionEventHandler<E>;
    onCompositionEnd: CompositionEventHandler<E>;
    onBeforeInput: FormEventHandler<E>;
  };
} {
  const [text, setText] = useState(value);
  const composingRef = useRef(false);
  const externalRef = useRef(value);
  useEffect(() => {
    if (externalRef.current !== value && !composingRef.current) {
      externalRef.current = value;
      setText(value);
    }
  }, [value]);
  return {
    text,
    fieldProps: {
      value: text,
      onChange: (event) => {
        const next = event.target.value;
        setText(next);
        // 英文/非合成输入逐键提交（外层对 name/goal 有 1s 合并入撤销栈）；合成期间只进本地镜像。
        if (!composingRef.current) {
          externalRef.current = next;
          onCommit(next);
        }
      },
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: (event) => {
        composingRef.current = false;
        const next = event.currentTarget.value;
        externalRef.current = next;
        setText(next);
        onCommit(next);
      },
      // 合成中途浏览器还会派发 beforeinput（insertCompositionText）；挂空实现只为
      // 显式声明"这些事件不做任何拦截"，避免被上层当成受控改写信号。
      onBeforeInput: () => {},
    },
  };
}
