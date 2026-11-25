// 功能点活文档章节级部分接受（spec: packages/services/specs/feature-knowledge.md 提案-确认闸门）。
// 段落级重写后章节边界天然对齐：确认时可按章节勾选接受，host 以旧文档为底只替换勾选章节。
// split 必须无损分块（concat(raw) === 原文），保证「全选接受」与整份提交字节一致。

export const FEATURE_DOC_SECTION_NAMES = [
  "需求背景",
  "业务规则",
  "代码位置",
  "关键修改决策",
  "坑与注意",
  "关联功能点",
] as const;

export const FEATURE_DOC_PREAMBLE_NAME = "__preamble__";

export interface FeatureDocSection {
  /** 章节名（六固定章节之一）；开头无标题部分为 FEATURE_DOC_PREAMBLE_NAME。 */
  name: string;
  /** 原始块（含标题行与块尾换行），拼接即原文。 */
  raw: string;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

function resolveSectionName(headingText: string): string | null {
  for (const name of FEATURE_DOC_SECTION_NAMES) {
    if (headingText.startsWith(name)) return name;
  }
  return null;
}

export function splitFeatureDocSections(doc: string): FeatureDocSection[] {
  const lines = doc.split("\n");
  const sections: FeatureDocSection[] = [];
  let currentName = FEATURE_DOC_PREAMBLE_NAME;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    sections.push({ name: currentName, raw: buffer.join("\n") });
    buffer = [];
  };
  for (const line of lines) {
    const match = HEADING_PATTERN.exec(line);
    const name = match ? resolveSectionName((match[2] ?? "").trim()) : null;
    if (name) {
      flush();
      currentName = name;
    }
    buffer.push(line);
  }
  flush();
  // lines 是原文的完整划分；块内 join("\n") 不含块间分隔换行，除末块外补回，拼接即原文。
  for (const [index, section] of sections.entries()) {
    if (index < sections.length - 1) section.raw += "\n";
  }
  return sections;
}

function sectionMap(sections: readonly FeatureDocSection[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    // 同名章节出现多次时保留首块，其余并入首块，避免合并丢内容。
    map.set(section.name, (map.get(section.name) ?? "") + section.raw);
  }
  return map;
}

export function listChangedFeatureDocSections(
  baseDoc: string,
  nextDoc: string,
): Array<{ name: string; label: string }> {
  const base = sectionMap(splitFeatureDocSections(baseDoc));
  const next = sectionMap(splitFeatureDocSections(nextDoc));
  const names = [...new Set([...base.keys(), ...next.keys()])];
  return names
    .filter((name) => (base.get(name) ?? "") !== (next.get(name) ?? ""))
    .map((name) => ({
      name,
      label: name === FEATURE_DOC_PREAMBLE_NAME ? "文档开头" : name,
    }));
}

/** 以 base 为底、只替换 accepted 章节；未勾选章节保持 base 原样。全选时结果与 next 字节一致。 */
export function mergeFeatureDocSections(
  baseDoc: string,
  nextDoc: string,
  accepted: readonly string[],
): string {
  const acceptedSet = new Set(accepted);
  const baseSections = splitFeatureDocSections(baseDoc);
  const nextSections = splitFeatureDocSections(nextDoc);
  const base = sectionMap(baseSections);
  const next = sectionMap(nextSections);
  const orderedNames = [
    ...(base.has(FEATURE_DOC_PREAMBLE_NAME) || next.has(FEATURE_DOC_PREAMBLE_NAME)
      ? [FEATURE_DOC_PREAMBLE_NAME]
      : []),
    ...baseSections
      .map((section) => section.name)
      .filter((name) => name !== FEATURE_DOC_PREAMBLE_NAME),
  ];
  // next 新增章节插回它在 next 中的相对位置（第一个排在它后面的 base 章节之前），
  // 保证全选接受时顺序与 next 一致、字节相等；next 里排在最后的追加末尾。
  const nextOrder = nextSections
    .map((section) => section.name)
    .filter((name) => name !== FEATURE_DOC_PREAMBLE_NAME);
  for (const name of nextOrder) {
    if (base.has(name)) continue;
    const nextIndex = nextOrder.indexOf(name);
    const anchor = nextOrder
      .slice(nextIndex + 1)
      .find((candidate) => orderedNames.includes(candidate));
    if (anchor) orderedNames.splice(orderedNames.indexOf(anchor), 0, name);
    else orderedNames.push(name);
  }
  const seen = new Set<string>();
  let merged = "";
  for (const name of orderedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const source = acceptedSet.has(name) ? next : base;
    merged += source.get(name) ?? "";
  }
  return merged;
}