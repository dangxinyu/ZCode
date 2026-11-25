// 功能点知识库工具注册门 + handler 透传单测（node:test，`npx tsx --test` 直跑）。
// spec: packages/services/specs/feature-knowledge.md
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEARCH_FEATURES_TOOL_NAME,
  READ_FEATURE_DOC_TOOL_NAME,
  PROPOSE_FEATURE_UPDATE_TOOL_NAME,
  type FeatureKnowledgePort,
} from "@zcode/contracts";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  searchFeaturesToolEntry,
  readFeatureDocToolEntry,
  proposeFeatureUpdateToolEntry,
} from "../src/tool/handlers/feature-knowledge.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

function collect(options: Parameters<typeof registerBuiltInTools>[1]): Set<string> {
  const names = new Set<string>();
  registerBuiltInTools(
    {
      register(entry: ToolEntry) {
        names.add(entry.metadata.name);
      },
    },
    options,
  );
  return names;
}

const KB_TOOLS = [
  SEARCH_FEATURES_TOOL_NAME,
  READ_FEATURE_DOC_TOOL_NAME,
  PROPOSE_FEATURE_UPDATE_TOOL_NAME,
];

test("注册门：includeFeatureKnowledge 决定三工具曝光", () => {
  const enabled = collect({ includeFeatureKnowledge: true });
  for (const name of KB_TOOLS) assert.ok(enabled.has(name), `${name} should be registered`);
  const disabled = collect({});
  for (const name of KB_TOOLS) assert.ok(!disabled.has(name), `${name} should be hidden`);
  const explicitOff = collect({ includeFeatureKnowledge: false });
  for (const name of KB_TOOLS) assert.ok(!explicitOff.has(name));
});

function contextWithPort(port?: FeatureKnowledgePort): ToolExecutionContext {
  return {
    toolCallId: "call-1",
    sessionId: "session-1",
    traceId: "trace-1",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...(port ? { featureKnowledgePort: port } : {}),
  } as unknown as ToolExecutionContext;
}

test("handler 透传端口并携带 sessionId/traceId", async () => {
  const calls: Array<{ method: string; input: unknown; context: unknown }> = [];
  const port: FeatureKnowledgePort = {
    async searchFeatures(input, context) {
      calls.push({ method: "search", input, context });
      return { hits: [], semanticEnabled: false, message: "ok" };
    },
    async readFeatureDoc(input, context) {
      calls.push({ method: "read", input, context });
      return { found: false, feature: null, relations: [], versions: [], message: "ok" };
    },
    async proposeFeatureUpdate(input, context) {
      calls.push({ method: "propose", input, context });
      return { proposalId: "p-1", status: "pending", featureId: null, message: "ok" };
    },
  };
  const context = contextWithPort(port);
  await searchFeaturesToolEntry.handler({ query: "库存" }, context);
  await readFeatureDocToolEntry.handler({ featureId: "f-1" }, context);
  await proposeFeatureUpdateToolEntry.handler({ docMd: "doc", name: "新功能" }, context);
  assert.deepEqual(calls.map((call) => call.method), ["search", "read", "propose"]);
  for (const call of calls) {
    assert.deepEqual(call.context, { sessionId: "session-1", traceId: "trace-1" });
  }
});

test("端口缺席：handler 抛 ConfigurationError", async () => {
  const context = contextWithPort(undefined);
  await assert.rejects(
    () => searchFeaturesToolEntry.handler({ query: "x" }, context),
    (error) => {
      assert.match(String(error), /FeatureKnowledgePort is not configured/);
      return true;
    },
  );
});

test("工具元数据：读工具只读，提案非只读且系统副作用", () => {
  assert.equal(searchFeaturesToolEntry.metadata.readOnly, true);
  assert.equal(readFeatureDocToolEntry.metadata.readOnly, true);
  assert.equal(proposeFeatureUpdateToolEntry.metadata.readOnly, false);
  assert.equal(proposeFeatureUpdateToolEntry.metadata.sideEffectScope, "system");
  assert.equal(proposeFeatureUpdateToolEntry.metadata.concurrentSafe, false);
});