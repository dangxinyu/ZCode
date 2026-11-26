// 末级功能点删除二次确认 dialog（spec: feature-knowledge.md 末级右键删除，用户需求 2026-11-26）。
// 删除不可恢复（版本历史/关联/索引一并清），必须显式「确认删除」；busy 期间禁止关闭防重复提交。
import { useState } from "react";
import type { FeatureSummary } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeatureDeleteConfirmDialog({
  feature,
  onConfirm,
  onClose,
}: {
  feature: FeatureSummary | null;
  /** 返回 true 表示已删除（toast 由调用方负责）；false 保持弹窗供重试。 */
  onConfirm: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={feature !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage(
              { id: "knowledge.deleteConfirmTitle" },
              { name: feature?.name ?? "" },
            )}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "knowledge.deleteConfirmDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !feature}
            onClick={() => {
              if (!feature) return;
              setBusy(true);
              void onConfirm(feature.id).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
          >
            {intl.formatMessage({ id: "knowledge.deleteConfirmAction" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}