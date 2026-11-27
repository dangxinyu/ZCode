/**
 * composer 上方状态胶囊行（自官方 v4/ConversationStatusPanel.tsx 的 ComposerStatusRow 搬移）。
 * 只负责居中排布、共享展开身份与窄宽度折叠测量；不复制会话状态。
 * 经 ConversationStatusPanel.tsx re-export，保持官方导入路径。
 */
import {
  createContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

// 胶囊只共享展开身份，不复制会话状态；同一输入框一次只打开一个详情。
const StatusCapsuleContext = createContext<{
  hiddenLabels: readonly string[];
  open: string | null;
  setOpen: Dispatch<SetStateAction<string | null>>;
} | null>(null);

export function ComposerStatusRow({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const [hiddenLabels, setHiddenLabels] = useState<string[]>([]);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    // 按完整文案计算所需宽度，不用折叠后的宽度判断恢复，避免显隐反复跳动。
    const measure = () => {
      const buttons = [...element.querySelectorAll<HTMLElement>("[data-status-capsule]")];
      const sizes = buttons.map((button) => {
        const css = getComputedStyle(button);
        const title = button.querySelector("[data-capsule-label]");
        const range = document.createRange();
        if (title) range.selectNodeContents(title.firstElementChild ?? title);
        const textWidth = title ? range.getBoundingClientRect().width : 0;
        const icon = button.firstElementChild?.getBoundingClientRect().width ?? 0;
        const secondary = button.querySelector("[data-status-capsule-secondary]");
        const fixed =
          icon +
          (secondary?.getBoundingClientRect().width ?? 0) +
          parseFloat(css.paddingLeft) +
          parseFloat(css.paddingRight) +
          parseFloat(css.borderLeftWidth) +
          parseFloat(css.borderRightWidth) +
          parseFloat(css.columnGap) * (secondary ? 2 : 1);
        return {
          id: button.dataset.statusCapsule!,
          full: fixed + textWidth,
          max: parseFloat(css.maxWidth),
        };
      });
      const total =
        sizes.reduce((sum, item) => sum + Math.min(item.full, item.max), 0) +
        Math.max(0, sizes.length - 1) * parseFloat(getComputedStyle(element).columnGap);
      const next = sizes
        .filter(
          (item) =>
            ["todo", "git", "activity"].includes(item.id) &&
            (total > element.clientWidth + 0.5 || item.full > item.max + 0.5),
        )
        .map((item) => item.id);
      setHiddenLabels((previous) => (previous.join() === next.join() ? previous : next));
      buttons.forEach((button) => resize.observe(button));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutation = new MutationObserver(measure);
    mutation.observe(element, { childList: true, characterData: true, subtree: true });
    measure();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
  const value = useMemo(() => ({ open, setOpen, hiddenLabels }), [open, hiddenLabels]);
  return (
    <StatusCapsuleContext.Provider value={value}>
      <div className="@container min-w-0 max-w-full px-3">
        <div
          ref={row}
          data-testid="composer-status-row"
          // 与输入框底部 pb-4、滚动按钮 mb-4 对齐；不叠加顶部 padding。
          className="flex min-w-0 max-w-full items-center justify-center gap-2 pb-4 empty:hidden @max-[640px]:gap-1"
        >
          {children}
        </div>
      </div>
    </StatusCapsuleContext.Provider>
  );
}
