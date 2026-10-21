// 编排终态通知卡片（spec: packages/services/specs/orchestration-tasks.md）。
// 【编排通知】…开头的注入消息（host 下发、以用户消息身份进入会话）不按普通用户
// 气泡渲染：识别前缀后改用系统通知卡片——标题行常显，摘要正文默认收起、点击展开，
// 正文用 Streamdown 渲染 markdown（子任务交付说明常含表格/代码引用，纯文本不可读）。
// 只影响通知卡片；普通用户消息的渲染路径零改动（用户明确要求）。
import { memo, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, Network } from "lucide-react";
import { Streamdown } from "streamdown";
import { cn } from "@/components/lib/utils.js";

export const ORCHESTRATION_NOTICE_PREFIX = "【编排通知】";

export function isOrchestrationNoticeText(text: string | undefined | null): boolean {
  return Boolean(text?.startsWith(ORCHESTRATION_NOTICE_PREFIX));
}

export const ConversationOrchestrationNoticeCard = memo(function ConversationOrchestrationNoticeCard({
  text,
}: {
  text: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // 首行 = 标题（【编排通知】子任务「X」已完成/失败）；其余为摘要正文。
  const withoutPrefix = text.startsWith(ORCHESTRATION_NOTICE_PREFIX)
    ? text.slice(ORCHESTRATION_NOTICE_PREFIX.length)
    : text;
  const firstLineBreak = withoutPrefix.indexOf("\n");
  const title = (firstLineBreak >= 0 ? withoutPrefix.slice(0, firstLineBreak) : withoutPrefix).trim();
  const body = firstLineBreak >= 0 ? withoutPrefix.slice(firstLineBreak + 1).trim() : "";

  return (
    <div
      data-v4-orchestration-notice="true"
      className={cn(
        "flex max-w-full flex-col gap-1 rounded-xl border border-border/70 border-l-2 border-l-status-running",
        "bg-surface/60 px-3.5 py-2.5 text-ui-base text-foreground-subtle",
        "@min-[624px]/conversation:max-w-xl",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <Network aria-hidden="true" className="size-3.5 shrink-0 text-status-running" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {expanded ? (
          <ChevronUpIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtlest" />
        ) : (
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtlest" />
        )}
      </button>
      {expanded && body ? (
        <div className="min-w-0 break-words pl-5 text-foreground-subtle [&_p]:my-1">
          <Streamdown mode="static">{body}</Streamdown>
        </div>
      ) : null}
    </div>
  );
});
