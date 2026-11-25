// 知识库语义召回配置（spec: packages/services/specs/feature-knowledge.md ③语义向量层 / 验收 10）。
// embedding 引用是知识库设置项 AppSettings.featureKnowledgeEmbedding，复用 provider 鉴权/base，
// modelId 直传 /embeddings。清空经 normalizeSettingsPatch 归一（RPC 吞 undefined）。
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";

export interface FeatureKnowledgeEmbeddingSettingProps {
  open: boolean;
  onClose: () => void;
}

export function FeatureKnowledgeEmbeddingSetting({
  open,
  onClose,
}: FeatureKnowledgeEmbeddingSettingProps) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const ref = settings?.featureKnowledgeEmbedding;
    setProviderId(ref?.providerId ?? "");
    setModelId(ref?.modelId ?? "");
    setWorkspacePath(ref?.workspacePath ?? activeWorkspacePath ?? "");
    setSaved(false);
  }, [open, settings?.featureKnowledgeEmbedding, activeWorkspacePath]);

  const canSave =
    providerId.trim().length > 0 && modelId.trim().length > 0 && workspacePath.trim().length > 0;

  const save = async () => {
    if (!canSave || busy) {
      return;
    }
    setBusy(true);
    try {
      await update({
        featureKnowledgeEmbedding: {
          providerId: providerId.trim(),
          modelId: modelId.trim(),
          workspacePath: workspacePath.trim(),
        },
      });
      setSaved(true);
    } catch (error) {
      logger.warn("[feature-knowledge] save embedding setting failed", { error });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // 空必填项经 normalizeSettingsPatch 归一成 undefined，清除旧配置回到降级态。
      await update({
        featureKnowledgeEmbedding: { providerId: "", modelId: "", workspacePath: "" },
      });
      setProviderId("");
      setModelId("");
      setSaved(false);
    } catch (error) {
      logger.warn("[feature-knowledge] clear embedding setting failed", { error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "knowledge.embedding.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "knowledge.embedding.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1 text-ui-sm">
            <span className="text-muted-foreground">
              {intl.formatMessage({ id: "knowledge.embedding.provider" })}
            </span>
            <Input value={providerId} onChange={(e) => setProviderId(e.target.value)} />
          </label>
          <label className="grid gap-1 text-ui-sm">
            <span className="text-muted-foreground">
              {intl.formatMessage({ id: "knowledge.embedding.modelId" })}
            </span>
            <Input
              value={modelId}
              placeholder={intl.formatMessage({ id: "knowledge.embedding.modelPlaceholder" })}
              onChange={(e) => setModelId(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-ui-sm">
            <span className="text-muted-foreground">
              {intl.formatMessage({ id: "knowledge.embedding.workspace" })}
            </span>
            <Input value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} />
          </label>
        </div>

        {saved ? (
          <p className="text-ui-xs text-muted-foreground">
            {intl.formatMessage({ id: "knowledge.embedding.saved" })}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void clear()}>
            {intl.formatMessage({ id: "knowledge.embedding.clear" })}
          </Button>
          <Button type="button" disabled={busy || !canSave} onClick={() => void save()}>
            {intl.formatMessage({ id: "knowledge.embedding.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}