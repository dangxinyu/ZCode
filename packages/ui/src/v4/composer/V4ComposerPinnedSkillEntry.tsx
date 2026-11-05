/**
 * 常驻 skill 输入框入口按钮 + 搜索选择菜单（单选）。
 *
 * 触发器直接显示当前选中的 skill 名（未选时显示「常驻 Skill」占位），不再有独立
 * chips 行与计数。名单真值在 composer draft（draftConfig.pinnedSkills，0/1 个元素），
 * 菜单点击只改草稿意图；会话内改动由宿主（SessionPane）另发 setPinnedSkills 命令
 * 同步 runtime。选中的 skill 失效（被删/改名/禁用）时按当前 catalog 派生展示态，
 * 不自动改写用户名单。
 */
import { memo, useMemo } from "react";
import { CheckIcon, PinIcon } from "lucide-react";
import { TID_V4_COMPOSER_PINNED_SKILL_ENTRY, TID_V4_COMPOSER_INPUT, testId } from "@zcode/shared";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

export interface V4ComposerPinnedSkillEntryProps {
  /** Skill catalog（宿主统一拉取，与 $ 面板同源快照）。 */
  skills: readonly ZCodeSkillReferenceCatalogEntry[];
  /** catalog 拉取中；为真且列表为空时显示加载态，不再误报「没有可用的 Skill」。 */
  loading?: boolean;
  /** catalog 拉取失败（重试耗尽）；为真且列表为空时显示失败态而非「没有可用的 Skill」。 */
  error?: string | null;
  draftConfig?: Partial<SessionConfigState>;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSetPinnedSkills: (skills: string[]) => void;
}

/** 前缀命中优先、包含次之；都不命中返回 -1 让 cmdk 过滤掉。 */
function pinnedSkillSearchFilter(value: string, search: string): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  const haystack = value.toLowerCase();
  if (haystack.startsWith(needle)) return 2;
  if (haystack.includes(needle)) return 1;
  return -1;
}

function V4ComposerPinnedSkillEntryImpl({
  skills,
  loading = false,
  error = null,
  draftConfig,
  disabled = false,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSetPinnedSkills,
}: V4ComposerPinnedSkillEntryProps) {
  const { intl } = useZCodeIntl();
  // 单选语义：名单最多一个元素（协议仍为 array，UI 约束长度 ≤1，兼容旧多选草稿取第一个）。
  const selected = draftConfig?.pinnedSkills?.[0];
  const catalogNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);
  const selectedUnavailable = selected !== undefined && !catalogNames.has(selected);
  const isOpen = activeConfigPicker === "pinnedSkill";
  const placeholderLabel = intl.formatMessage({ id: "chat.toolbar.pinnedSkill.label" });

  const togglePinned = (name: string) => {
    // 再点已选项 = 取消；点其他项 = 替换。
    onSetPinnedSkills(selected === name ? [] : [name]);
  };

  return (
    <Popover open={isOpen} onOpenChange={(open) => onConfigPickerOpenChange("pinnedSkill", open)}>
      <ControlHintTooltip
        title={
          selected !== undefined
            ? intl.formatMessage(
                { id: "chat.toolbar.pinnedSkill.tooltipSelected" },
                { name: selected },
              )
            : intl.formatMessage({ id: "chat.toolbar.pinnedSkill.tooltip" })
        }
        open={isOpen ? false : undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid={TID_V4_COMPOSER_PINNED_SKILL_ENTRY}
            data-composer-collapse-priority="2"
            data-pinned-skill={selected ?? ""}
            aria-label={selected ?? placeholderLabel}
            className={cn(
              "group/pinned size-7 gap-1 rounded-lg p-0 text-ui-base @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              selected !== undefined && !selectedUnavailable && "text-brand hover:text-brand",
              selectedUnavailable && "text-warning hover:text-warning",
            )}
          >
            <PinIcon className="size-4 shrink-0" />
            {/* 触发器显示当前选中 skill 名；未选时显示占位文案。不挂容器断点折叠。 */}
            <span
              className={cn(
                "max-w-40 truncate whitespace-nowrap",
                selectedUnavailable && "text-warning",
              )}
            >
              {selected ?? placeholderLabel}
            </span>
          </Button>
        </PopoverTrigger>
      </ControlHintTooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 gap-0 bg-menu p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (isCoarseTouchDevice()) return;
          const target = event.currentTarget;
          if (!(target instanceof HTMLElement)) return;
          target.querySelector<HTMLElement>('[data-slot="command-input"]')?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (isCoarseTouchDevice()) return;
          document.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)?.focus();
        }}
      >
        <Command className="bg-transparent p-0 text-foreground" filter={pinnedSkillSearchFilter}>
          <CommandInput
            placeholder={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.searchPlaceholder" })}
            className="h-8"
          />
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-4 text-ui-sm text-foreground-subtle">
              {skills.length > 0
                ? intl.formatMessage({ id: "chat.toolbar.pinnedSkill.noMatch" })
                : error
                  ? intl.formatMessage({ id: "chat.toolbar.pinnedSkill.loadFailed" })
                  : loading
                    ? intl.formatMessage({ id: "chat.toolbar.pinnedSkill.loading" })
                    : intl.formatMessage({ id: "chat.toolbar.pinnedSkill.empty" })}
            </CommandEmpty>
            <CommandGroup className="p-1">
              {skills.map((skill) => {
                const checked = selected === skill.name;
                return (
                  <CommandItem
                    key={skill.id}
                    value={skill.name}
                    keywords={[skill.description]}
                    data-checked={checked ? "true" : undefined}
                    disabled={disabled}
                    data-testid={testId(TID_V4_COMPOSER_PINNED_SKILL_ENTRY, skill.name)}
                    className="items-start gap-2.5 rounded-lg px-2.5 py-2 text-ui-base"
                    onSelect={() => togglePinned(skill.name)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui-base font-medium text-foreground">
                        {skill.name}
                      </div>
                      {skill.description && (
                        <div className="truncate pt-0.5 text-ui-sm text-foreground-subtle">
                          {skill.description}
                        </div>
                      )}
                    </div>
                    <CheckIcon
                      className={cn(
                        "mt-0.5 size-4 shrink-0 text-brand",
                        checked ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selectedUnavailable && (
              <CommandGroup
                heading={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.unavailableGroup" })}
                className="p-1 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-sm **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                <CommandItem
                  value={selected}
                  data-testid={testId(
                    TID_V4_COMPOSER_PINNED_SKILL_ENTRY,
                    `unavailable:${selected}`,
                  )}
                  className="items-start gap-2.5 rounded-lg px-2.5 py-2 text-ui-base"
                  onSelect={() => togglePinned(selected)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui-base font-medium text-warning">{selected}</div>
                    <div className="truncate pt-0.5 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "chat.toolbar.pinnedSkill.unavailable" })}
                    </div>
                  </div>
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const V4ComposerPinnedSkillEntry = memo(V4ComposerPinnedSkillEntryImpl);
