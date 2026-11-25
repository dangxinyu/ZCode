// 扫描限额常量：浏览器安全（无 node 导入），UI 与 host 共用，避免 node:fs 进客户端 bundle。
export const DOC_SCAN_DIRECT_LIMIT = 20;
export const DOC_SCAN_MAX_DOCS = 200;
/** 单个子智能体批次最多读几份文档：控制上下文与额度，超出按组内切批。 */
export const DOC_SCAN_BATCH_MAX_DOCS = 5;