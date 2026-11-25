// 功能点知识库对外 stdio MCP server（spec: feature-knowledge.md「对外 MCP server」）。
// 读 ro 直读、提案 append-only；commit/reject 不暴露（人闸只在 ZCode UI）。先例 node-repl-host。
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { FeatureKnowledgeError, KB_ERROR_CODES } from "@zcode/services/feature-knowledge";
import {
  installMcpProcessGuards,
  installMcpShutdownTriggers,
  isDirectMcpEntrypoint,
} from "./process-lifecycle.js";
import { FeatureKnowledgeMcpStore } from "./store.js";
import {
  FEATURE_KNOWLEDGE_SERVER_INSTRUCTIONS,
  FEATURE_KNOWLEDGE_SERVER_NAME,
  FEATURE_KNOWLEDGE_SERVER_VERSION,
  TOOL_DESCRIPTIONS,
  getProposalStatusInputSchema,
  proposeFeatureUpdateInputSchema,
  readFeatureInputSchema,
  searchFeaturesInputSchema,
} from "./tool-contract.js";

export const FEATURE_KNOWLEDGE_MCP_PROCESS_TITLE = "zcode-feature-knowledge-mcp";

export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const tools: Tool[] = [
  {
    name: "search_features",
    description: TOOL_DESCRIPTIONS.search_features,
    inputSchema: z.toJSONSchema(searchFeaturesInputSchema) as Tool["inputSchema"],
  },
  {
    name: "read_feature",
    description: TOOL_DESCRIPTIONS.read_feature,
    inputSchema: z.toJSONSchema(readFeatureInputSchema) as Tool["inputSchema"],
  },
  {
    name: "propose_feature_update",
    description: TOOL_DESCRIPTIONS.propose_feature_update,
    inputSchema: z.toJSONSchema(proposeFeatureUpdateInputSchema) as Tool["inputSchema"],
  },
  {
    name: "get_proposal_status",
    description: TOOL_DESCRIPTIONS.get_proposal_status,
    inputSchema: z.toJSONSchema(getProposalStatusInputSchema) as Tool["inputSchema"],
  },
];

function jsonResult(data: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(code: string, message: string): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  invalidParams(`${toolName}: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

/** 工具分发纯函数：测试与 stdio handler 共用同一条逻辑。domain 错误 → isError 结果，输入错误 → INVALID_PARAMS。 */
export function callFeatureKnowledgeTool(
  store: FeatureKnowledgeMcpStore,
  name: string,
  args: unknown,
  traceId?: string,
): ToolCallResult {
  try {
    switch (name) {
      case "search_features": {
        const input = parseInput(searchFeaturesInputSchema, args, name);
        return jsonResult({ hits: store.search(input.query, input.limit), semanticEnabled: false });
      }
      case "read_feature": {
        const input = parseInput(readFeatureInputSchema, args, name);
        const result = store.read(input.id);
        if (!result) return errorResult(KB_ERROR_CODES.featureNotFound, `功能点不存在：${input.id}`);
        return jsonResult(result);
      }
      case "propose_feature_update": {
        const input = parseInput(proposeFeatureUpdateInputSchema, args, name);
        const proposal = store.propose({
          ...input,
          source: { origin: "mcp", ...(traceId ? { traceId } : {}) },
        });
        return jsonResult({
          proposalId: proposal.id,
          status: proposal.status,
          featureId: proposal.featureId,
          baseVersion: proposal.baseVersion,
        });
      }
      case "get_proposal_status": {
        const input = parseInput(getProposalStatusInputSchema, args, name);
        const status = store.proposalStatus(input.id);
        if (!status) return errorResult(KB_ERROR_CODES.proposalNotFound, `提案不存在：${input.id}`);
        return jsonResult(status);
      }
      default:
        invalidParams(`Tool ${name} not found`);
    }
  } catch (error) {
    if (error instanceof FeatureKnowledgeError) return errorResult(error.code, error.message);
    throw error;
  }
}

export interface FeatureKnowledgeMcpRuntime {
  server: Server;
  dispose(): void;
}

export function createFeatureKnowledgeMcpRuntime(
  input: { dbPath?: string } = {},
): FeatureKnowledgeMcpRuntime {
  const store = new FeatureKnowledgeMcpStore(input.dbPath);
  const server = new Server(
    { name: FEATURE_KNOWLEDGE_SERVER_NAME, version: FEATURE_KNOWLEDGE_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: FEATURE_KNOWLEDGE_SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    const meta = extra.mcpReq._meta?.["com.zcode/request-context"] as { trace_id?: string } | undefined;
    return callFeatureKnowledgeTool(store, request.params.name, request.params.arguments ?? {}, meta?.trace_id);
  });
  return { server, dispose: () => store.close() };
}

export async function main(): Promise<void> {
  process.title = FEATURE_KNOWLEDGE_MCP_PROCESS_TITLE;
  const runtimes = new Set<FeatureKnowledgeMcpRuntime>();
  const handle = serveStdio(
    () => {
      const runtime = createFeatureKnowledgeMcpRuntime();
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle.close().catch(() => undefined).finally(() => process.exit(0));
  };
  installMcpProcessGuards({ onOutputClosed: shutdown, process, writeStderr: (text) => process.stderr.write(text) });
  installMcpShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    process.stderr.write(
      `feature_knowledge MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}