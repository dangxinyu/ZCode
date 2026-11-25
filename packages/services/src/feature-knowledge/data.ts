// 对外 MCP / 跨进程直读共享的数据层入口（spec: feature-knowledge.md「对外 MCP」）。
// 只暴露纯函数、类型与路径解析，不含 repo 生命周期、服务注册或 migration：
// MCP server 以 ro 连接直读、以 append-only 插入提案，复用与 host 相同的读侧与提案写入语义。
export * from "./types.js";
export {
  getFeature,
  getProposal,
  getVersionHistory,
  listFeatures,
  listProposals,
  listRelations,
  searchFeatures,
  toFeature,
  toProposal,
} from "./queries.js";
export { insertProposal } from "./propose.js";
export { getFeatureKnowledgeDatabasePath } from "../paths.js";
// host 写侧与建库能力一并暴露，供契约测试搭建临时库；MCP server 不引用，bundle 经 tree-shake 剔除。
export { FeatureKnowledgeRepo } from "./featureKnowledgeRepo.js";
export { runFeatureKnowledgeMigrations, FEATURE_KNOWLEDGE_SCHEMA_SQL } from "./schema.js";