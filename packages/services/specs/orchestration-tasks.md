# 编排任务（Orchestration Tasks）

状态所有者与数据模型见本 spec；CLI 工具面与 host 派发细节引用 `apps/zcode-cli` 与 `packages/desktop` 内实现。

## 行为定义

- 「普通任务」语义不变：新建任务按钮、任务列表、分组/项目视图对无标记任务的行为保持现状。
- 新增「编排任务」（orchestrator）：侧边栏「新建任务」按钮下方新增「新建编排任务」入口；侧边栏一级 tab 在「分组/项目」之后新增「编排」分区，仅列出 orchestrator 任务。
- 编排任务会话内注入编排工具：`SpawnSubTask`（派生=新建普通子任务并发首条指令）、`LinkTask`（关联=把同 workspace 已有普通任务纳入统筹）、`SendChildTaskPrompt`（分发=向在册子任务追加下发一条指令，用户分发语义的执行面）、`ListOrchestrationChildren`（列出子任务与状态）。
- 派生子任务（child）：由 host 域创建普通任务并盖 child 标记；child 会话**会话级**禁用三个编排工具（不可再派生/关联），其内部 subagent 能力不受影响。
- 关联语义（已确认决策）：关联动作本身不注入指令；编排通过显式的 `SendChildTaskPrompt` 向在册子任务（derived/linked）追加下发指令——子目标命中某个子任务领域时优先分发而非自己做。取消关联的子任务不再接受下发（不在册即拒绝）。派生任务由 spawn 时携带的首条 prompt 驱动。
- 取消关联（用户手动，UI 子任务行解链按钮 + 武装式二次确认）：关系行置 `unlinked_at` 墓碑（不物理删除），子任务编排标记清除、回归普通任务，终态不再通知。墓碑拦截自动重关联：LinkTask 对墓碑子任务默认拒绝，仅当用户明确点名要求时模型才可带 `force=true` 重试（服务层校验，`force` 是工具入参）。
- 子任务任一终态（含用户手动多轮的终态）都通知编排会话，通知注明来源任务名称并附**最终回复的有界摘要**（尾部窗口最后一条 assistant 消息，约 400 字封顶；失败附错误摘要）：编排 agent 默认凭摘要汇报、不再全量读取子会话。摘要不可用（子任务 runtime 已被回收，v1 sessionMessages 只认活跃会话）时降级为引导语。面向编排会话的注入文本与工具输出不携带 taskId / inputId 等内部标识（诊断日志除外）。
- 终态通知是**持久意图**（tasks-index `orchestration_pending_notifies` 表）：`armed_at` 是已处理终态的水位线——武装 relay 时落行（记水位线与 workspace 路径/身份快照），成功投递后把水位线推进到投递时刻，行随 link 存续（spec 既有要求"含用户手动多轮的终态都通知"，订阅不随单次终态销毁），取消关联时删行。投递必须消化两类瞬态失败——编排会话正在执行（v1 `session/send` 拒绝 "A prompt is already running"）退避重试；编排会话冷（runtime 已回收）先 `resumeSession`（带该编排任务 tasks-index 最后使用的 provider/model 兜底）再重试。重试有界，最终失败保留行。host 启动时恢复扫描：link 已墓碑→清行；子任务已终态且 `updated_at > armed_at`→补投；其余（未终态或终态早于水位线的陈旧终态）→按原水位线重新武装 relay。不持久化会导致：app 重启后武装全灭（长周期编排的子任务完成永远不通知，实测 11 个子任务零通知）、并行子任务挤进 busy 窗口的通知被静默丢弃（实测 15 个子任务丢 2 个）。
- 关联分析（link 候选匹配）：`ListWorkspaceTasks` 每条带最近一条 assistant 回复的有界摘要（约 120 字，仅最近活跃前 20 个非 orchestrator 任务）——候选匹配以摘要（任务实际在做什么）为准，标题相似不足以判定；不确定时编排 agent 先对候选 `ReadSessionContext` 核查目标再关联（LinkTask modelInstructions 引导）。摘要读取经 v1 sessionMessages，CLI 侧对不在 v1 registry 的会话（v4/web 创建）用 sessionStore 冷读兜底，读不到才为 null。
- 子任务命名：派生时 SpawnSubTask 入参含 `name`（模型按任务内容起的简短专名），host 在首条指令送达后经 `renameTask`（titleSource=custom）落为任务标题；该标题防自动改名覆盖（tasks-index `title_overridden`），侧边栏、通知、工具输出统一用它。
- 其他对话的 # 引用候选不列出 orchestrator 任务；child 任务仍可被引用（它就是普通任务）。
- 编排任务本身是普通 session：手机 `web-remote-replayable` 恢复、多窗口 attachment、owner/lease 语义全部沿用。

## 状态所有者

| 状态                  | 唯一所有者                                                                          | 说明                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 编排关系（边 + kind） | tasks-index `orchestration_links` 表（taskIndexRepo）                               | PK `(workspace_key, orchestration_task_id, child_task_id)`；kind = `derived` \| `linked`；写入路径唯一：host orchestration 方法 |
| 身份快照              | `ZCodeTaskMeta.orchestrationRole` / `orchestrationParentTaskId` + tasks 表投影列    | links 的投影，读侧加速；`syncTaskMetaWithGroupedAdmission` preserve 列表必须兜底，防止运行态 snapshot 冲掉标记                  |
| 会话工具面            | CLI `AgentRuntimeConfig.taskType`（`orchestration_parent` / `orchestration_child`） | 会话级事实，非 turn 级 denylist（turn 级在用户手动输入后会拿回工具面）                                                          |
| 子任务终态事件        | `zcodeTaskIndexSyncer.emitTerminalAndReady`（既有）                                 | host 消费，不另建订阅源                                                                                                         |
| 终态通知的持久意图    | tasks-index `orchestration_pending_notifies` 表（taskIndexRepo）                    | PK 同 links；armed 时 upsert、投递后推进水位线、墓碑时删除；host 启动恢复扫描的唯一输入                                         |

## 接口

- v1 协议（`packages/shared/src/zcode-protocol/index.ts`）新增方法：`orchestration/spawnSubTask`、`orchestration/linkTask`、`orchestration/listChildren`（CLI 工具经反向 RPC 调用，模板：`automation/create`）。
- v4 `createSession` payload 新增 optional `orchestrationRole: "orchestrator"`；CLI 解析后设 taskType 并投影到 sessionSummary。
- v4 `sessionSummarySchema` 新增 optional `orchestrationRole`、`orchestrationParentTaskId`（additive optional，既有兼容模式），供「编排」分区过滤与 # 引用排除。

## 事件顺序

```text
派生：编排会话 SpawnSubTask 工具 → 反向 RPC host:orchestration/spawnSubTask
  → taskIndexRepo 事务：写 links(derived) + 盖 child 标记
  → createTask(deferred) + sendPrompt(首条指令) → renameTask(name, titleSource=custom)
  → 返回 { childTaskId, childTaskName } → 工具结果只回传 childTaskName（模型侧不接触 id）

终态：child session 终态（任意轮）→ taskIndexSyncer 事件 → host 过滤 role=child
  → 查 links 得 parent → 读 tasks-index 最新 title + readSessionMessages 取最终回复摘要
  → sendPrompt 注入编排会话（【编排通知】子任务「名称」已完成 + 摘要，不含 taskId/inputId，
    引导编排 agent 凭摘要汇报、非必要不 ReadSessionContext）
  → CLI CommandInbox 串行 admission → 确需细节时经 ListOrchestrationChildren
    换取 taskId → ReadSessionContext

关联：编排会话 LinkTask → host:orchestration/linkTask
  → 校验（同 workspace / 目标非 orchestrator / 目标非他人 child）→ INSERT OR IGNORE links(linked) → 盖 child 标记
```

## 不变量与失败语义

- 幂等：links PK 防重复关联；spawn 重试靠 childTaskId 新建（不幂等，调用方持有失败即无副作用——建任务失败不落 link）。
- 拒绝条件：跨 workspace 派生/关联、关联 orchestrator、**关联归档任务（硬性规定：归档不参与统筹；listWorkspaceTasks 候选排除归档，服务层 getTaskBucketFlags 校验拒绝）**、orchestration_child 会话内调用编排工具（工具不存在，结构性拒绝）。**多编排跟踪允许**（用户确认）：同一子任务可被同 workspace 多个编排关联（links PK 天然支持），tasks 行 parent 列只记首个父（UI 下拉按它分组），各编排的下发与终态通知按各自 link 行独立工作——内存 relay 键必须含主任务 id（`workspace:orchestration:child`），一个编排的下发/取消关联不得 dispose 其他编排对同一子任务的订阅（单父键的实测争抢点）。
- 手机/断连：编排会话经 replayable 恢复时，终态通知与其他输入一样进 runtime command queue 重放；断连期间的子任务终态在重连后由 tasks-index 状态兜底（不依赖通知不丢）。
- 普通任务零回归：无标记任务的 meta 解析、列表、分组、引用、生命周期全部走原路径（新字段全 optional）。

## 迁移边界

- tasks-index migration 0004：`tasks.orchestration_role`、`tasks.orchestration_parent_task_id` 两列 + 部分索引；新表 `orchestration_links`。0001 冻结列不动，存量数据不回填（role 为空 = 普通任务）。
- tasks-index migration 0007（跳过 0006：共享 DB 已被安装版 app 的 0006_task_group_admissions 占用）：新表 `orchestration_pending_notifies`（workspace_key PK 前缀 + workspace_path/workspace_identity 快照 + armed_at）。存量 armed 状态不回填（重启前未送达的通知无法区分陈旧终态，宁缺毋滥）。

## 验收场景

1. 「新建编排任务」→ 首条消息 → 任务仅出现在「编排」分区；普通任务入口行为不变。
2. 编排会话中 agent 调 `SpawnSubTask` → 新普通任务带 child 标记出现在任务列表，收到首条 prompt。
3. child 会话中编排三工具不存在；`Agent`（子代理）工具仍可用。
4. child 完成（含手动轮）→ 编排会话收到注明来源任务名称、附最终回复摘要的通知（无内部 id），且编排 agent 不为汇报而全量读取子会话。
5. `LinkTask` 关联已有普通任务 → `ListOrchestrationChildren` 可见；关联任务不被注入指令。
6. 任意其他对话 # 引用候选不含编排任务。
7. 存量普通任务（无标记）在升级后所有路径行为不变。
8. 并行子任务几乎同时终态（间隔 < 单轮编排回复时长）→ 每个子任务的【编排通知】都到达编排会话（busy 重试兜住排队窗口）。
9. 下发后 app 重启 → 子任务完成后再次启动 app → 恢复扫描补投该终态通知，不依赖进程存活。
10. 取消关联后子任务终态 → 不通知，且 pending 行被清理。
