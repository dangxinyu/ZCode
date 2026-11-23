# 智谱官方模型接入（official-glm-model-onboarding）

## 背景

本仓库是 ZCode 开源 fork（产品 Don't-think）。官方上线 GLM-5.4 没有发客户端：安装包内置的兜底配置
（3.19.1，revision 44）不含 GLM-5.4，模型靠远端内置配置 revision 47 下发。
fork 的兜底配置停在 revision 30，联不上官方端点（内网、离线、自带端点）时拿不到 5.4。
本 spec 约定把官方智谱模型写进兜底配置的规则，以 GLM-5.4 为首个落地案例。

## 产品规则

- GLM-5.4 能力以官方 revision 47 的裁决结果为准（2026-11-23 核对）：上下文 1,000,000；
  图片、视频、PDF 输入；思考档位 `low` / `high` / `max`；最大输出 128,000。
- 开放范围与官方一致：
  - 模板：`zai-api`、`bigmodel-api`、`zai-standard-api`、`bigmodel-standard-api`；
  - 内置供应商：个人、团队、体验、闲时四个套餐 × `zai` / `bigmodel` 共八个。
- 能力必须显式写成 `modelConfigRules.modelRules` 条目，并排在 `.*glm-5…` 兜底规则之后。
  兜底规则命中整个 5 系，但给的是旧参数（200k、思考开关两档、输出 64k，通用规则层面不开图片/视频/PDF）；
  只把 ID 加进清单，GLM-5.4 在套餐端点会被解析成 200k、开关两档。
- 官方套餐端点（`api.z.ai`、`open.bigmodel.cn`、`zcode.z.ai` 的 anthropic 路径）另有一条按站点匹配的
  `provider-site` 规则（`modelMatch: ".*"`），给端点下所有模型打开图片/视频。这是服务端桥接，
  不代表模型原生视觉，所以 `supportsImage` 在套餐端点上不能用来区分模型能力，UI 也对 GLM-5.3 隐藏视觉徽标。
- opencode 模板、`modelApiRules`、`providerSiteRules` 不随本次开放。

## 状态所有者

- 模型清单与能力的唯一事实源是根目录 `config/provider/zcode-builtin.json`（Bundled Release）。
  代码里不手写模型能力，不复制第二份清单。
- 规范 ID 白名单是 `packages/shared/src/official-glm-model-id.ts`，供 telemetry 脱敏、
  旧 provider 身份迁移、体验套餐计费共用；新增官方模型必须同步。
- 历史迁移（session-store 0021 / 0022、tasksDatabase `official-glm-selection-v3`）只处理已存在的旧数据，
  新模型不回填。

## 生效顺序

生效配置是 Bundled、Active 缓存、Remote 三者中 revision 最大的一份，所有者是
`zcode-builtin-provider-config-source.ts` 与 `zcode-builtin-remote-synchronizer.ts`：

```text
启动读取                              远端刷新（成功后间隔一小时）
  │                                     │
  ▼                                     ▼
读 Bundled 与 Active 缓存             拉取 Remote
  │                                     │
  ▼                                     ▼
revision 最大者生效                   remote.revision 对比当前
同号且内容不同 = 缓存失效：             更小              → stale，忽略
Bundled 胜出并原子覆盖 Active          相等、内容相同    → unchanged
                                       相等、内容不同    → 抛错
                                       更大              → 写入 Active
```

规则匹配是整串锚定（`^(?:pattern)$`）且忽略大小写；同批命中的规则按数组顺序依次覆盖，后面的赢。

约束：fork 改了 Release 内容就必须递增 `revision`，否则会落进「相等、内容不同 → 抛错」。
fork 的 revision 要保持小于官方当前值，官方远端更新才会继续流入；官方已用到 47，
长期编号策略未定，每次接入时重新核对。

## 接口

配置 schema 不变（`schemaVersion: 1`），无新增协议字段或导出。

## 明确不动的

- `.*`、`.*glm-5…` 等既有规则及其它 5 系模型的裁决结果。
- 全局默认上下文（200k）：官方 revision 47 把它改成了 1M，那是独立决策，不随模型接入移植。
- `legacy-reasoning-level-renames.ts`：只服务历史 `off` / `nothink` 档位，GLM-5.4 无历史档位。
- `modelVisionBadge.ts`：GLM-5.3 的桥接视觉例外不扩展到 GLM-5.4。

## 验收场景

回归测试：`packages/services/test/builtinGlm54ModelSupport.test.ts`，加载仓库内真实配置文件。

1. `GLM-5.4` 出现在四个模板与八个内置供应商的 `builtinModelIds`，且对应启用规则为 `enabled: true`。
2. 以 `account:bigmodel-individual-coding-plan` 身份解析 `GLM-5.4`：上下文 1,000,000，
   图片、视频、PDF 为 true，思考档位依次为 `low` / `high` / `max`，最大输出 128,000，完整性校验无 issue。
3. 其它 5 系模型的裁决不变：`GLM-5.3` 仍为 1M、无 PDF、思考 `low` / `high` / `max`；
   `GLM-5.2` 仍为 1M、无 PDF、思考 `disabled` / `high` / `max`；`GLM-5` 仍为 200k、思考 `disabled` / `enabled`。
4. `OFFICIAL_GLM_MODEL_IDS` 含 `GLM-5.4`，小写输入可归一为规范 ID。
