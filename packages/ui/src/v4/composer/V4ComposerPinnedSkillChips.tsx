/**
 * 常驻 skill chips 行（composer topContent）：当前 pin 名单的常显展示。
 * 新任务草稿屏与会话内共用；点击 chip 打开选择菜单，× 移除单项。
 * 失效态（名字不在当前 catalog）只提示，不自动移除——名单是用户显式意图。
 */
import { memo } from "react";
import { PinIcon, XIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface V4ComposerPinnedSkillChipsProps {
  pinnedSkills: readonly string[];
  /** 当前 catalog 内可用的 skill 名单；用于派生失效态展示。 */
  availableSkillNames: ReadonlySet<string>;
  disabled?: boolean;
  onRemoveSkill: (name: string) => void;
  onOpenPicker: () => void;
}

function V4ComposerPinnedSkillChipsImpl({
  pinnedSkills,
  availableSkillNames,
  disabled = false,
  onRemoveSkill,
  onOpenPicker,
}: V4ComposerPinnedSkillChipsProps) {
  const { intl } = useZCodeIntl();
  if (pinnedSkills.length === 0) return null;

  return (
    <div
      data-testid="v4-composer-pinned-skill-chips"
      className="flex max-w-full flex-wrap items-center gap-2"
    >
      {pinnedSkills.map((name) => {
        const available = availableSkillNames.has(name);
        return (
          <span
            key={name}
            className={cn(
              "group flex h-8 max-w-full select-none items-center gap-1.5 rounded-full bg-surface py-1.5 pl-3 pr-1.5 text-ui-base font-medium",
              available ? "text-foreground" : "text-warning",
            )}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={onOpenPicker}
              className="flex min-w-0 items-center gap-1.5 rounded-full text-left"
              aria-label={intl.formatMessage(
                { id: "chat.toolbar.pinnedSkill.chipOpen" },
                { name },
              )}
            >
              {available ? (
                <PinIcon className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
              )}
              <span className="truncate">{name}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              className="size-5 shrink-0 rounded-full text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={intl.formatMessage(
                { id: "chat.toolbar.pinnedSkill.chipRemove" },
                { name },
              )}
              title={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.chipRemove" })}
              onClick={() => onRemoveSkill(name)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </span>
        );
      })}
    </div>
  );
}

export const V4ComposerPinnedSkillChips = memo(V4ComposerPinnedSkillChipsImpl);
