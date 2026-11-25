// OpenAI-compatible /embeddings 一次性请求适配器（spec: feature-knowledge.md 语义向量层）。
// 复用 provider 的 baseUrl/鉴权/headers；网络 I/O 收敛在本 adapter，host 不直接 fetch。
// 仅 api-key 类 provider 支持；account 动态鉴权与 anthropic 端点不提供 /embeddings。
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";

export interface EmbeddingsRequest {
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  model: string;
  texts: readonly string[];
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface EmbeddingsResult {
  vectors: number[][];
  model: string;
}

interface EmbeddingsResponsePayload {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
}

/** POST {baseUrl}/embeddings，按 index 对齐输入顺序返回向量。失败抛错由调用方降级。 */
export async function requestEmbeddings(request: EmbeddingsRequest): Promise<EmbeddingsResult> {
  if (request.texts.length === 0) return { vectors: [], model: request.model };
  const url = `${request.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const headers = new Headers(request.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (request.apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${request.apiKey}`);
  }
  const fetchImpl = request.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: request.model, input: request.texts }),
    signal: request.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`embeddings request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const payload = (await response.json()) as EmbeddingsResponsePayload;
  const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = data.map((item) => item.embedding ?? []);
  if (vectors.length !== request.texts.length || vectors.some((vector) => vector.length === 0)) {
    throw new Error("embeddings response shape invalid: count/dimension mismatch");
  }
  return { vectors, model: payload.model ?? request.model };
}

/** 带网络策略（代理/CA）的入口：未显式传 fetch 时按 network 配置构造代理感知 fetch。 */
export async function requestProviderEmbeddings(
  request: EmbeddingsRequest & {
    network?: { httpProxy?: string; noProxy?: string; caCertFile?: string };
    env?: Record<string, string | undefined>;
  },
): Promise<EmbeddingsResult> {
  const fetchImpl =
    request.fetch ??
    createNetworkProxyFetch({
      httpProxy: request.network?.httpProxy,
      noProxy: request.network?.noProxy,
      caCertFile: request.network?.caCertFile,
      env: request.env,
    });
  return requestEmbeddings({ ...request, fetch: fetchImpl });
}