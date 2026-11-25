// 文档来源提炼的扫描阶段（spec: feature-knowledge.md 分析现有文档入口，用户确认 2026-11-25）。
// 目录展开 + 只读标题/开头行 + 候选归属，供 >20 份时 dialog 清单勾选；全量读只发生在提炼阶段。
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { DOC_SCAN_MAX_DOCS } from "./docScanLimits.js";
import type { SearchHit } from "./types.js";

export { DOC_SCAN_DIRECT_LIMIT, DOC_SCAN_MAX_DOCS } from "./docScanLimits.js";

export const DOC_SCAN_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const DOC_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "build",
  "out",
  ".next",
  "coverage",
]);
const DOC_SCAN_HEAD_LINES = 60;
const DOC_SCAN_HEADINGS_MAX = 8;
const DOC_SCAN_CANDIDATES_MAX = 2;

export interface FeatureDocScanEntry {
  path: string;
  title: string;
  headings: string[];
  candidates: Array<{ featureId: string; name: string }>;
}

export interface FeatureDocScanResult {
  docs: FeatureDocScanEntry[];
  total: number;
  truncated: boolean;
}

/** 侦察子智能体产出的主题计划：主题↔文档↔功能点皆多对多（知识有交集）。 */
export interface FeatureDocTheme {
  name: string;
  docPaths: string[];
  features: Array<{ featureId?: string; name: string }>;
}

export interface FeatureDocThemePlan {
  themes: FeatureDocTheme[];
}

/** 读侦察计划文件（scout 经 Write 落盘）；缺失/形状非法返回 null，UI 继续轮询。 */
export async function readFeatureDocThemePlan(path: string): Promise<FeatureDocThemePlan | null> {
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const themes = (parsed as { themes?: unknown }).themes;
  if (!Array.isArray(themes) || themes.length === 0) return null;
  const valid: FeatureDocTheme[] = [];
  for (const theme of themes) {
    if (typeof theme !== "object" || theme === null) return null;
    const { name, docPaths, features } = theme as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return null;
    if (!Array.isArray(docPaths) || docPaths.some((p) => typeof p !== "string")) return null;
    if (!Array.isArray(features)) return null;
    const parsedFeatures: FeatureDocTheme["features"] = [];
    for (const feature of features) {
      if (typeof feature !== "object" || feature === null) return null;
      const f = feature as Record<string, unknown>;
      if (typeof f.name !== "string") return null;
      parsedFeatures.push({
        ...(typeof f.featureId === "string" ? { featureId: f.featureId } : {}),
        name: f.name,
      });
    }
    valid.push({ name, docPaths: docPaths as string[], features: parsedFeatures });
  }
  return { themes: valid };
}

async function collectDocs(root: string, into: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (DOC_SCAN_SKIP_DIRS.has(entry.name)) continue;
      await collectDocs(full, into);
    } else if (entry.isFile() && DOC_SCAN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      into.push(full);
    }
  }
}

export async function scanFeatureDocs(
  paths: readonly string[],
  search: (query: string, limit?: number) => SearchHit[],
): Promise<FeatureDocScanResult> {
  const files: string[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      await collectDocs(path, files);
    } else if (DOC_SCAN_EXTENSIONS.has(extname(path).toLowerCase())) {
      files.push(path);
    }
  }
  const unique = [...new Set(files)];
  const truncated = unique.length > DOC_SCAN_MAX_DOCS;
  const scoped = unique.slice(0, DOC_SCAN_MAX_DOCS);
  const docs: FeatureDocScanEntry[] = [];
  for (const path of scoped) {
    const content = await readFile(path, "utf-8").catch(() => "");
    const lines = content.split("\n").slice(0, DOC_SCAN_HEAD_LINES);
    const headings = lines
      .filter((line) => /^#{1,6}\s+\S/.test(line))
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
      .slice(0, DOC_SCAN_HEADINGS_MAX);
    const title = headings[0] || basename(path);
    const hits = search(`${title} ${headings[1] ?? ""}`.trim(), DOC_SCAN_CANDIDATES_MAX);
    docs.push({
      path,
      title,
      headings,
      candidates: hits.map((hit) => ({ featureId: hit.feature.id, name: hit.feature.name })),
    });
  }
  return { docs, total: unique.length, truncated };
}