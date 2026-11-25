// 功能点活文档阅读（spec: packages/services/specs/feature-knowledge.md）。
// 当前版文档 + 别名/代码锚点 + 版本历史（只读）+ 关联功能点跳转。
import { useState } from "react";
import type { FeatureDetail, FeatureSummary } from "@zcode/services";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";

export interface FeatureKnowledgeDetailProps {
  detail: FeatureDetail;
  theme: Theme;
  featureNameById: Record<string, string>;
  onOpenFeature: (id: string) => void;
  /** part_of 层级：所属父文档（大分类）与子主题文档。 */
  parent?: FeatureSummary | null;
  children?: FeatureSummary[];
  /** 手动层级管理：可选父文档集合与设置/新建父文档动作。 */
  categoryOptions?: FeatureSummary[];
  onSetParent?: (featureId: string, parentFeatureId: string | null) => void;
  onCreateCategory?: (name: string, domain: string) => void;
}

export function FeatureKnowledgeDetail({
  detail,
  theme,
  featureNameById,
  onOpenFeature,
  parent = null,
  children = [],
  categoryOptions = [],
  onSetParent,
  onCreateCategory,
}: FeatureKnowledgeDetailProps) {
  const { intl } = useZCodeIntl();
  const [newParentName, setNewParentName] = useState("");
  const { feature, versions, relations } = detail;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-lg font-semibold text-foreground">{feature.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-ui-xs text-muted-foreground">
          <span>{feature.domain || intl.formatMessage({ id: "knowledge.domainFallback" })}</span>
          <span>·</span>
          <span>
            {intl.formatMessage({ id: "knowledge.versions" })} v{feature.currentVersion}
          </span>
        </div>
        {feature.aliases.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-ui-xs text-muted-foreground">
              {intl.formatMessage({ id: "knowledge.aliases" })}:
            </span>
            {feature.aliases.map((alias) => (
              <Badge key={alias} variant="secondary" className="h-5 px-2 text-ui-xs">
                {alias}
              </Badge>
            ))}
          </div>
        ) : null}
        {feature.anchors.length > 0 ? (
          <div className="mt-2 space-y-1">
            <span className="text-ui-xs text-muted-foreground">
              {intl.formatMessage({ id: "knowledge.anchors" })}:
            </span>
            {feature.anchors.map((anchor, index) => (
              <div key={index} className="font-mono text-ui-xs text-muted-foreground">
                {anchor.repo ? `${anchor.repo} · ` : ""}
                {anchor.paths.join(", ")}
                {anchor.symbols && anchor.symbols.length > 0 ? ` · ${anchor.symbols.join(", ")}` : ""}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
        <MessageResponse className="min-w-0 break-words" theme={theme}>
          {feature.docMd}
        </MessageResponse>
      </div>

      {parent || children.length > 0 || onSetParent ? (
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "knowledge.hierarchy" })}
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {parent ? (
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-ui-xs text-foreground hover:bg-surface-hover"
                onClick={() => onOpenFeature(parent.id)}
              >
                {intl.formatMessage({ id: "knowledge.parentDoc" })} · {parent.name}
              </button>
            ) : null}
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                className="rounded-md border border-border px-2 py-1 text-ui-xs text-foreground hover:bg-surface-hover"
                onClick={() => onOpenFeature(child.id)}
              >
                {intl.formatMessage({ id: "knowledge.childDoc" })} · {child.name}
              </button>
            ))}
          </div>
          {onSetParent ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={parent?.id ?? ""}
                onChange={(event) =>
                  onSetParent(feature.id, event.target.value ? event.target.value : null)
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-ui-xs text-foreground"
              >
                <option value="">{intl.formatMessage({ id: "knowledge.noParent" })}</option>
                {categoryOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              {onCreateCategory ? (
                <>
                  <input
                    value={newParentName}
                    onChange={(event) => setNewParentName(event.target.value)}
                    placeholder={intl.formatMessage({ id: "knowledge.newCategoryPlaceholder" })}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-ui-xs text-foreground"
                  />
                  <button
                    type="button"
                    disabled={!newParentName.trim()}
                    onClick={() => {
                      onCreateCategory(newParentName.trim(), feature.domain);
                      setNewParentName("");
                    }}
                    className="rounded-md border border-border px-2 py-1 text-ui-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
                  >
                    {intl.formatMessage({ id: "knowledge.newCategory" })}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {relations.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "knowledge.relations" })}
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {relations.map((relation) => (
              <button
                key={`${relation.toId}:${relation.kind}`}
                type="button"
                className="rounded-md border border-border px-2 py-1 text-ui-xs text-foreground hover:bg-surface-hover"
                onClick={() => onOpenFeature(relation.toId)}
              >
                {relation.kind} · {featureNameById[relation.toId] ?? relation.toId}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-border px-4 py-3">
        <h3 className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "knowledge.versions" })}
        </h3>
        <ul className="mt-2 space-y-1">
          {versions.map((version) => (
            <li key={version.version} className="text-ui-xs text-muted-foreground">
              <span className="font-mono">v{version.version}</span>
              {" · "}
              {new Date(version.createdAt).toLocaleString()}
              {version.changeSummary ? ` · ${version.changeSummary}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}