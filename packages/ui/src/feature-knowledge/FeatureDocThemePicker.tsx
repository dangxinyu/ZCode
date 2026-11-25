// 主题清单勾选（侦察计划人闸）：主题↔文档↔功能点多对多展示。
import type { FeatureDocThemePlan } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeatureDocThemePicker({
  plan,
  selection,
  busy,
  onToggle,
}: {
  plan: FeatureDocThemePlan;
  selection: Record<string, boolean>;
  busy: boolean;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border p-2">
      <p className="px-1 py-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "knowledge.analyzeThemesHint" })}
      </p>
      {plan.themes.map((theme) => (
        <label
          key={theme.name}
          className="flex items-start gap-2 rounded-md px-1 py-1.5 text-ui-sm hover:bg-surface-hover"
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={Boolean(selection[theme.name])}
            disabled={busy}
            onChange={(event) => onToggle(theme.name, event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-foreground">{theme.name}</span>
            <span className="block text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "knowledge.analyzeThemeDocs" },
                { count: theme.docPaths.length },
              )}
              {theme.features.length > 0
                ? ` · ${theme.features.map((feature) => feature.name).join("、")}`
                : ""}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}