// 语义向量层纯函数（spec: feature-knowledge.md 检索分层③）。
// 分块 / 向量编解码 / cosine / RRF 融合；corpus 小，cosine 在 JS 内算，不引向量库。
import type { SearchLayer } from "./types.js";

/** 文档分块：按 markdown 段落聚合到约 maxChars 上限，保段落完整，超长段落硬切。 */
export function chunkDocument(docMd: string, maxChars = 1200): string[] {
  const text = docMd.trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let start = 0; start < paragraph.length; start += maxChars) {
        chunks.push(paragraph.slice(start, start + maxChars));
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > maxChars) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

/** Float32 小端编码为 blob；与 decodeVector 互逆。 */
export function encodeVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * 4);
  }
  return buffer;
}

export function decodeVector(blob: Uint8Array): number[] {
  const buffer = Buffer.from(blob);
  const vector: number[] = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    vector.push(buffer.readFloatLE(offset));
  }
  return vector;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedCandidate {
  id: string;
  layers: SearchLayer[];
}

export interface FusedCandidate extends RankedCandidate {
  score: number;
}

/**
 * RRF（Reciprocal Rank Fusion）融合多路召回：score = Σ 1/(k + rank)。
 * 各层内部排序保留锚点加权等语义；融合只看名次，跨层量纲无关。命中层取并集。
 */
export function fuseByRrf(lists: readonly RankedCandidate[][], k = 60): FusedCandidate[] {
  const scores = new Map<string, { score: number; layers: Set<SearchLayer> }>();
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const entry = scores.get(candidate.id) ?? { score: 0, layers: new Set<SearchLayer>() };
      entry.score += 1 / (k + rank + 1);
      for (const layer of candidate.layers) entry.layers.add(layer);
      scores.set(candidate.id, entry);
    });
  }
  return [...scores.entries()]
    .map(([id, entry]) => ({ id, layers: [...entry.layers], score: entry.score }))
    .sort((a, b) => b.score - a.score);
}