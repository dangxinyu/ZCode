// 功能点列表域内 part_of 树形渲染（大分类父文档 → 子主题文档），父节点可折叠。
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FeatureSummary } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeatureKnowledgeGroupedList({
  groups,
  selectedId,
  onOpen,
}: {
  groups: Array<[string, FeatureSummary[]]>;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const renderRow = (feature: FeatureSummary, depth: number, hasChildren: boolean) => (
    <li key={feature.id}>
      <div
        className={`flex w-full items-center rounded-md text-ui-sm hover:bg-surface-hover ${
          selectedId === feature.id ? "bg-muted font-medium" : ""
        }`}
        style={depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: collapsed.has(feature.id) ? "knowledge.expand" : "knowledge.collapse",
            })}
            aria-expanded={!collapsed.has(feature.id)}
            onClick={() => toggle(feature.id)}
            className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle hover:text-foreground"
          >
            {collapsed.has(feature.id) ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onOpen(feature.id)}
          className="min-w-0 flex-1 truncate px-1 py-1.5 text-left"
        >
          {feature.name}
        </button>
      </div>
    </li>
  );
  return (
    <div className="space-y-3">
      {groups.map(([domain, features]) => {
        // part_of 层级：大分类父文档 → 子主题文档；父不在本域时子按顶层渲染。
        const ids = new Set(features.map((f) => f.id));
        const childrenOf = new Map<string, FeatureSummary[]>();
        for (const feature of features) {
          const parent = feature.parentFeatureId;
          if (parent && ids.has(parent)) {
            childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), feature]);
          }
        }
        const roots = features.filter(
          (f) => !f.parentFeatureId || !ids.has(f.parentFeatureId),
        );
        const renderTree = (feature: FeatureSummary, depth: number): ReactNode[] => {
          const children = childrenOf.get(feature.id) ?? [];
          return [
            renderRow(feature, depth, children.length > 0),
            ...(collapsed.has(feature.id)
              ? []
              : children.flatMap((child) => renderTree(child, depth + 1))),
          ];
        };
        return (
          <div key={domain}>
            <h3 className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
              {domain === "__ungrouped__"
                ? intl.formatMessage({ id: "knowledge.domainFallback" })
                : domain}
            </h3>
            <ul className="mt-1 space-y-0.5">
              {roots.flatMap((root) => renderTree(root, 0))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}