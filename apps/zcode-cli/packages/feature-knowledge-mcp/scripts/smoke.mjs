// 端到端 stdio 冒烟：用官方 MCP client 连接构建产物，验证 initialize/listTools/callTool 全链路。
// 运行：先 build，再 `node --import tsx scripts/smoke.mjs`。临时库经 ZCODE_DATA_BASE_DIR 注入子进程。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { FeatureKnowledgeRepo } from "@zcode/services/feature-knowledge";

const serverPath = resolve(import.meta.dirname, "../dist/mcp/server.js");
const dir = await mkdtemp(join(tmpdir(), "zcode-fkb-smoke-"));
const dbPath = join(dir, ".zcode", "v2", "feature-knowledge.sqlite");
await mkdir(join(dir, ".zcode", "v2"), { recursive: true });
const repo = new FeatureKnowledgeRepo(dbPath);
await repo.ensureReady();
const proposal = await repo.propose({
  proposedName: "库存成本核算",
  proposedAliases: ["存货计价"],
  docMd: "# 库存成本核算\n正文",
  changeSummary: "init",
});
await repo.commitProposal(proposal.id);
repo.close();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...getDefaultEnvironment(), ZCODE_DATA_BASE_DIR: dir },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0" }, { versionNegotiation: { mode: "auto" } });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  console.log("tools:", names.join(", "));
  const expected = ["get_proposal_status", "propose_feature_update", "read_feature", "search_features"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected tools: ${names}`);

  const search = await client.callTool({ name: "search_features", arguments: { query: "库存成本核算" } });
  const searchText = search.content?.[0]?.text ?? "";
  if (!searchText.includes("库存成本核算")) throw new Error("search did not hit seeded feature");
  console.log("search hit ok");

  const propose = await client.callTool({
    name: "propose_feature_update",
    arguments: { proposedName: "外部新功能点", docMd: "# 外部新功能点\n正文" },
  });
  const proposeText = propose.content?.[0]?.text ?? "";
  if (!proposeText.includes("pending")) throw new Error("propose did not return pending");
  console.log("propose pending ok");

  console.log("SMOKE_PASS");
} catch (error) {
  console.error("SMOKE_FAIL", error);
  process.exitCode = 1;
} finally {
  await client.close();
  await rm(dir, { recursive: true, force: true });
}