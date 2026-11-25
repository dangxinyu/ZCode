import { BookPlusIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFeatureKnowledgeDistillStore } from "@/store/featureKnowledgeDistillStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

/**
 * 头部「提炼」入口（spec: feature-knowledge.md）。仅当 focused SessionPane 为当前活动会话
 * 登记了控制器（会话已有内容、非只读）时渲染；点击复用 pane 的 handleDistill 发送路径。
 * 图标与知识库入口 BookOpen 同族，不用文字标签。
 */
export function WorkspaceDistillButton({
  activeSessionId,
  useWindowsCaptionSpacing = false,
}: {
  activeSessionId: string | null;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const controller = useFeatureKnowledgeDistillStore((state) =>
    activeSessionId ? state.controllers[activeSessionId] : undefined,
  );
  if (!controller) return null;

  const label = intl.formatMessage({ id: "knowledge.distill" });
  return (
    <ControlHintTooltip title={intl.formatMessage({ id: "knowledge.distillTooltip" })} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={label}
        disabled={controller.disabled}
        onClick={controller.requestDistill}
      >
        <BookPlusIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}