// 订正上下文 chip（spec: feature-knowledge.md）：composer 上方唯一可见面「订正 · {文档名}」，
// 隐藏全文只在 hover 浮层展示元信息，可移除（先例 WebElementContextAttachmentChip）。
import { FilePenLineIcon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { FeatureCorrectionComposerAttachment } from "@/lib/featureCorrectionContext.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

export function FeatureCorrectionAttachmentChip({
  contexts,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  contexts: readonly FeatureCorrectionComposerAttachment[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (contexts.length === 0) {
    return null;
  }
  const first = contexts[0]!;
  const label =
    contexts.length === 1
      ? intl.formatMessage({ id: "chat.featureCorrection.label" }, { name: first.featureName })
      : intl.formatMessage(
          { id: "chat.featureCorrection.many" },
          { count: String(contexts.length) },
        );
  const removeLabel = intl.formatMessage({ id: "chat.featureCorrection.remove" });

  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<FilePenLineIcon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {contexts.map((context) => (
        <div
          key={context.id}
          className="flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
        >
          <FilePenLineIcon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{context.featureName}</div>
            <div className="truncate text-ui-base text-foreground-subtle">
              {[context.domain, `v${context.currentVersion}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          {onRemove ? (
            <button
              type="button"
              className="mt-0.5 shrink-0 text-ui-base text-foreground-subtle hover:text-foreground"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              {removeLabel}
            </button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}