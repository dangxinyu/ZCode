/**
 * 常驻 skill 输入框入口按钮 + 搜索选择菜单。
 *
 * 展示件：名单真值在 composer draft（draftConfig.pinnedSkills），菜单点击只改草稿意图；
 * 会话内改动由宿主（SessionPane）另发 setPinnedSkills 命令同步 runtime。名单失效
 * （skill 被删/改名/禁用）时按当前 catalog 派生展示态，不自动改写用户名单。
 */
import { memo, useMemo, useState } from "react";
import { CheckIcon, PinIcon } from "lucide-react";
import {
  TID_V4_COMPOSER_PINNED_SKILL_ENTRY,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command.js";
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
  draftConfig,
  disabled = false,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSetPinnedSkills,
}: V4ComposerPinnedSkillEntryProps) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const pinned = draftConfig?.pinnedSkills ?? [];
  const isOpen = activeConfigPicker === "pinnedSkill";
  const catalogNames = useMemo(
    () => new Set(skills.map((skill) => skill.name)),
    [skills],
  );
  // 名单内但 catalog 已没有的项：保留展示（可取消勾选），标注失效态。
  const unavailablePinned = pinned.filter((name) => !catalogNames.has(name));
  const label = intl.formatMessage({ id: "chat.toolbar.pinnedSkill.label" });

  const togglePinned = (name: string, next: boolean) => {
    onSetPinnedSkills(
      next ? [...pinned, name] : pinned.filter((pinnedName) => pinnedName !== name),
    );
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        onConfigPickerOpenChange("pinnedSkill", open);
      }}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.tooltip" })}
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
            data-pinned-count={pinned.length}
            aria-label={label}
            className={cn(
              "group/pinned size-7 gap-1 rounded-lg p-0 text-ui-base @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              pinned.length > 0 && "text-brand hover:text-brand",
            )}
          >
            <PinIcon className="size-4 shrink-0" />
            {/* 触发器必须带文字：仅图标无法表达「常驻 Skill」语义；有 pin 时追加数量。
                不挂容器断点折叠——用户明确要求文字常显。 */}
            <span className="max-w-40 truncate whitespace-nowrap">
              {label}
              {pinned.length > 0 ? ` · ${pinned.length}` : ""}
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
          document
            .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
            ?.focus();
        }}
      >
        <Command
          className="bg-transparent p-0 text-foreground"
          filter={pinnedSkillSearchFilter}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.searchPlaceholder" })}
            className="h-8"
          />
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-4 text-ui-sm text-foreground-subtle">
              {skills.length === 0
                ? intl.formatMessage({ id: "chat.toolbar.pinnedSkill.empty" })
                : intl.formatMessage({ id: "chat.toolbar.pinnedSkill.noMatch" })}
            </CommandEmpty>
            <CommandGroup className="p-1">
              {skills.map((skill) => {
                const checked = pinned.includes(skill.name);
                return (
                  <CommandItem
                    key={skill.id}
                    value={skill.name}
                    keywords={[skill.description]}
                    data-checked={checked ? "true" : undefined}
                    disabled={disabled}
                    data-testid={testId(TID_V4_COMPOSER_PINNED_SKILL_ENTRY, skill.name)}
                    className="items-start gap-2.5 rounded-lg px-2.5 py-2 text-ui-base"
                    onSelect={() => togglePinned(skill.name, !checked)}
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
            {unavailablePinned.length > 0 && (
              <CommandGroup
                heading={intl.formatMessage({ id: "chat.toolbar.pinnedSkill.unavailableGroup" })}
                className="p-1 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-sm **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {unavailablePinned.map((name) => (
                  <CommandItem
                    key={`unavailable:${name}`}
                    value={name}
                    data-testid={testId(TID_V4_COMPOSER_PINNED_SKILL_ENTRY, `unavailable:${name}`)}
                    className="items-start gap-2.5 rounded-lg px-2.5 py-2 text-ui-base"
                    onSelect={() => togglePinned(name, false)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui-base font-medium text-warning">{name}</div>
                      <div className="truncate pt-0.5 text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: "chat.toolbar.pinnedSkill.unavailable" })}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const V4ComposerPinnedSkillEntry = memo(V4ComposerPinnedSkillEntryImpl);
