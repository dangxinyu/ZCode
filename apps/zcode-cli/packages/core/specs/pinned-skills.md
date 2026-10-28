# 常驻 Skill（Pinned Skills）：会话级自动加载、压缩免疫的技能注入

## 背景与问题

现有 Skill 的加载完全依赖模型自觉：`$` 面板只往用户消息里插 markdown 引用文本，
runtime 侧没有解析器；技能清单（`skills_listing`）只列名字与描述，全文要靠模型主动调
Skill 工具加载，且以普通 tool result 进入历史——compact/清理后即被摘要掉。用户希望
把某个 skill「常驻」：任务开始自动加载全文、上下文压缩后不丢、文件失效时可见。

## 产品规则

1. Composer 工具栏（`leadingActionsNode`，「电脑操作」入口旁）新增「常驻 skill」
   图钉入口：popover 列出可用 skill（复用 `useSkills` catalog），可多选、可取消。
2. 新任务屏与会话内共用同一 composer：入口与展示两个面都在。会话内修改立即生效于
   后续模型请求（前缀每请求重建），当前正在生成的 turn 不回改。
3. 选中后，输入框上方 pills 行（`topContent`）显示常驻 chip（图钉图标 + 名字，× 移除、
   点名字打开 picker）；skill 不在当前 catalog（被删/改名/禁用）时 chip 呈失效态。
4. 常驻 skill 全文以 `request_prefix` 生命周期 system-reminder 注入：与
   `skills_listing` 同通道，每请求由 `rebuildContextPrefix` 重建，压缩只保留前缀——
   因此「压缩后不丢」「丢失自动重载」由通道语义天然满足，不需要 compact 钩子。
5. 预算：单个 skill 沿用 Skill 工具 100KB 截断；section 总预算 20k 字符，超限降级为
   仅列名字并指示模型按需用 Skill 工具加载全文。
6. 作用域：会话级（`SessionConfigState`），随 createSession config 进入；草稿按
   workspace scope 持久化（重开应用、新任务屏仍显示）。跨 workspace 全局常驻不在
   v1 范围。

## 状态所有者与事件顺序

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 常驻选择（用户意图，新任务屏） | UI composer draft（`V4ComposerDraft.pinnedSkills`，composerDraftStore） | 按 workspace scope 持久化；createSession 时随 config 携带 |
| 常驻选择（会话真值） | core runtime `sessionPinnedSkills`（`setPinnedSkills` 唯一写入口） | create config 应用与会话中命令都落到这里 |
| 常驻内容（全文） | runtime `pinnedSkillContents`：context 初始化与每次 set 后经 `skillPort.loadSkill` 解析 | 失效项记 diagnostic，注入占位行；不阻断 |
| 持久化 | sessionStore entry `runtime/pinned_skills`（contracts `SESSION_ENTRY_PINNED_SKILLS`） | resume 读回；写失败仅 warn 不阻断（与 vision_delegate 同语义） |
| 注入点 | `ContextBuilder` meta_user 附件 `source: "pinned_skill"`（`SYSTEM_REMINDER_PREFIX_SOURCES`） | 唯一注入通道；`countContextPrefixMessages` 同步识别，保证 compact 保留 |

```
新任务：草稿 pin → createSession.config.pinnedSkills
  → applyRequestedSessionConfig：app.setPinnedSkills（runtime 真值 + entry 持久化）
  → 首轮 ensureContextInitialized：discover 后按名单 loadSkill 解析全文
  → 每次 provider 请求 rebuildContextPrefix：pinned_skill 附件随前缀重建（压缩免疫）

会话中：picker 改选 → setPinnedSkills 命令（CAS）
  → app.setPinnedSkills：runtime 真值 + 重解析内容 + 持久化 + PinnedSkillsChanged 事件
  → 投影 reducer 更新 snapshot.config.pinnedSkills（UI 已有值对齐）
  → 下一个模型步前缀重建即生效

冷恢复：create-app resume 读 entry → runtime.setPinnedSkills（不校验存在性）
```

## 协议变更

- `packages/shared/src/zcode-protocol-v4/session-config.ts`：
  `sessionConfigStateSchema` 增加可选 `pinnedSkills: string[]`（additive）。
- `packages/shared/src/zcode-protocol-v4/command.ts`：
  - `createSessionRequestedConfigSchema` 增加可选 `pinnedSkills: string[]`；
  - 新命令 `setPinnedSkills: { skills: string[] }`（全量替换，空数组=清除），
    加入 `COMMANDS_REQUIRING_BASE_REVISION`（CAS，同 switchModelConfig 族）。
- contracts：
  - `SessionEventType.PinnedSkillsChanged = "pinned_skills_changed"` +
    payload `{ skills: string[] }`（事件 union 同步）；
  - `SESSION_ENTRY_PINNED_SKILLS = "runtime/pinned_skills"`。

## Runtime 语义细节

- `ensureContextInitialized`：`discoverSkillsForContext` 之后按
  `sessionPinnedSkills` 逐个 `skillPort.loadSkill`（maxBytes 与 Skill 工具一致），
  解析结果缓存为 `pinnedSkillContents`；未命中名单的项产出
  `pinned_skill_not_found` diagnostic。
- `setPinnedSkills`：写入真值 → 若 context 已初始化则同步重解析 → 追加
  `PinnedSkillsChanged` 事件。前缀不在此处手动重建：rebuildContextPrefix 每请求
  从 `createContextBuilderFromSnapshot` 读取最新缓存内容，下一个模型步自然生效。
- section builder：`injectionTarget: "meta_user"`、`cacheHint: "dynamic"`；
  无常驻项返回 null（不产空附件）。超预算降级为名字列表 + Skill 工具提示。
- 失效占位：名单内但发现结果/加载失败的项，注入一行
  `<pinned_skill name=... status=unavailable>` 提示，让模型与用户都可感知。

## UI 语义细节

- 草稿字段 `pinnedSkills?: string[]`：只存名字（catalog entry `name`）；坏值读取时
  静默丢弃，不影响其余草稿字段（与 visionDelegateModel 同策略）。
- 会话内改选：立即更新草稿意图 + dispatch `setPinnedSkills` 命令；显示值以草稿为
  准（与模型/档位同口径），命令 ACK/reject 不回改草稿。
- 失效态判定：chip 名字不在 `useSkills` 当前列表 → 黄点 + tooltip「技能已不可用，
  加载时将注入占位提示」；不自动从名单移除（用户显式 × 才移除）。

## 验收场景

1. 新任务屏 pin 一个 skill → 发送首条消息：模型回复体现 skill 内容已加载
   （请求前缀含 `<system-reminder>` pinned_skill 附件）。
2. 手动 `/compact` 后继续对话：pinned skill 内容仍在前缀（compact 只替换前缀后的历史）。
3. 会话中 pin / 取消 pin：下一个请求生效；`PinnedSkillsChanged` 进投影，
   snapshot.config.pinnedSkills 与 UI 一致。
4. 删除 skill 文件后继续对话：前缀出现 unavailable 占位行，UI chip 失效态，不崩溃。
5. 重启 CLI 后打开历史会话：entry 恢复 runtime 真值，首个 turn 前缀仍含常驻内容。
6. 名单为空 / 字段缺省的旧快照：投影与 seed 均不携带该键，无空转 delta。
7. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
