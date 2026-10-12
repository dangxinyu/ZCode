# 编排任务（Orchestration Tasks）

状态所有者与数据模型见本 spec；CLI 工具面与 host 派发细节引用 `apps/zcode-cli` 与 `packages/desktop` 内实现。

## 行为定义

- 「普通任务」语义不变：新建任务按钮、任务列表、分组/项目视图对无标记任务的行为保持现状。
- 新增「编排任务」（orchestrator）：侧边栏「新建任务」按钮下方新增「新建编排任务」入口；侧边栏一级 tab 在「分组/项目」之后新增「编排」分区，仅列出 orchestrator 任务。
- 编排任务会话内注入编排工具：`SpawnSubTask`（派生=新建普通子任务并发首条指令）、`LinkTask`（关联=把同 workspace 已有普通任务纳入统筹）、`ListOrchestrationChildren`（列出子任务与状态）。
- 派生子任务（child）：由 host 域创建普通任务并盖 child 标记；child 会话**会话级**禁用三个编排工具（不可再派生/关联），其内部 subagent 能力不受影响。
- 关联语义（已确认决策）：关联任务只纳入统筹（收终态、可被 list/读取），编排**不主动**向关联任务注入指令；派生任务由 spawn 时携带的首条 prompt 驱动。
- 子任务任一终态（含用户手动多轮的终态）都通知编排会话，通知注明来源任务与轮次。
- 其他对话的 # 引用候选不列出 orchestrator 任务；child 任务仍可被引用（它就是普通任务）。
- 编排任务本身是普通 session：手机 `web-remote-replayable` 恢复、多窗口 attachment、owner/lease 语义全部沿用。

## 状态所有者

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 编排关系（边 + kind） | tasks-index `orchestration_links` 表（taskIndexRepo） | PK `(workspace_key, orchestration_task_id, child_task_id)`；kind = `derived` \| `linked`；写入路径唯一：host orchestration 方法 |
| 身份快照 | `ZCodeTaskMeta.orchestrationRole` / `orchestrationParentTaskId` + tasks 表投影列 | links 的投影，读侧加速；`syncTaskMetaWithGroupedAdmission` preserve 列表必须兜底，防止运行态 snapshot 冲掉标记 |
| 会话工具面 | CLI `AgentRuntimeConfig.taskType`（`orchestration_parent` / `orchestration_child`） | 会话级事实，非 turn 级 denylist（turn 级在用户手动输入后会拿回工具面） |
| 子任务终态事件 | `zcodeTaskIndexSyncer.emitTerminalAndReady`（既有） | host 消费，不另建订阅源 |

## 接口

- v1 协议（`packages/shared/src/zcode-protocol/index.ts`）新增方法：`orchestration/spawnSubTask`、`orchestration/linkTask`、`orchestration/listChildren`（CLI 工具经反向 RPC 调用，模板：`automation/create`）。
- v4 `createSession` payload 新增 optional `orchestrationRole: "orchestrator"`；CLI 解析后设 taskType 并投影到 sessionSummary。
- v4 `sessionSummarySchema` 新增 optional `orchestrationRole`、`orchestrationParentTaskId`（additive optional，既有兼容模式），供「编排」分区过滤与 # 引用排除。

## 事件顺序

```text
派生：编排会话 SpawnSubTask 工具 → 反向 RPC host:orchestration/spawnSubTask
  → taskIndexRepo 事务：写 links(derived) + 盖 child 标记
  → createTask(deferred) + sendPrompt(首条指令) → 返回 childTaskId → 工具结果回流编排会话

终态：child session 终态（任意轮）→ taskIndexSyncer 事件 → host 过滤 role=child
  → 查 links 得 parent → sendPrompt 注入编排会话（inputPresentation=orchestration 通知）
  → CLI CommandInbox 串行 admission → 编排 agent 自行决定汇总时机

关联：编排会话 LinkTask → host:orchestration/linkTask
  → 校验（同 workspace / 目标非 orchestrator / 目标非他人 child）→ INSERT OR IGNORE links(linked) → 盖 child 标记
```

## 不变量与失败语义

- 幂等：links PK 防重复关联；spawn 重试靠 childTaskId 新建（不幂等，调用方持有失败即无副作用——建任务失败不落 link）。
- 拒绝条件：跨 workspace 派生/关联、关联 orchestrator、关联已被其他编排持有的 child、orchestration_child 会话内调用编排工具（工具不存在，结构性拒绝）。
- 手机/断连：编排会话经 replayable 恢复时，终态通知与其他输入一样进 runtime command queue 重放；断连期间的子任务终态在重连后由 tasks-index 状态兜底（不依赖通知不丢）。
- 普通任务零回归：无标记任务的 meta 解析、列表、分组、引用、生命周期全部走原路径（新字段全 optional）。

## 迁移边界

- tasks-index migration 0004：`tasks.orchestration_role`、`tasks.orchestration_parent_task_id` 两列 + 部分索引；新表 `orchestration_links`。0001 冻结列不动，存量数据不回填（role 为空 = 普通任务）。

## 验收场景

1. 「新建编排任务」→ 首条消息 → 任务仅出现在「编排」分区；普通任务入口行为不变。
2. 编排会话中 agent 调 `SpawnSubTask` → 新普通任务带 child 标记出现在任务列表，收到首条 prompt。
3. child 会话中编排三工具不存在；`Agent`（子代理）工具仍可用。
4. child 完成（含手动轮）→ 编排会话收到注明来源的通知并触发一轮统筹。
5. `LinkTask` 关联已有普通任务 → `ListOrchestrationChildren` 可见；关联任务不被注入指令。
6. 任意其他对话 # 引用候选不含编排任务。
7. 存量普通任务（无标记）在升级后所有路径行为不变。
