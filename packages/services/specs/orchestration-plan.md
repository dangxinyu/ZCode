# 编排计划 v2 — 多计划生命周期（基于 orchestration-plan.md v1 演进）

v1 单计划模型升级为**多计划**（用户需求 2026-10-28）：同一编排主任务可有多个计划，
有选中态（active）、节点级与计划级完成状态、计划列表 UI 与画布视图。
执行模型不变（spec: orchestration-tasks.md）；执行者始终是编排 agent。

## 生命周期与状态

- 计划状态：`draft`（草案待确认）→ `confirmed`（执行中）→ `completed`（全部节点 terminal，
  host 在节点终态回写时推导）。人工微调已完成计划 = 对其提交新版本提案（version++），
  状态回 `draft`；被修改的节点回到 `pending`（微调重执行语义见下节），未触碰的
  terminal 节点保持冻结。
- 节点状态：`pending` / `dispatched` / `terminal`（v1 已有）；计划完成 = 全节点 terminal。
- 选中态（active）：编排同时只有一个 active 计划——spawn 绑定、计划门、确认、提案都作用于它。

## 模式开启时的默认选中（用户需求点 4）

打开计划模式：最近创建的计划未完成（status ≠ completed）→ 自动选中它；
最近计划已完成或没有任何计划 → 不选中任何计划（下次提案新建）。
切换选中是 UI/host 动作，不向会话发消息；agent 经 list 工具结果的 planMode/activePlan 感知。

## 多计划语义（用户需求点 1-3）

- 计划模式开启后：active 计划存在 → 提案即改写该计划（新版本）；无 active → 提案新建计划。
- agent 可通过 ProposeOrchestrationPlan 的语义自然新建（无 active 时）；
  用户在 UI 计划列表点击切换 active（切换即时生效，作用于后续派生）。
- 列表展示所有计划（含已完成），仅计划模式开启时展示，默认收起（用户需求点 7）。

## 微调重执行与变更传播（用户修正 2026-10-28）

微调（revision run）中**被修改节点**的执行优先复用原子任务：

- 节点回 pending 时保留 `reuseChildTaskId`（原 childTaskId 引用）。确认后编排 agent 对
  修改节点：链接在册、任务未归档未删除 → **SendChildTaskPrompt 下发原子任务**（微调说明
  写进指令，子任务在原会话上下文上继续）；原子任务归档/删除/已解链 → SpawnSubTask 重新
  派生并自动绑定（planNodeId 通道，childTaskId 更新）。终态回流与通知复用既有链路。
- **变更传播（stale 级联）**：修改节点完成且交付包含代码变更时，其直接下游节点置为
  `stale`（特殊状态："上游已变更，待复核"）。下游复核 = 编排 agent 向其（原子任务或
  重派生）下发检查指令（"上游 X 已修改，检查是否需要跟进"）；下游若判断需要改动并完成
  修改 → 其直接下游继续置 stale，逐层向下传播；判断无需改动 → 停止传播（该分支收敛）。
- 判断权在编排 agent（它读修改节点的交付摘要即可判断），host 提供状态写入口：
  CLI 工具 `MarkPlanNodesStale(nodeIds, stale)`（host 校验节点在 active 计划内），
  确认消息的执行规则中指示使用时机。stale 不是终态：completed 推导要求全节点 terminal，
  stale 节点必须经复核（下发→终态）收敛。
- stale 视图：节点行黄点 + "上游已变更"标签；画布（阶段二）中以警示色边框标出。

## 数据模型（migration 0009）

- `orchestration_plans` 重构为多行：PK (workspace_key, orchestration_task_id, plan_id)，
  列：plan_id（host 生成 uuid）、title（首版提案的名称摘要，可后续改）、plan_mode（迁移自旧行）、
  status、plan_json（nodes + version）、is_active、created_at、updated_at。
- 旧行迁移：单行 → 生成 plan_id 的一行，保留 is_active=1（若有）。
- plan_json 内 nodes 在 v1 结构上扩展：status 增加 `stale`；新增 `reuseChildTaskId`（微调
  重执行的原原子任务引用，pending + reuse = 待复用下发）。version 按计划递增。

## 接口变化

- IZCodeTaskService/UI 通道：`getOrchestrationPlansMap` 返回
  `{ plans: PlanSummary[], activePlanId: string | null }`（PlanSummary = id/title/status/进度
  completedCount/totalCount/updatedAt）；新增 `selectOrchestrationPlan`。
- CLI：ListOrchestrationChildren/ListWorkspaceTasks 结果的 planMode 字段语义不变；
  plan_json 面向模型经提案/确认消息与门错误感知（不展开多计划细节，active 计划即其工作对象）。
- ProposeOrchestrationPlan：作用于 active 计划（无 active 则新建）；输入新增可选
  `title`（新建时起名，缺省取首节点名 + "等 N 项"）。
- 确认/提案注入消息带计划标题，多计划下模型可分辨工作对象。

## UI（用户需求点 6/7）

- 侧栏：计划模式开启时，子任务列表上方显示**计划列表**（可展开，默认收起）：
  行 = 标题 + 进度徽标（已完成/总数节点）+ 状态点；点击行 = 选中（active）并展开该计划详情。
- 计划详情 = 画布视图（@xyflow/react，已是依赖）：节点卡片（状态色边框）+ 依赖边（DAG），
  底部"确认执行"（draft 态）。编辑（增删改节点）经画布节点操作 → host 提案新版本 → 回草案
  待确认（人工修改必须再确认，v1 语义保持）。
- 完成后的计划：列表常驻可见；点开可微调（提案新版本）。

## 验收场景（在 v1 7 条之上追加）

8. 同一编排可存在多个计划，列表全量可见，active 唯一。
9. 开启计划模式：最近计划未完成 → 自动选中；已完成/无计划 → 不选中。
10. 计划全部节点 terminal → 计划自动 completed，列表徽标反映进度。
11. 微调已完成计划：修改节点回 pending，确认后重新派生；未修改节点不重跑。
12. 计划列表默认收起，仅计划模式开启时展示。

## 起始节点不变量（用户需求 2026-10-29）

- 每个计划恰好一个 `isStart: true` 的起始节点（默认名「开始」）：结构标记，无 goal、无 dependsOn，
  永不派发（bindPlanNodeForSpawn 拒绝）、不可删除（画布右键/侧栏删除均禁用）。
- 其余节点必须直接或间接依赖起始节点（不存在悬空节点）；图不允许环。
- 注入时机：手动新建计划（createEmptyPlanRow）自带起始节点；agent 提案/修订（proposePlan）
  缺失时 host 自动补注入（withStartNode），修订后复验；保存与确认通道（validatePlanGraph）
  校验「唯一起始 + 无环 + 全图可达」。
- 确认消息向模型声明：「开始」仅是起点标记，不要派生子任务。

## 画布交互细则（用户反馈 2026-10-29）

- 添加节点落在当前画布视口中心，不触发 fitView（不缩放屏幕）。**双击空白添加节点已
  移除**（用户需求 2026-11-04：双击易误触，添加统一走工具栏「添加节点」按钮）。
- 画布撤销/重做（用户需求 2026-11-02）：⌘Z / Ctrl+Z 撤销，⌘⇧Z / Ctrl+Shift+Z（兼容 Ctrl+Y）
  重做；工具栏同时提供撤销/重做图标按钮（无可撤销/重做项时禁用）。
  - 作用域 = **当前计划本次未保存编辑**：历史栈挂在画布编辑 hook 上、随 resetKey
    （planId:version）清空——切计划、保存、服务端版本变化都从零开始；计划之间互不影响
    （与"切计划丢弃未保存编辑"同一语义，撤销不跨保存边界）。
  - 一步的粒度：增删节点、连线/断线/改接、侧栏字段修改、内联改名各算一步；一次拖动
    或一次缩放（从 dragging/resizing=true 到 =false 的整个会话）算一步；侧栏同一节点同一
    字段 1s 内的连续输入合并为一步。选中/取消选中、进入/退出内联改名不入栈。
  - 服务端事实不受撤销影响：恢复快照时按当前 planNodes 回填 status/childTaskId/
    childTitle/childLocked（与服务器事实补丁同一规则），撤销不会把已派发节点"撤回"成待执行。
  - 恢复快照保留当前选中节点（按 id），清内联改名态；撤销到栈底即视为未修改（dirty=false）。
  - 焦点在输入框/文本域/可编辑区域时不接管 ⌘Z（交给原生文本撤销）；仅 editable 时生效。
- 连线预览用固定亮蓝（#38bdf8）：暗色主题 accent 过深不可辨。
- 选中节点时上下游连线高亮（用户需求 2026-11-02）：点选一个节点后，指向它的（上游）与
  从它出发的（下游）连线统一亮蓝（#38bdf8，同连线选中色）加粗并置顶，其余连线淡化
  （opacity 0.3）；方向靠箭头读，不区分两种颜色。点空白、点选连线或取消选中即恢复。
  连线自身被点选时的高亮优先级不变（有端点手柄可辨），两种状态互斥（点节点清连线选中，
  点连线 xyflow 取消节点选中）。
- 节点尺寸全部挂在 xyflow 节点壳（node.style）；卡片填满壳，禁止自带 min-width
  （否则壳缩小时内容溢出，边框内陷）。默认宽 208。**高度带内容下限**（用户需求
  2026-11-03"默认都小了"）：shell `minHeight` 非起始 168 / 开始 72——自动执行行加入后
  历史小布局（实测 h=42 的开始节点）自动长到装下内容，用户手动调大的高度不受影响；
  新增节点不写死高度（minHeight + 内容撑开，保存时落实测值）。**壳是纵向 flex、卡片
  flex-1 填满壳**（用户需求 2026-11-03"箭头悬空"）：minHeight 抬高壳而内容不足时，
  卡片 h-full 的百分比高度解析不到（壳无显式 height），卡与壳之间留白，底部锚点/
  边线落点悬在空白上；flex 填满后锚点/边线永远贴卡片边。
- 节点右键 → 删除节点（起始节点禁用该项），二次确认后删除并清理指向它的依赖边。
- 依赖关系只在画布连线表达；右侧编辑窗不列上游勾选。
- 保存前置 UI 预检与 host 校验同规则：不合法（悬空/环/缺起始）禁用保存与确认并提示。
- 计划重命名弹窗回车即保存。
- 确认执行前置（用户需求 2026-10-29）：所有非起始节点必须已填写目标，否则「确认执行」
  隐藏并在工具栏提示原因；「保存计划」不受此条限制（草稿可先存后补）。
- 确认执行前置补充（用户需求 2026-11-02）：**至少一个非起始节点**。起始节点只是结构标记，
  只有「开始」的计划没有可执行内容，工具栏不出现「确认执行」；host confirmPlan 同规则拒绝
  （此前两边都只判 nodes.length>0，把起始节点算了进去）。
- 下拉「新建计划（AI 生成）」入口（用户需求 2026-10-29；同日改版：**不发任何消息**）：
  计划模式下拉首项；0 计划时下拉不禁用。选中 → 只翻转服务端等待态 `pendingNewPlan`
  （orchestration_plan_mode 表 0010 列，零计划也可存），下拉显示「新计划（等待创建）」、
  入口变「取消新建计划」（再点撤销）。**起不起新计划由后续对话决定**：agent 经
  ListOrchestrationChildren/ListWorkspaceTasks 结果里的 pendingNewPlan 字段感知
  （Session Guidance 教决策规则：当前消息确需新计划 → ProposeOrchestrationPlan(createNew=true)
  落地新计划（置 active）并填充草案；否则正常处理）。等待态在新计划落地或用户取消时清除。
- createNew 全链路透传（bug 修复 2026-11-02）：CLI 工具 → bootstrap port → 协议
  `zcodeOrchestrationProposePlanParamsSchema.createNew` → **host handler
  （zcodeAgentService orchestrationProposePlan）→ planService.proposePlan** 每一环都必须带上
  createNew。实测 host handler 漏转：agent 按等待态正确带了 createNew=true，host 侧却走修订
  分支，18 个新节点合并进 confirmed 的老计划、等待态清不掉。新增字段时以此链路为检查清单。
- 下拉是单选（用户需求 2026-11-02）：等待态与"选中某个现有计划"在下拉里互斥呈现——
  触发器**等待态优先**显示「新计划（等待创建）」，有活动计划也一样（之前活动计划名
  抢占了触发器，等待态只在零计划时才露脸）；等待态下现有计划项**不打勾**，菜单顶部的
  等待行就是当前选择。用户在等待态**显式点选某个现有计划 = 放弃新建意图**：
  `selectPlan(clearNewPlanPending=true)` 在同一次写入里清等待态（UI 入口
  selectOrchestrationPlan 对非 null planId 固定传 true）。执行节点前的"执行口径跟随
  被执行计划"内部预选与协议对称 handler 不传该标记——执行动作不替用户取消对话意图。
  服务端 activePlanId 在等待态下照常保留（agent 执行口径不变），仅下拉呈现互斥。
- 确认后画布可编辑（用户需求 2026-10-30）：确认执行 ≠ 锁死——active confirmed 计划的
  画布保持可编辑（增删节点/连线/改名/改目标/保存），修订通道保持 confirmed 不打回草稿
  （打回会重阻塞派发）；已派发/已完结节点禁止删除（执行事实，删了终态回传失真），
  确认按钮只在草稿态出现。
- 计划变更广播（用户需求 2026-10-30）：plan service 全部变更路径（提案/修订/确认/
  派发绑定/节点终态/stale/等待态/模式与选中/重命名/删除/手动创建）发
  `orchestration:plans-changed` 广播（payload 仅 orchestrationTaskId）；UI 侧
  useOrchestrationPlansChangedSync（composer 控制钩子 + 计划页挂载）收到即 bump
  全局计划版本号统一重拉——agent 侧变更不经 UI 动作也能实时上屏。
- 布局持久化（用户需求 2026-10-30）：revisePlanNodes 冻结节点保留执行事实但接受
  提案侧新布局（布局是纯展示）；toSavePayload 始终携带 layout。
- 上游交付语义（用户需求 2026-10-30）：上游仅起始节点（或无上游）的节点
  needsUpstreamResult 恒为 false——revisePlanNodes 归一 + 侧栏勾选禁用并提示。
- 画布执行可见性（用户需求 2026-10-30）：节点卡片显示真实子任务标题
  （childTaskId → sessions-index 解析，未绑定回落节点名）；确认后工具栏与侧栏列表
  展示执行进度 done/total（口径统一 = 非起始节点 terminal，起始只是结构标记）；
  节点卡片按状态着底色（执行中蓝/完成绿/stale 黄/待执行中性灰），边框色不变。
- 等待态清除时机（用户需求 2026-10-30）：proposePlan **新建分支落地即清** pendingNewPlan，
  不依赖 agent 是否传 createNew（agent 重试可能省略该标记，实测漏清）。
- 零计划开启计划模式 → 默认进入「另起新计划」等待态（用户需求 2026-10-30）：开启开关
  时无任何计划行则同时置 pendingNewPlan=true，首个需求由 agent 按对话决定是否落地新计划；
  下拉即时显示等待态（setPlanMode 返回的 plansMap 已含该字段），用户可手动取消。
- 草稿态下拉默认新计划（用户需求 2026-11-02）：新建编排任务尚未首发（无 sessionId）时
  plansMap 没有服务端事实，开启计划模式后下拉**默认显示「新计划（等待创建）」**——草稿
  必然零计划，镜像上条服务端规则，避免显示「暂无计划」与建会话后的实际状态不一致。
  草稿态「新建计划/取消新建计划」走与计划模式开关同款的本地意图通道（不再因无
  sessionId 死点击）：未点过 = 跟随默认（新计划），点过以最后一次为准；会话创建后
  **先补投模式、再补投新计划意图**（setPlanMode 零计划会默认置 pending=true，顺序颠倒会
  覆盖用户的显式取消）。
- 注入选型的 registry 校验（用户需求 2026-10-30）：快照/meta 候选整体可能是旧环境的
  失效值（实测会话快照停在 "glm"，ProviderNotFound）。候选逐个过 ModelSelectionView
  （Registry 构造，provider+model 双重校验），全部失效退 view.preferredSelection；
  host 侧 modelSelectionService 注入 plan service。
- 内置计划模式隔离（用户需求 2026-10-30 定稿）：编排主任务**结构性**排除内置计划模式，
  开关状态无关——CLI 侧不注册 EnterPlanMode（ExitPlanMode 保留作逃生口），UI 模式下拉
  对编排主任务一律隐藏「计划模式」勾选项。RPC 契约：proposePlan 结果含 planId（CLI 端口
  显式映射，不透传给模型）。
- 确认通知注入的模型兜底（用户需求 2026-10-29）：确认消息等 notice 注入走 sendPrompt
  直通，不带 UI 发送通道的 modelSelection；server 重启后主会话 runtime 无选型，首轮会被
  模型闸门拒绝（"Select a model before continuing"）。选型兜底链：会话快照
  settings.model.current → lastUsed（随 UI 发送持续更新，当前 registry 内合法，
  读取不要求 runtime 存活）→ tasks-index meta 最近一次的 provider/model
  （thoughtLevel 映射为 modelSelection.options.reasoningLevel；跨环境可能遗留
  失效 id 如 "glm"，曾实测命中 ProviderNotFound，故只作末位兜底）。全缺时裸发，
  选型无效的错误经注入外层 catch 吞掉，不阻断会话。
- host 提案规范化：新建与修订分支都会补起始节点（缺失注入/占用 start id 收编）并把
  无上游的根节点自动接线到起始（冻结节点除外）；needsUpstreamResult 缺省 true。
- active 计划契约（写入确认消息）：用户切换选中计划后，agent 的修订提案与派生都作用于
  当前 active 计划；新需求需调整计划 → 修订并等确认，无需调整 → 按计划直接执行。
- 计划节点 ↔ 子任务显式绑定（用户需求 2026-10-30）：手动关联（linked）子任务没有
  spawn 通道的 planNodeId，绑定原本只覆盖 agent 派生路径，画布的执行可见性形同虚设
  （实测：12 个 linked 子任务全部完成后节点仍一片 pending）。新增
  BindOrchestrationPlanNodes 工具（orchestration/bindPlanNodes）：active confirmed
  计划内把已关联子任务挂到节点（childTaskId=null 解绑）；同一子任务只能挂一个节点，
  起始节点不可绑定；绑定只记关联、**不改节点状态**（原"按子任务现状回填"规则已于
  2026-11-02 废止，见文末"节点完成由节点自身执行决定"）。全量校验通过才写库（批量半成功比整体拒绝难解释）；
  写库后照常广播。childTaskId 对模型不可见，由 List 工具结果提供、绑定工具回传。
- 画布服务器事实补丁（用户需求 2026-10-30）：planNodesBase 变化时对已编辑画布
  （editNodes 非空）只回填非编辑字段（status/childTaskId/childTitle），不整体重建
  （会冲掉未保存编辑）；名称/目标/依赖/布局属用户编辑面，保存仍以画布为准。
- 完成态读取时推导（用户需求 2026-10-30 定稿）：计划是否完成只看节点状态，不给计划
  单独的可漂移状态——rowToPlan 读取时按 deriveStatus 推导（中途关会话、终态写丢都不会
  让显示停在"执行中"转圈）。口径 = 非起始节点全部 terminal（start 是结构标记永远
  pending，旧口径含 start 导致完成态永不翻转，实测踩坑）；stale 不算 terminal 必须
  复核收敛；修订加入新节点后回落 confirmed。库列退化为缓存，写入侧照常回写推导值。
- 计划名不可变（用户需求 2026-10-30 定稿）：计划名一经确定，除用户 UI 重命名外任何
  路径不得改名——proposePlan 修订分支一律沿用 current.title（提案侧 title 只在建新
  计划时生效；此前 `params.title ?? current.title` 让 agent 修订带 title 变体即可静默
  改名，实测出现"（重新发起）"后缀）。CLI 契约描述与模型引导同步加硬约束：禁止发明
  标题变体（重新发起/(redo) 等），重做 = 按现名修订现有计划，非用户明确要求不另起新计划。
- 节点子任务独立区块与手动改绑（用户需求 2026-10-30 定稿）：卡片底部一块近实底
  （bg-background/85）专属区域显示关联子任务（label + 标题 + 锁标），替代旧
  bg-accent/10 + text-accent 小字行（完成态绿底上几乎不可读，用户实测）。未执行完成
  （非 terminal）的节点可在编辑器手动改绑/解绑编排子任务（候选 = links 权威列表，
  标题经 sessions-index 解析；已绑到其他节点的子任务不进候选）。绑定即"确定"：
  落 childTaskLocked=true，此后主任务 spawn（bindPlanNodeForSpawn）与 agent 绑定工具
  （bindPlanNodesToChildren）改绑/解绑该节点一律拒绝——只能向既定子任务下发指令；
  绑同一子任务 = no-op。用户解绑（childTaskId=null）清除锁定，主任务可重新发起关联。
  锁定只由用户手动绑定产生，agent 绑定永不落锁；节点语义被修订改变时锁定随执行事实
  一起重置（revisePlanNodes modified 分支）。同一子任务仍只能挂一个节点（用户通道
  服务端同样校验）。在册校验/广播与 agent 绑定同源（bindPlanNodeForUser）；绑定不改节点状态。
- 完成态可编辑 + 查缺补漏（用户需求 2026-10-30 定稿）：完成态计划画布可编辑（不能
  一锤子买卖）。编辑保存走既有修订通道，配套两个重算：① 被语义修改的 terminal 节点
  回 pending（既有 revisePlanNodes modified 分支）、新增节点 pending；② 查缺补漏——
  修订后结果依赖边（needsUpstreamResult=true）的上游出现非 terminal（含被改回
  pending/新增/已标 stale）时，其已完成下游级联标 stale 直到不动点（纯排序边不传染；
  stale 收敛仍走 MarkPlanNodesStale 复核流程）。计划整体状态随之自动脱离 completed
  （读取时推导：存在非 terminal 即非 completed），执行可继续（assertDispatchAllowed
  放行 confirmed），全部收敛后重新推导回 completed。
- 查看与执行口径解耦（用户需求 2026-10-30 定稿，取代早前"点击自动切 active"方案）：
  「点哪个计划就看哪个计划」是纯 UI 视图态（pageRequest.focusPlanId），与状态无关、
  不判断任何服务端选中；计划页选中优先级 = focusPlanId 优先，activePlanId 仅在无
  focus（composer 入口）时兜底显示。所有 UI 写操作（画布保存 proposeOrchestrationPlanEdit、
  确认 confirmOrchestrationPlan、手动改绑 bindOrchestrationPlanNodeChild）显式携带
  planId 定位正在查看的计划，服务端按 planId 查行（不存在直接报错，不静默落新建），
  不再依赖 active；agent 通道（ProposeOrchestrationPlan/confirmPlan 缺省）仍走 active。
  确认例外：确认哪个计划就把哪个计划置为唯一 active（setActiveOrchestrationPlan，执行
  口径跟随确认）。按 planId 写行必须保留该行自身 isActive 标志（upsert 不维护唯一
  active，写 true 会造出第二个 active 行）。侧栏「当前」徽标与行高亮 = 主区正在查看的
  计划（pageRequest 匹配 parentTaskId；无 focus 时回落 activePlanId），与主会话选择的
  视图保持一致，不再读服务端 activePlanId；计划页随任务选中关闭（App 层 handleSelectTask）。
- 导航闭环（用户需求 2026-10-30 定稿：主任务/子任务/计划/计划间都要顺滑切换）：
  ① 点计划条目 = 先经侧栏任务选择漏斗跳到主任务会话，再 openOrchestrationPlanPage
  打开目标计划页（计划页挂在主任务 SessionPane 里，主任务未选中时只发页面信号看不见；
  OrchestrationChildrenList 持有主任务 workspace 坐标组装 onOpenPlan）；② 关页归口在侧栏
  任务行选择入口 WorkspaceSidebar.handleTaskRowSelect（用户主动导航：点任何任务行 = 看它
  的对话，先 closeOrchestrationPlanPage 再选中会话）。不能放在 shell 的
  handleSelectTaskInChat 漏斗——WorkbenchPane 对会话区内任何点击（含计划页画布）都会走
  "激活当前会话"进到该漏斗，在那里关页会把计划页内的普通点击变成退出（实测踩坑
  2026-10-30）；③ 计划互切：画布编辑器 resetKey 变化必须经 setEditNodesBoth(null) 连 ref
  一起清——只清 state 时同一提交里后执行的服务器事实补丁 effect 会按 ref 中上一份计划
  的节点整表回填，画布停在旧计划（实测 A→B 仍显示 A 的 13 节点）。
- 节点完成由节点自身执行决定（用户原则 2026-11-02 定稿）：节点状态只走自己的执行生命周期
  pending →（派发）dispatched →（派发的那轮执行完成，markPlanNodeTerminal）terminal；**绑定
  子任务不改节点状态**——用户手动改绑（bindPlanNodeForUser）与 agent 绑定工具
  （bindPlanNodesToChildren）都只记 childTaskId/锁定，原"按子任务 tasks-index 现状回填
  （已完成直接亮 terminal）"规则废止：把已完成的历史任务绑上来会让从未派发的节点直接
  terminal，整个计划"未执行先完成"（用户实测「新计划」）。子任务过去跑完过与本节点无关；
  节点要完成，得由编排派发它、等那一轮回报。配套 UI：编辑器"关联子任务"下拉必须把当前已
  绑定的子任务作为选中项列出（此前把它过滤掉，`<select>` 找不到匹配项回落显示"未关联"），
  候选列表没加载/不含它时用卡片标题兜底。
- 节点执行通道统一 + 手动执行/手动完成（用户需求 2026-11-02）：
  - 节点进入 dispatched 的唯一口径是 `markPlanNodeDispatched(planNodeId, childTaskId)`：未绑定则绑上
    该子任务（用户锁定到别的子任务 → 拒绝，同 spawn 规则），已是 dispatched → 拒绝"正在执行"，其余
    状态（pending/stale/terminal 重跑）一律置 dispatched；完成仍只由该轮终态回报（markPlanNodeTerminal）。
    SpawnSubTask 的 planNodeId 走 bindPlanNodeForSpawn（新建子任务），**SendChildTaskPrompt 新增可选
    planNodeId** 走本口径：执行计划节点时若目标是已有子任务，agent 必须带上，否则节点既不绑定也不
    进 dispatched、终态回传找不到落点，计划永远"执行中"（实测：确认后 agent 用 SendChildTaskPrompt
    给 1 号点名，9 秒就回报了，节点却一直 pending、侧栏一直转圈）。绑定/置态在 relay 武装与发送之前，
    秒级终态也能落点；**发送失败必须回滚**（bug 修复 2026-11-03）：`markPlanNodeDispatched` 返回
    置态前的 `{previousStatus, previousChildTaskId}`，下发失败时经 `revertPlanNodeDispatch` 把节点
    状态/绑定恢复原样（仅当节点仍是本次置的 dispatched+同一 childTaskId 才回滚，防止覆盖并发的新派发）
    再抛错回 agent。此前"失败保持 dispatched 由 agent 重试"与"已是 dispatched → 拒绝"互相锁死：实测
    子会话首发因 schema 校验失败，重试被 "already executing" 拒绝，agent 把这句当成已派发并汇报成功，
    节点永远 dispatched 且没有任何回报在途。回滚只在"给已有子任务下发"路径；spawn 路径子任务已建
    且已绑定，首发失败保留绑定（错误文案指引打开子任务手动发送，终态仍经 relay 回传）。
  - 确认消息的节点清单必须带节点 id（`名称［id: xxx］（目标…）`）：手动建的计划节点 id 是随机串，
    不列出来 agent 填不了 planNodeId。
  - 手动执行（节点卡"执行"按钮，起始节点无）：UI → `executeOrchestrationPlanNode(planId, planNodeId)`；
    目标计划非 active 先 selectPlan；提示词 = 节点目标（空则节点名），needsUpstreamResult 时附上游
    节点已绑定子任务的最终回复摘要（readLatestAssistantReplyExcerpt，每条有界）；有绑定子任务 →
    sendChildTaskPrompt（带 planNodeId），无 → spawnSubTask（name=节点名，带 planNodeId）。计划门
    （assertDispatchAllowed）照常生效：草稿计划不可执行。正在执行（dispatched）的节点不提供执行按钮。
  - 手动完成滑块（起始节点无）：`setPlanNodeManualDone(planId, planNodeId, done)`——开 → terminal，
    关 → pending（关联与锁定不动）；用于回报丢失、线下完成等容错场景。它和终态回报都是"节点自己
    的完成"口径，与子任务历史无关。**开**会触发就绪扫描（解锁自动下游）；**关**（撤回完成）
    不触发扫描——撤回不是重跑指令（用户需求 2026-11-04，实测点掉后节点被立即重新派发）。
  - **节点自动执行**（用户需求 2026-11-03）：非起始节点带 `autoExecute` 开关（卡片
    「完成后自动执行下游」滑块，独立一行——与执行/手动完成行并排放不下），
    开始节点带**总控滑块**（点一下全部非起始节点开、再点一下全关；勾选态 = 全部已开）。host 侧
    自动派发引擎（orchestrationPlanAutoDispatch.autoDispatchReadyNodes）：节点满足以下全部条件时
    host 自动派发（与手动执行同一条 dispatchPlanNodeOnce 通道，计划门照常）。
    **极性（用户需求 2026-11-04 翻转）**：开关挂在"释放方"上游上——X.autoExecute=true =
    X 完成后自动执行 X 的下游；节点 Y 可自动派发 =
    ① status ∈ pending/stale；② 依赖全部 terminal（start 视为满足）；
    ③ **所有非起始直接上游的 autoExecute=true**（Y 自身的开关只决定它完成后是否释放它的下游）。
    手动闸门级联断流：任一上游关自动，它完成时就不释放下游，链路在该下游之前停住——"不自动的
    场景断得掉"；沿途全开则波次推进不断流（用户实测语义：任务1 开、任务2 关 → 任务2 会自动跑、
    任务3 之前停住）。
    - **autoExecute 是画布可编辑配置**（用户需求 2026-11-03 改版："新增时就把配置确定好"）：
      开关进画布编辑缓冲（updateNodeData/总控 setAllAutoExecute），随「保存计划」经
      proposeOrchestrationPlanEdit 落库（保存通道节点携带 autoExecute，提案值优先、缺省保留
      存量/按 origin 取默认）；保存与确认后 adapter 触发就绪扫描（草稿计划扫描自身跳过）。
      服务端即时翻转接口（setPlanNodeAuto/setPlanAutoAll）已删除——单一写入路径 = 保存通道。
    - 默认值：agent 提案新建（proposePlan createNew 分支）非起始节点 `autoExecute=true`；手动创建
      （createEmptyPlan）`false`；修订（revisePlanNodes）提案值优先、按 nodeId 保留原值，新增节点
      按计划 origin 取默认；历史计划无字段一律视为 false（不意外自动跑老计划）。
    - 触发时机（每次触发都是一次就绪扫描，幂等）：确认计划后（起第一波，全图）、任一节点
      终态（relay markPlanNodeTerminal 之后）、手动完成**开启**后。
      **触发范围（用户需求 2026-11-04 实测修复"无关节点被连带执行"）**：终态与手动完成
      触发的扫描只考虑**触发节点的直接下游**（候选 dependsOn 与本轮真实迁移的节点 id 有
      交集）——上游完成只释放自己的下游，不是"谁就绪谁跑"；直连 start 的节点没有可完成的
      上游，只由确认计划（全图第一波）/「继续执行」/点「执行」/agent 派发拉起。
      手动完成**关闭**
      （撤回完成 → pending）**不触发**（用户需求 2026-11-04，实测"点掉就被重跑"）：撤回不是
      重跑指令——此刻节点 pending+自动开+依赖满足，扫描会立刻把它重新派发给关联子任务；
      撤回后是否再执行由该节点自己的自动开关与后续常规触发决定。
      **保存计划不触发**（用户需求 2026-11-04，实测保存后就绪的自动节点被立即派发）：
      保存 = 只落库配置，绝不执行；已确认计划里刚落库的自动配置在下一个常规触发生效，
      要立即推进就绪节点用「继续执行」按钮或点节点「执行」。
    - 失败即停不重试：自动派发失败的节点按既有回滚规则恢复原状并保留错误可见性，**不自动重试**，
      等人工/agent 处置；同一波的其他兄弟节点不受牵连，各自独立派发。失败节点未 terminal，其
      下游自然停住。
    - 与 agent 的分工（极性翻转后收敛，用户需求 2026-11-04）：已确认计划里，上游开关全开的
      就绪节点由 host 即时自动派发（agent 收到终态回报后正常汇报即可）；上游开关没全开的
      节点是断流点，agent 自主派发会被闸门拒绝——它应向用户转告暂停位置，而不是重试。
      用户在对话里显式点名派发某节点时，闸门放行（上游全开）或给出暂停原因（有关着的上游）；
      要绕开断流就点节点上的「执行」按钮（人类显式动作，带 bypass）。CLI 计划模式引导同步
      此分工。
    - **未保存节点禁用服务端操作**（bug 修复 2026-11-03，实测"Unknown plan node"）：执行按钮、
      手动完成滑块走服务端翻转，画布上未保存的本地新节点（编辑缓冲 id）禁用，hover 提示
      "先保存计划"。自动开关不在此列（改版后它是本地编辑配置，未保存节点随时可拨）。
    - **失败状态（红色）**（用户需求 2026-11-04：既然成功是绿色，失败就是红色）：节点状态
  增加 `failed`——绑定子任务失败/被取消/被手动停止时，挂它的全部节点置 failed（红框/
  红底/红 X 图标），与成功=绿色对等。**stopped 的源头在 syncer**：v4 中断收口
  （completedInterrupted）此前与正常完成一起映射成 turn.completed → succeeded；现终态
  事件携带 `interrupted` 标记，adapter 映射为 outcome=stopped，relay 按"非 succeeded 一律
  失败"落 failed。失败是**人工停留点**：不进 completed 推导、不计数为完成进度、自动引擎
  不自动重试（失败即停）；重试路径 = 点节点「执行」或「继续执行」（批量重派含 failed
  节点，重新下发关联子任务）→ 回到 dispatched；用户判定其实已完成则用「手动完成」人工
  裁定 terminal。**终态回写覆盖全部计划**（bug 修复 2026-11-04，实测中断后节点永远卡
  "执行中"）：同一子任务常在多个计划里都有绑定（老计划副本残留绑定），markPlanNodeTerminal
  此前按 childTaskId 找到**第一个**匹配计划就落库返回——终态写进遍历序靠前的老计划
  （plan-360ffb45），活跃计划里刚派发的节点收不到终态；现在每个含匹配节点的计划都各自
  落库，并返回本轮真实迁移的节点 id（markedNodeIds）供自动派发扫描限定触发范围。
- **节点常驻 skill**（用户需求 2026-11-04）：节点编辑器「关联子任务」下方新增「常驻 Skill」
  下拉（候选 = workspace skill 目录 useSkills；不指定 = 不动子会话现有配置）。选中的 skill
  名存进节点 `pinnedSkills`（画布可编辑配置，随保存落库，模型同 autoExecute/绑定：提案值
  优先、缺省保留存量）。派发时（spawn 首条指令前 / sendChildTaskPrompt 冷恢复保障后）
  host 经 v4 `setPinnedSkills` 命令把名单全量写入子会话（与 UI 同一 runtime 写路径，
  catalog name 替换语义）；失败只记日志不阻断派发（skill 是增益不是前置）。
  **UI 侧收敛语义**（bug 修复 2026-11-04，实测"派发注入 workmate 成功，21 秒后打开子会话
  页名单被清成 cleared——时间戳实锤：runtime/pinned_skills entry created=派发时刻、
  updated=打开页面时刻"）：SessionPane 的 draft→runtime 同步 effect 以 composer draft 为
  用户意图 owner，但 **draft.pinnedSkills === undefined（从未表达意图）不得当清除指令**——
  无意图时以 runtime 回声为准，draft 由 useDraftConfigControl 从会话快照 hydrate 补齐
  （composer chip 同步显示 host 注入的名单）；只有用户显式选择/清空（draft.pinnedSkills
  非 undefined）才下发 setPinnedSkills。prewarm 首发前的同步只在非空名单时推送，无此问题。
  **注入预算**（2026-11-04 由 20k 上调至 50k 字符，实测：真实 skill 1.5~3 万字符，20k 必
  降级挂名="生效"假象；50k 下两个真实 skill 同时挂载全文常驻、compact 不丢，约合 1.6~2.2
  万 token/请求）——机制细节与降级语义见 core spec pinned-skills.md。
- **空目标不可执行**（用户需求 2026-11-04）：目标为空的节点，卡片「执行」按钮禁用
  （hover 提示"先填写目标"——提示词会退化成节点名，等于盲发）；host executeOrchestration
  PlanNode 同规则拒绝；「继续执行」与自动引擎的就绪集合排除空目标节点（节点保持 pending，
  填写目标后的下一次触发自然恢复推进）。
- **关联子任务同模型**（用户需求 2026-11-03 改版，实测绑定保存后丢失）：绑定从服务端
      即时通道（bindOrchestrationPlanNodeChild，已删除）迁入画布编辑缓冲——select 修改
      进缓冲（childTaskId/childTitle/childLocked），随「保存计划」经 proposePlan 落库；
      服务端即时绑定不亮保存按钮，且其后的修订保存会把未完成节点的绑定清空
      （revise 旧行为 childTaskId:null 只留 reuse 提示）——两件事叠加 = 绑定必丢。
      迁移后：提案绑定值优先，未携带（agent 提案）沿用存量；执行事实节点
      （dispatched/terminal）绑定不可修改（select 禁用并提示），修订通道冻结保留服务端
      绑定；host 校验不再限制一个子任务挂多个节点（允许多挂，完成时一并置 terminal）；服务端事实补丁不再
      回填绑定字段（与 autoExecute 同理由编辑缓冲所有）。绑定不再回填节点状态
      （旧行为"绑定时已完成子任务直接亮 terminal"删除，用「手动完成」滑块表达）。
    - **解链清绑定**（用户需求 2026-11-04）：用户把子任务与编排主任务取消关联
      （unlinkTask）时，计划里对该子任务的绑定随解链一并清理——遍历全部计划，
      childTaskId 命中的节点清 binding+锁定，`dispatched` 回落 `pending`（脱离统筹的
      子任务终态不再回传，留着 dispatched 会永久卡住「继续执行」；terminal/failed 是
      历史结果保留）。落库后广播计划变更：画布编辑缓冲里未被用户改过的绑定由
      patchServerFacts 按"服务端绑定非空→空 + 缓冲仍等于上次服务端值"的迁移同步清空
      （未保存的绑定编辑不误伤）；关联子任务下拉候选来自 links 权威列表（墓碑过滤），
      重拉后已解链任务不再出现。
    - 总控全关不取消在途：已派发节点的子任务继续跑完（终态照常回传置 terminal），只是不再有新的
      自动派发。
  - 执行中可辨识：dispatched 节点统一蓝色边框/底色 + 旋转图标，不区分是 agent 派发还是手动点的执行；
    侧栏计划图标只在有 dispatched 节点时转圈，confirmed 但无执行中节点显示静态"待执行"图标
    （此前 confirmed 一律转圈，节点卡住时看起来"一直执行中"）。
- 计划级执行按钮（用户需求 2026-11-02）：计划页工具栏新增"执行计划/继续执行"——计划已确认且
  有待执行节点时出现；有节点 terminal（部分执行）→ 文案"继续执行"，未执行 → "执行计划"。
  语义 = 批量派发**当前可执行**的非起始节点（pending/stale 且所有依赖已 terminal；已完成节点
  绝不重跑），单节点派发与手动执行同一通道（组提示词/绑定子任务下发/派生）；有 dispatched 节点 →
  禁用（提示等执行中节点完成），无可立即执行节点 → 禁用（提示上游未完成）。链式计划每完成一批
  可再点继续。
- 卡片尺寸与自动布局（用户反馈 2026-11-02"太挤"）：无保存宽度的节点默认 200px（手动缩小
  仍可到 104，两个常量分开——"调大后要能调回来"只约束下限）；执行行/手动完成行 nowrap 不折行。
  自动布局步长横向 320 / 纵向 176（卡片变高后 140 会互相挤）。已保存过坐标的计划不受影响
  （用户拖过/存过的 layout 照旧）。
- 确认消息瘦身（用户需求 2026-11-02）：【编排计划·确认】只注入确认行 + 节点清单（含节点 id）+（有则）微调重执行行；执行规则 / 多计划契约 / 变更传播 /「开始」节点约定不再随每次确认刷屏，
  改为 CLI 计划模式常驻引导（dynamic-sections，planMode 下每轮都在上下文），语义不变。
- 计划设计请求 = 提案触发器（用户需求 2026-11-02）：用户明确要求"设计/出/制定一个开发或执行
  计划"（哪怕假设句式"假如来一个新需求"）必须走 ProposeOrchestrationPlan（新需求 createNew、
  调整现有计划走修订），让用户在计划画布上拿到可确认的计划；只答文字计划属于违规则——此前
  路由引导把 "planning" 列为可 inline 直答，agent 按引导输出了一篇文字计划书（用户实测）。
  「当前计划/进度的提问」仍 inline 直答。改引导后须重启该编排会话的 runtime 才生效。

