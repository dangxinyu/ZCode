// 功能点知识库 UI 数据面（spec: packages/services/specs/feature-knowledge.md）。
// 知识库是全局活文档（独立 SQLite，挂在本地 host），故经 useOptionalBaseWorkspaceServices
// 取 app 级 base services，避免远端 tab 的 accessor 污染全局查询。服务可选：旧 host /
// 测试 double 不提供时 available=false，页面降级明示，不静默假装可用。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import {
  KB_ERROR_CODES,
  type FeatureDetail,
  type FeatureDocScanResult,
  type FeatureDocThemePlan,
  type FeatureKnowledgeSearchResult,
  type FeatureProposal,
  type FeatureSummary,
  type ProposeInput,
} from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type FeatureKnowledgeMutationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

function toMutationError(error: unknown): FeatureKnowledgeMutationResult {
  const message = error instanceof Error ? error.message : String(error);
  const explicitCode = (error as { code?: unknown } | null)?.code;
  if (typeof explicitCode === "string" && explicitCode.length > 0) {
    return { ok: false, code: explicitCode, message };
  }
  // RPC 序列化可能丢失 error.code，回退到稳定错误码字面匹配（不依赖自由文本）。
  const matched = Object.values(KB_ERROR_CODES).find((code) => message.includes(code));
  return { ok: false, code: matched ?? "kb_unknown", message };
}

export interface UseFeatureKnowledgeResult {
  available: boolean;
  loading: boolean;
  features: FeatureSummary[];
  proposals: FeatureProposal[];
  pendingCount: number;
  searchResult: FeatureKnowledgeSearchResult | null;
  refresh: () => void;
  search: (query: string) => Promise<void>;
  readFeature: (id: string) => Promise<FeatureDetail | null>;
  getProposal: (id: string) => Promise<FeatureProposal | null>;
  propose: (input: ProposeInput) => Promise<FeatureProposal | null>;
  commitProposal: (
    id: string,
    acceptedSections?: readonly string[],
  ) => Promise<FeatureKnowledgeMutationResult>;
  scanFeatureDocs: (paths: readonly string[]) => Promise<FeatureDocScanResult | null>;
  readDocThemePlan: (path: string) => Promise<FeatureDocThemePlan | null>;
  rejectProposal: (id: string) => Promise<FeatureKnowledgeMutationResult>;
}

export function useFeatureKnowledge(): UseFeatureKnowledgeResult {
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.featureKnowledgeService;

  const [features, setFeatures] = useState<FeatureSummary[]>([]);
  const [proposals, setProposals] = useState<FeatureProposal[]>([]);
  const [searchResult, setSearchResult] = useState<FeatureKnowledgeSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const disposablesRef = useRef<IDisposable[]>([]);

  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!service) {
      setFeatures([]);
      setProposals([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [nextFeatures, nextProposals] = await Promise.all([
          service.listFeatures(),
          service.listProposals(),
        ]);
        if (cancelled) {
          return;
        }
        setFeatures(nextFeatures);
        setProposals(nextProposals);
      } catch (error) {
        if (!cancelled) {
          logger.warn("[feature-knowledge] refresh failed", { error });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, revision]);

  useEffect(() => {
    if (!service) {
      return;
    }
    const subscription = service.onDynamicFeatureKnowledgeChanged()(() => {
      setRevision((value) => value + 1);
    });
    disposablesRef.current.push(subscription);
    return () => {
      subscription.dispose();
      disposablesRef.current = disposablesRef.current.filter((item) => item !== subscription);
    };
  }, [service]);

  const search = useCallback(
    async (query: string) => {
      if (!service) {
        return;
      }
      const trimmed = query.trim();
      if (!trimmed) {
        setSearchResult(null);
        return;
      }
      try {
        const result = await service.searchFeatures(trimmed);
        setSearchResult(result);
      } catch (error) {
        logger.warn("[feature-knowledge] search failed", { error });
        setSearchResult({ hits: [], semanticEnabled: false });
      }
    },
    [service],
  );

  const readFeature = useCallback(
    async (id: string) => {
      if (!service) {
        return null;
      }
      try {
        return await service.readFeature(id);
      } catch (error) {
        logger.warn("[feature-knowledge] readFeature failed", { error });
        return null;
      }
    },
    [service],
  );

  const getProposal = useCallback(
    async (id: string) => {
      if (!service) {
        return null;
      }
      try {
        return await service.getProposal(id);
      } catch (error) {
        logger.warn("[feature-knowledge] getProposal failed", { error });
        return null;
      }
    },
    [service],
  );

  const propose = useCallback(
    async (input: ProposeInput) => {
      if (!service) {
        return null;
      }
      try {
        const proposal = await service.propose(input);
        refresh();
        return proposal;
      } catch (error) {
        logger.warn("[feature-knowledge] propose failed", { error });
        return null;
      }
    },
    [service, refresh],
  );

  const commitProposal = useCallback(
    async (
      id: string,
      acceptedSections?: readonly string[],
    ): Promise<FeatureKnowledgeMutationResult> => {
      if (!service) {
        return { ok: false, code: KB_ERROR_CODES.notReady, message: "feature knowledge unavailable" };
      }
      try {
        await service.commitProposal(id, acceptedSections);
        refresh();
        return { ok: true };
      } catch (error) {
        logger.warn("[feature-knowledge] commitProposal failed", { error });
        return toMutationError(error);
      }
    },
    [service, refresh],
  );

  const rejectProposal = useCallback(
    async (id: string): Promise<FeatureKnowledgeMutationResult> => {
      if (!service) {
        return { ok: false, code: KB_ERROR_CODES.notReady, message: "feature knowledge unavailable" };
      }
      try {
        await service.rejectProposal(id);
        refresh();
        return { ok: true };
      } catch (error) {
        logger.warn("[feature-knowledge] rejectProposal failed", { error });
        return toMutationError(error);
      }
    },
    [service, refresh],
  );

  const scanFeatureDocs = useCallback(
    async (paths: readonly string[]): Promise<FeatureDocScanResult | null> => {
      if (!service) return null;
      try {
        return await service.scanFeatureDocs(paths);
      } catch (error) {
        logger.warn("[feature-knowledge] scanFeatureDocs failed", { error });
        return null;
      }
    },
    [service],
  );

  const readDocThemePlan = useCallback(
    async (path: string): Promise<FeatureDocThemePlan | null> => {
      if (!service) return null;
      try {
        return await service.readDocThemePlan(path);
      } catch (error) {
        logger.warn("[feature-knowledge] readDocThemePlan failed", { error });
        return null;
      }
    },
    [service],
  );

  const pendingCount = proposals.filter((proposal) => proposal.status === "pending").length;

  return {
    available: Boolean(service),
    loading,
    features,
    proposals,
    pendingCount,
    searchResult,
    refresh,
    search,
    readFeature,
    getProposal,
    propose,
    commitProposal,
    rejectProposal,
    scanFeatureDocs,
    readDocThemePlan,
  };
}