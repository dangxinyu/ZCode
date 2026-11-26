// 功能点列表域内 part_of 树形渲染（大分类父文档 → 子主题文档），父节点可折叠。
// 末级文档（无子文档）右键菜单：订正 / 删除（spec: feature-knowledge.md，用户需求 2026-11-26）；
// 分类父不提供菜单（删除有子文档的父被 host 拒绝，订正只针对末级知识文档）。
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FeatureSummary } from "@zcode/services";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeatureKnowledgeGroupedList({
  groups,
  selectedId,
  onOpen,
  onDelete,
  onCorrect,
}: {
  groups: Array<[string, FeatureSummary[]]>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete?: (feature: FeatureSummary) => void;
  onCorrect?: (feature: FeatureSummary) => void;
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
  // 域支持路径（供应链/购销）：按大模块分组，子域嵌套显示；组内再按 part_of 功能分类树。
  const byRoot = new Map<string, Array<[string, FeatureSummary[]]>>();
  for (const [domain, features] of groups) {
    const root = domain.split("/")[0] || domain;
    byRoot.set(root, [...(byRoot.get(root) ?? []), [domain, features]]);
  }
  return (
    <div className="space-y-3">
      {[...byRoot.entries()].map(([root, subGroups]) => (
        <div key={root}>
          <h3 className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
            {root === "__ungrouped__"
              ? intl.formatMessage({ id: "knowledge.domainFallback" })
              : root}
          </h3>
          {subGroups.map(([domain, features]) => {
            const sub = domain.includes("/") ? domain.split("/").slice(1).join("/") : null;
            return (
              <div key={domain} className={sub ? "mt-1 pl-3" : "mt-1"}>
                {sub ? (
                  <h4 className="px-1 text-ui-xs text-foreground-subtle">{sub}</h4>
                ) : null}
                <DomainTree features={features} selectedId={selectedId} onOpen={onOpen} onDelete={onDelete} onCorrect={onCorrect} collapsed={collapsed} toggle={toggle} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DomainTree({
  features,
  selectedId,
  onOpen,
  onDelete,
  onCorrect,
  collapsed,
  toggle,
}: {
  features: FeatureSummary[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete?: (feature: FeatureSummary) => void;
  onCorrect?: (feature: FeatureSummary) => void;
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const renderRow = (feature: FeatureSummary, depth: number, hasChildren: boolean) => {
    const row = (
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
    );
    return (
      <li key={feature.id}>
        {!hasChildren && (onDelete || onCorrect) ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
              {onCorrect ? (
                <ContextMenuItem onSelect={() => onCorrect(feature)}>
                  {intl.formatMessage({ id: "knowledge.correct" })}
                </ContextMenuItem>
              ) : null}
              {onDelete ? (
                <ContextMenuItem variant="destructive" onSelect={() => onDelete(feature)}>
                  {intl.formatMessage({ id: "knowledge.delete" })}
                </ContextMenuItem>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          row
        )}
      </li>
    );
  };
  const ids = new Set(features.map((f) => f.id));
  const childrenOf = new Map<string, FeatureSummary[]>();
  for (const feature of features) {
    const parent = feature.parentFeatureId;
    if (parent && ids.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), feature]);
    }
  }
  const roots = features.filter((f) => !f.parentFeatureId || !ids.has(f.parentFeatureId));
  const renderTree = (feature: FeatureSummary, depth: number): ReactNode[] => {
    const children = childrenOf.get(feature.id) ?? [];
    return [
      renderRow(feature, depth, children.length > 0),
      ...(collapsed.has(feature.id)
        ? []
        : children.flatMap((child) => renderTree(child, depth + 1))),
    ];
  };
  return <ul className="mt-1 space-y-0.5">{roots.flatMap((root) => renderTree(root, 0))}</ul>;
}
