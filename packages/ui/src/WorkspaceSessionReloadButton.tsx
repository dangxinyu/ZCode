import { TID_SESSION_RELOAD } from "@zcode/shared";
import { RefreshCwIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import type { WorkspaceHeaderReloadSessionOptions } from "@/WorkspaceHeaderSections/shared.js";

/**
 * 头部「刷新当前对话」按钮。复用 onReloadSession 既有链路（workspace 进程重建 + resume
 * 当前任务，入口自带防抖/pending/toast），按钮本身不另起一条会话重建路径。
 */
export function WorkspaceSessionReloadButton({
  onReloadSession,
  disabled = false,
  pending = false,
  useWindowsCaptionSpacing = false,
}: {
  onReloadSession?: (options?: WorkspaceHeaderReloadSessionOptions) => void | Promise<void>;
  disabled?: boolean;
  pending?: boolean;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "workspaceHeader.reloadConversation" });

  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SESSION_RELOAD}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={label}
        disabled={!onReloadSession || disabled || pending}
        onClick={() => void onReloadSession?.()}
      >
        <RefreshCwIcon className={cn("size-4", pending && "animate-spin")} />
      </Button>
    </ControlHintTooltip>
  );
}
