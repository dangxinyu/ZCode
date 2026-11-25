import { Server } from "@modelcontextprotocol/server";
import { FeatureKnowledgeMcpStore } from "./store.js";
export declare const FEATURE_KNOWLEDGE_MCP_PROCESS_TITLE = "zcode-feature-knowledge-mcp";
export interface ToolCallResult {
    [key: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
/** 工具分发纯函数：测试与 stdio handler 共用同一条逻辑。domain 错误 → isError 结果，输入错误 → INVALID_PARAMS。 */
export declare function callFeatureKnowledgeTool(store: FeatureKnowledgeMcpStore, name: string, args: unknown, traceId?: string): ToolCallResult;
export interface FeatureKnowledgeMcpRuntime {
    server: Server;
    dispose(): void;
}
export declare function createFeatureKnowledgeMcpRuntime(input?: {
    dbPath?: string;
}): FeatureKnowledgeMcpRuntime;
export declare function main(): Promise<void>;
//# sourceMappingURL=server.d.ts.map