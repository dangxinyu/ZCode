# 配置文件加载：顶层 section 字段级隔离与 hooks 错位自动迁移

## 背景与问题

2026-11-11 真实事故：用户 `~/.zcode/cli/config.json` 把 `UserPromptSubmit` 事件直接写在
`hooks` 根层级（Claude Code 风格写法），而 `hooksSchema` 为 `.strict()` 且事件名只认
`hooks.events` 下的 key，Zod 校验抛 `Unrecognized key`。当时 `parseConfigFileToRuntimePatchWithDiagnostics`
对整份文件做**单次** `ZCodeConfigFileSchema.parse`，任何一个 section 非法都让整个文件被拒——
`mcp.servers`（4 个）、skills、plugins 全部丢失，所有会话没有任何用户 MCP 工具；
唯一痕迹是日志 `config.file.invalid`，用户完全无感（桌面 UI 的 MCP 面板走裸 JSON 读取，
仍显示"已启用"绿灯）。

## 产品规则

1. **顶层 section 隔离**：配置文件按顶层 section 逐个校验。单个 section 非法 → 丢弃该
   section 并产生 `warning` 诊断（`config_section_invalid`），其余 section 照常加载。
   与 `mcp.servers` 逐 server 隔离（`normalizeConfigFileInput`）同一设计原则：可选工具
   配置的单点错误不应拖垮其他配置。
2. **整文件失败边界不变**：JSON 语法错误、顶层不是 JSON object 时无法确定 section 边界，
   仍走整文件失败（ZodError 由 file-config.adapter 兜底为 `error` 级 `config_file_invalid`）。
3. **hooks 错位自动迁移**：`hooks` 为对象且根层级出现 HookEvent 事件名
   （SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse /
   PostToolUseFailure / Stop，必须与 `hooksSchema.events` 的 key 严格一致）时，加载阶段
   自动迁移到 `hooks.events` 下并产生 `warning` 诊断（`config_hooks_misplaced_migrated`）。
   只在内存归一化，**不写回用户文件**（与 plugins legacy 字段迁移惯例一致）。事件名集合
   以本包字面量维护，不引用 shared（zod 双实例约束，见 schema.ts hooksSchema 上方注释）。
4. **诊断语义**：`warning` = 已降级但其余配置可用；`error` = 整文件不可用。诊断的下游
   仍只有日志（`adapters.config` module，经 `resolveConfigDiagnosticLogEvent` 映射事件名）；
   协议/UI 透传不在本次范围。

## 状态所有者与数据流

| 环节 | 所有者 | 说明 |
| --- | --- | --- |
| section 校验与隔离 | `parseConfigFileToRuntimePatchWithDiagnostics`（schema.ts，唯一入口） | 逐 section safeParse，非法 section 丢弃 + 诊断 |
| hooks 归一化 | `normalizeConfigFileInput` → `normalizeHooksInput` | 在 section 校验前执行，迁移后进入正常校验 |
| 诊断收集 | `ConfigDiagnostic[]` → `LoadedConfig.diagnostics` → `ConfigResult.sources.<scope>.diagnostics` | 类型见 schema.ts `ConfigDiagnostic` |
| 日志落点 | config-factory `logConfigDiagnostics` | `resolveConfigDiagnosticLogMessage` / `resolveConfigDiagnosticLogEvent` 负责文案与事件名映射 |

## 接口

- `ConfigDiagnosticCode` 新增：`config_section_invalid`、`config_hooks_misplaced_migrated`。
- `ZCodeConfigFileSchema` 导出与 `ZCodeConfigFile` 推断类型不变；组合方式改为
  `CONFIG_SECTION_SCHEMAS` section 表 + `z.object(...).passthrough()`。
  **新增顶层 section 时必须同步登记 section 表**，否则加载阶段会被静默忽略。
- `loadFileConfig` / `parseConfigFileToRuntimePatchWithDiagnostics` 对外签名不变。

## 验收场景

1. hooks section 非法（如 `events.UserPromptSubmit` 类型错）+ mcp/skills 合法 →
   mcp/skills 照常进入 runtime patch，hooks 缺失，诊断含 `config_section_invalid`
   （warning，path=`hooks`），无 `error` 级诊断。
2. hooks 根层级写 `UserPromptSubmit`（Claude Code 风格）→ 迁移后
   `config.hooks.events.UserPromptSubmit` 存在且 matcher 内容不变，诊断含
   `config_hooks_misplaced_migrated`。
3. `mcp.servers` 单条非法 → 仅该条丢失并保留既有 `config_mcp_server_invalid`（回归）。
4. 顶层不是对象（如数组、字符串）→ 仍抛 ZodError，由 adapter 兜底为整文件失败（回归）。
5. 全合法配置 → runtime patch 与诊断均与旧实现一致（回归）。
6. 真实事故样本（2026-11-11 备份：hooks 错位 + 4 个 mcp server + skills/plugins）→
   4 个 mcp server 全部保留、hooks 迁移生效、skills/plugins 照常加载，诊断仅 warning。
