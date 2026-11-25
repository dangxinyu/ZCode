// /embeddings 适配器契约单测（node:test，`npx tsx --test` 直跑）。
import assert from "node:assert/strict";
import test from "node:test";
import { requestEmbeddings } from "../src/model/embeddings.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requestEmbeddings：POST {baseUrl}/embeddings，注入鉴权与模型，按 index 对齐输入", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    // 故意乱序返回，验证按 index 对齐。
    return jsonResponse({
      model: "text-embedding-3-small",
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
  };
  const result = await requestEmbeddings({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-test",
    model: "text-embedding-3-small",
    texts: ["甲", "乙"],
    fetch: fakeFetch,
  });
  assert.equal(capturedUrl, "https://api.example.com/v1/embeddings");
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Authorization"), "Bearer sk-test");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "text-embedding-3-small",
    input: ["甲", "乙"],
  });
  assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
  assert.equal(result.model, "text-embedding-3-small");
});

test("requestEmbeddings：空 texts 直接返回空向量，不发请求", async () => {
  const fakeFetch: typeof globalThis.fetch = async () => {
    throw new Error("should not fetch");
  };
  const result = await requestEmbeddings({
    baseUrl: "https://api.example.com/v1",
    model: "m",
    texts: [],
    fetch: fakeFetch,
  });
  assert.deepEqual(result.vectors, []);
});

test("requestEmbeddings：非 2xx 抛错（调用方据此降级）", async () => {
  const fakeFetch: typeof globalThis.fetch = async () => jsonResponse({ error: "nope" }, 401);
  await assert.rejects(
    requestEmbeddings({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      texts: ["x"],
      fetch: fakeFetch,
    }),
    /embeddings request failed \(401\)/,
  );
});

test("requestEmbeddings：数量/维度不符抛错", async () => {
  const fakeFetch: typeof globalThis.fetch = async () =>
    jsonResponse({ data: [{ index: 0, embedding: [1] }] });
  await assert.rejects(
    requestEmbeddings({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      texts: ["x", "y"],
      fetch: fakeFetch,
    }),
    /shape invalid/,
  );
});