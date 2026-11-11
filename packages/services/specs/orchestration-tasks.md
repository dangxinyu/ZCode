# 编排任务（Orchestration Tasks）

状态所有者与数据模型见本 spec；CLI 工具面与 host 派发细节引用 `apps/zcode-cli` 与 `packages/desktop` 内实现。

## 行为定义

- 「普通任务」语义不变：新建任务按钮、任务列表、分组/项目视图对无标记任务的行为保持现状。
- 新增「编排任务」（orchestrator）：侧边栏「新建任务」按钮下方新增「新建编排任务」入口；侧边栏一级 tab 在「分组/项目」之后新增「编排」分区，仅列出 orchestrator 任务。分区分页（用户确认 2026-10-23）：默认展示最近 5 个 orchestrator（主任务），每次「显示更多」追加 5 个；编排分区拉全量 timeline 后本地分页，按钮仅在还有未展示的主任务时出现（普通时间线分区保持既有 20 条阶梯分页不变）。
- 编排任务会话内注入编排工具：`SpawnSubTask`（派生=新建普通子任务并发首条指令）、`LinkTask`（关联=把同 workspace 已有普通任务纳入统筹）、`SendChildTaskPrompt`（分发=向在册子任务追加下发一条指令，用户分发语义的执行面）、`ListOrchestrationChildren`（列出子任务与状态）。
- 派生子任务（child）：由 host 域创建普通任务并盖 child 标记；child 会话**会话级**禁用三个编排工具（不可再派生/关联），其内部 subagent 能力不受影响。
- 关联语义（已确认决策）：关联动作本身不注入指令；编排通过显式的 `SendChildTaskPrompt` 向在册子任务（derived/linked）追加下发指令——子目标命中某个子任务领域时优先分发而非自己做。取消关联的子任务不再接受下发（不在册即拒绝）。派生任务由 spawn 时携带的首条 prompt 驱动。
- 取消关联（用户手动，UI 子任务行解链按钮 + 武装式二次确认）：关系行置 `unlinked_at` 墓碑（不物理删除），子任务编排标记清除、回归普通任务，终态不再通知。墓碑拦截自动重关联：LinkTask 对墓碑子任务默认拒绝，仅当用户明确点名要求时模型才可带 `force=true` 重试（服务层校验，`force` 是工具入参）。
- 子任务行归档按钮（用户确认 2026-10-23，解链 + 归档一体）：归档不参与统筹是硬性规定，挂在编排名下的任务归档前必须先解除关系——按钮一次完成 unlinkTask（墓碑 + 清标记 + 废弃 relay + 清 pending 行）→ archiveTask（移入归档区）。武装式二次确认；解链失败中止并提示，关系已不在册（unlinked=false）也继续归档；成功后 bump 全局刷新串号统一重拉。
- **下发驱动的终态上报**：一轮下发（spawn 首条指令 / SendChildTaskPrompt）只上报它触发的那个执行轮的终态（下发后的第一个新终态）；用户在子任务会话里的手动多轮**不上报**（用户确认 2026-10-21：关联任务常在非编排场景独立使用，任一终态都上报会持续骚扰编排会话）。通知注明来源任务名称并附**最终回复的有界摘要**（尾部窗口最后一条 assistant 消息，约 400 字封顶；失败附错误摘要）：编排 agent 默认凭摘要汇报、不再全量读取子会话。摘要不可用（子任务 runtime 已被回收，v1 sessionMessages 只认活跃会话）时降级为引导语。面向编排会话的注入文本与工具输出不携带 taskId / inputId 等内部标识（诊断日志除外）。
- 终态通知是**持久意图**（tasks-index `orchestration_pending_notifies` 表）：下发武装 relay 时落行（记 `armed_at` 与 workspace 路径/身份快照），该轮终态**送达成功后删行**、relay 随之销毁；投递失败保留行。投递必须消化两类瞬态失败——编排会话正在执行（v1 `session/send` 拒绝 "A prompt is already running"）退避重试；编排会话冷（runtime 已回收）先 `resumeSession`（带该编排任务 tasks-index 最后使用的 provider/model 兜底）再重试。重试有界。host 启动时恢复扫描：link 已墓碑→清行；子任务终态且 `updated_at > armed_at`（下发轮已完成）→补投后删行；其余（未终态，或终态早于武装时刻=下发轮仍在排队/执行）→按原 `armed_at` 重新武装 relay。不持久化会导致：app 重启后武装全灭（长周期编排的子任务完成永远不通知，实测 11 个子任务零通知）、并行子任务挤进 busy 窗口的通知被静默丢弃（实测 15 个子任务丢 2 个）。
- **运行时死亡带走的未完成轮次 = 失败（interrupted）**（用户需求 2026-11-04"崩了呢"）：
  恢复扫描的"未终态"分支二分——子会话已不在此运行时（readSession 报 not active/
  sessionnotfound/unavailable）= 上一轮随 runtime 死亡、永远不会有终态 → 按 failed 补投
  红色通知并清行（修复"运行时崩了节点永远执行中"的盲区）；子会话仍活跃 → 按原武装时刻
  重新武装等待真实终态。探测因非冷会话原因失败（启动竞态等）→ 保留行下次再试，不做
  失败推断。终态已落库的行不受影响（仍走"终态晚于武装时刻 → 补投"分支）。
- **手动停止 = 失败（红色）**（用户需求 2026-11-04，实测停止后节点变绿）：子任务终态
  事件的结果有三种 `succeeded | failed | stopped`——手动停止发出 `stopped`，旧映射
  `非 failed 即 succeeded` 把它归成了成功（节点变绿）。修正：**非 succeeded 一律按
  failed 处理**（节点置 failed 红色，轮询兜底与恢复扫描的 error 终态同此口径）。
- **编排会话冷恢复同样补选型**（bug 修复 2026-11-04，实测主任务对话出现
  "Select a model before continuing"）：终态通知投递遇冷编排会话时，此前只带 resume
  提示（且注释赌"编排会话是活跃会话、选型不会失效"）——dev 环境反复重启回收 runtime 后
  提示不生效，注入的通知被运行时闸门拒绝并直接显示在用户对话里。现统一走
  prepareChildSessionForDispatch（探测/冷恢复 + 快照 settings.model.current 校验 + 显式
  setModel：归一 + 任务自身选型兜底 + 首个未禁用项），与子会话下发同一保障。仍无可用模型
  时投递失败保留 pending 行交恢复扫描，下次启动带保障重试。
  **current 非空 ≠ 可用**（同日二次实测：编排会话持久选型非空但已失效，照样在
  model_creation 被 "Select a model before continuing" 拒绝）：生效判定升级为「current 能在
  快照 available 的未禁用项里对上」；对不上/对不出来（available 为空）→ resume 拿完整设置
  重判 → 仍失效走同一补选链。该保障由子会话下发与编排会话通知投递两条路共用。
- **协议词表前向兼容**（bug 修复 2026-11-03）：子会话历史可能由**更新版本**的 App 写入（同一台机器上安装版与开发检出共用 `~/.zcode`），其中合成提醒消息的 `info.source` 可能是本检出未知的枚举值（实测 `agent_listing_delta`，2026-10-15 由安装版写入）。`zcodeSyntheticUserMessageSourceSchema`（shared 协议）与 contracts 的 `SYNTHETIC_USER_MESSAGE_SOURCES` 必须同词表并**前向包含已知新值**；否则冷恢复 readSession/resume 的 zod 校验整段失败、给该子任务的首发必败（agent 侧表现为"首发必报的校验错误，重试即好"——第二次走热路径不再校验）。新增来源时三处同步：contracts 词表、shared 协议枚举、投影策略集合。
- **一轮一报闩 + 失败可见 + 冷恢复选型归一**（实测 2026-10-30 全体点名 12 子任务：5 个重复回报、1 个永远"在路上"）：
  - relay 的订阅与 30 秒轮询是**同一终态的两个观察面**，不是两个终态：首个终态被任一通道捕获即闩住（`terminalCaptured`），另一通道随后的触发一律忽略并停掉（订阅 dispose、轮询 timer 清除）；relay 被同父重下发/解链废弃时同样停轮询。不再有"投递中到来的终态排队补发"——此前订阅先投递、投递期间（编排会话 busy 退避可达分钟级）轮询再触发被排进队列、首投完成后补发同一份摘要，编排会话收到内容相同的重复回报。送达失败仍保留 pending 行交恢复扫描。
  - 轮询兜底除 tasks-index 终态外**补读子会话快照**（`readSession`，messageLimit=1）：`session.status === "error"` 且 `session.updatedAt > armed_at` 且无 activeTurn，**连续两次轮询命中**才认定（send ACK 到执行轮启动之间 status 可能仍是上一轮的 error 而 updatedAt 已被顶新，单次会误报）→ 以"失败"投递通知（正文带 status=error 提示）。此前下发后首轮即崩（模型选型失效等）既无 running→terminal 迁移、tasks-index 行也不更新，两条通道都看不见，编排侧永远等待、pending 行永久挂起。覆盖边界：`readSession` 只能读运行时里驻留的会话，所以此分支覆盖的是**下发后 30 秒窗内会话仍活着**的场景（本次事故的真实路径：resume 后首轮崩、error 态驻留运行时）；runtime 已回收的冷会话（如重启后恢复扫描重新武装的旧行）读不到状态（"Session is not active"），行继续挂起，直到下一次向该子任务下发时被新 relay 取代。
  - 冷会话 resume 的模型提示必须先归一（`buildColdResumeModelHint`）：旧 provider 身份经 `migrateLegacyModelProviderId` 迁移（`builtin:bigmodel-coding-plan` → `account:bigmodel-individual-coding-plan`），混进 modelId 的 `$档位` 后缀拆回 thoughtLevel，官方 GLM 模型名规范化。但 resume 的 model 提示对**已持久化旧选型**的会话不生效（实测两次 resume 后 `settings.model.current` 仍为空，UI 显示"选择模型"，ACK 进去的输入被闸门挡住既不执行也不报错）——所以生效与否以快照 `settings.model.current` 为准：为空就显式 `setModel`，候选按序取**快照可用列表里的规范 ref**（`{providerId: 账号身份, modelId: 模型名}`，与 tasks-index 的 `身份/模型名` 复合串是两种形态，比对前先拆）：子任务归一后的旧选型 → 父编排任务选型 → 首个未禁用项，模型声明了思考档位时必须带 `options.reasoningLevel`（实测 setModel 被拒 "Reasoning level is required"；优先旧 `$档位` → 模型默认档 → 首个档）；setModel 后仍无生效模型或列表为空即抛错让下发失败**可见**（agent 据此转告用户）。这项检查对冷/热会话一视同仁：下发前统一先 `readSession`（messageLimit=1）拿快照，`not active` 才走 resume——此前只在冷恢复路径检查，热会话（上次失败后仍驻留运行时、没有生效模型）的输入照样被 ACK 进闸门后面（实测 agent 重试即命中）。实测：最老的子任务存的是 8 月的 `builtin:bigmodel-coding-plan/GLM-5.2$max`，其余 11 个是 `account:…/GLM-5.3`，只有它卡在闸门。
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
| 终态通知的持久意图    | tasks-index `orchestration_pending_notifies` 表（taskIndexRepo）                    | PK 同 links；armed 时 upsert、送达/墓碑时删除；host 启动恢复扫描的唯一输入                                                      |

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
4. 下发的执行轮完成 → 编排会话收到注明来源任务名称、附最终回复摘要的通知（无内部 id），且编排 agent 不为汇报而全量读取子会话；该通知送达后，用户在子任务会话里的手动多轮终态**不再**产生通知（从编排子任务列表或项目/分组列表进入均同）。
5. `LinkTask` 关联已有普通任务 → `ListOrchestrationChildren` 可见；关联任务不被注入指令。
6. 任意其他对话 # 引用候选不含编排任务。
7. 存量普通任务（无标记）在升级后所有路径行为不变。
8. 并行子任务几乎同时终态（间隔 < 单轮编排回复时长）→ 每个子任务的【编排通知】都到达编排会话（busy 重试兜住排队窗口）。
9. 下发后 app 重启 → 子任务完成后再次启动 app → 恢复扫描补投该终态通知，不依赖进程存活。
10. 取消关联后子任务终态 → 不通知，且 pending 行被清理。

## 终态通知可靠性（用户需求 2026-11-05"好多任务执行完成没有收到消息/节点卡执行中"实测修订）

- **轮询窗口长尾化**：原 10×3s=30s 短窗只兜得住秒级完成的子任务。订阅通道依赖 syncer 的
  running→terminal 迁移帧，running 帧被 sessions-index conflation 吞掉时不发射（spec 既有
  实测）；此后唯一兜底是短窗轮询——长任务（实测 8.5 分钟）完成后无人观察：节点永远执行中、
  通知永不投递、pending 行永久挂起。改为长尾：前 10 次 3s 抓秒级完成，其后每 30s 一次至
  约 2 小时（10×3s + 240×30s），覆盖整个任务生命周期；超长任务由重启恢复扫描兜底。
- **恢复扫描回写计划节点终态**：恢复路径此前只补投通知，不调 markPlanNodeTerminal——节点
  永远 dispatched（画布假执行中）。补投两分支（新鲜 completed/error、中断 failed）都必须
  先回写节点终态，再用 markedNodeIds 触发一次就绪扫描（链式推进与 relay 常规路径同一触发）。
- **死轮确定性判定**：恢复扫描只在 host 启动时运行——重启后上一进程的子任务运行时必然全部
  死亡，tasks 行非新鲜 completed/error 的 pending 轮次都是被中断的，直接按 failed 补投 +
  回写 + 清行。不再用 readSession 探测判活（冷会话从持久层可读成功，误判"还活着"会让
  relay 重新武装后无限轮询死会话）。fresh completed/error 才按 succeeded/failed 补投。
