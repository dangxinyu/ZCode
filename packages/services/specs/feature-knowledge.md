# 功能点知识库（Feature Knowledge Base）

状态所有者与数据模型见本 spec；UI 落点引用 `packages/ui`，CLI 工具面引用 `apps/zcode-cli`，对外 MCP 引用 `apps/zcode-cli/packages/feature-knowledge-mcp`（新建）。

立项背景（用户需求 2026-11-24）：需求/bug/评审产出的文档散落各处、不成体系，下次做关联需求或改 bug 时搜不到、不知道怎么找。根因是现有积累方式全是 append-only（每次新增一篇），同一功能点攒出一堆重复废话。本功能改为**功能点中心的活文档**：文档数量恒等于功能点数量，每次写入是「合并 + 重构 + 压缩」而非追加，质量单调上升。

## 行为定义

- **功能点（feature）是实体**：名称 + 别名 + 业务域 + 代码锚点（repo + 路径 + 符号）。每个功能点挂**一份活文档**，固定结构：需求背景 / 业务规则 / 代码位置 / 关键修改决策（含 why）/ 坑与注意 / 关联功能点。
- **三层模型（用户确认 2026-11-25；2026-11-26 澄清：结构必须保持，但允许新开分类、不强制套用现成）**：大模块（domain，如供应链/模型与供应商）→ 功能分类（part_of 父文档，如以销定采操作台/直运）→ 具体文档；**每篇文档必须同时挂大模块与功能分类上级，三层缺一不可**（父不存在先建骨架）。大模块/功能分类按归属选现成的，确属新模块/新功能分类时按需新建；只禁止造重复层级——购销本就属供应链，domain 直接写供应链，不拉「供应链/购销」子域、不把购销单列大类。列表按大模块分组、组内 part_of 树渲染，父可折叠。**归属按功能实体而非触发需求**（用户确认 2026-11-26：经营流水是自身功能点，发票确认收入只是切入它的一个面；不得把功能挂到需求/任务文档下，跨需求的功能知识合并进该功能自己的活文档）。**源文档≠功能点 / merge-first**（用户确认 2026-11-26：分析目录时曾一份源文档新建一个文档，未合并）：同一实体的多份源文档必须合并进该实体的一份活文档，禁止一份源文档新建一个功能点；新建前换多种措辞 SearchFeatures 确认确无现有实体；侦察主题计划优先把文档映射到已有 featureId。**不留空分类**（用户确认 2026-11-26）：分类父必须挂子文档；无子的根不留——降为普通文档挂分类下，或知识合并进相关功能后删除（先例：发票确认收入总控知识合并进经营流水分类活文档后删除）。
- **层级（part_of，用户确认 2026-11-25：文档太碎，要大分类下挂小分类）**：relations 增加 `part_of` kind（migration 0003 重建 CHECK）；子功能点 `parentFeatureId` 投影进 FeatureSummary；列表按域内父→子树形渲染，详情显示「所属父文档 / 子主题」跳转。提炼归属规则：能并入父文档章节就并入父，独立可检索子主题才建子功能点挂 part_of。**按名挂父（parentName，用户确认 2026-11-26 修「同批新父+新子链接不上→两级」缺口）**：新分类父本身是待确认提案、提交前无 id，子提案 relations.toId 挂不上；故 ProposeFeatureUpdate 增可选 `parentName`（协议 proposedParentName，migration 0004 加 `proposed_parent_name` 列），commit 时同域按名找父、缺则建骨架（`insertCategorySkeletonSync` 与 createFeatureCategory 共用）再挂 part_of（替换旧 part_of 保单父，含自环/成环校验）。**手动层级管理**（存量重构）：详情「层级」区可选父文档 / 新建父文档骨架（`setFeatureParent` 含自环/成环校验、`createFeatureCategory` 空固定结构骨架+v1），**父候选只列分类（有子文档的父节点），不列叶子知识文件**（用户确认 2026-11-26）；元数据变更不走提案闸；设置后刷新详情。
- **merge-on-write（段落级重写）**：写入不追加段落。agent 提炼候选事实后，读取旧文档，**只重写与本次工作相关的章节/段落**（相关章节内去重、压缩、重组），**无关章节逐字保留**（措辞与顺序都不动），使确认 diff 只呈现相关 hunk（用户确认 2026-11-25：段落级重写更契合 git diff 样式）。经人确认后提交为新版本。旧版本进版本账本可回溯，检索与阅读只认最新版。代价：放弃跨章节全局压缩，无关章节的冗余/过时内容只进 change_summary 提醒、留待专项整理（v2）。
- **保真字段**：重写契约规定「代码路径、关键决策依据（why）、坑与注意」不可丢失；可淘汰的只有**相关章节内**的重复表述与过时细节，无关章节逐字保留本身即保真。文档目标有界（约 300 行以内，agent 判断，非硬截断）。丢信息风险由版本快照兜底（可回滚）。
- **知识 vs 过程边界（用户确认 2026-11-26：实现过程/错的不进知识库）**：只沉淀**持久功能知识**（业务规则/口径/行为、代码锚点、可复用坑与决策 why）；**不收实现过程与任务状态**——本次改哪/不改哪（红线不动）、实施顺序、提交/搁置状态、sql 脚本与 md5/版本基线、执行与回退、验证清单、挂人拍板/分工、待确认项。事实须与实际核对（选项 key、实体/BO 编号、口径结论），过时/矛盾/未验证不写入；方案稿与已落地事实冲突以事实为准。提炼指令（会话/主题/文档三路）均携带此边界。**二次强调（2026-11-26：首版规则与「保真/无关章节逐字保留」冲突，模型把源排查稿步骤搬进坑章节）**：源排查/实施稿只提炼根因/口径/锚点/可复用坑，禁止搬排查步骤/验证/打包/未决/挂人；「坑与注意」只放可复用陷阱；过程不属于保真字段，逐字保留不覆盖过程段、须剔除。
- **手动提炼触发**（用户确认 2026-11-24：任务完成但功能不理想时不能提炼，故不做自动提炼；2026-11-25 三次确认：提炼必须是**当前会话的内联子智能体**，不脱离当前会话、不另开 session）：入口在 **workspace 头部右上角图标行**（`WorkspaceHeaderActionSection`，刷新按钮左侧），图标按钮（`BookPlus`，与知识库入口同族）+ tooltip，**不用文字标签**。
- **知识库入口与开页方式**（用户指定 2026-11-25：入口在**侧栏顶部导航「插件市场」下方**，与自动化/插件市场同排的主区视图导航项，`BookOpen` + 短标签 + pending 角标；不放 footer、不放视图 tab 行）；点击后知识库在**右侧主区开页**（`WorkspaceShellLayout` 主区分支，先例 automations/plugin-store），**侧栏任务列表保留、不被覆盖**；不再走整窗 overlay。无 workspace 时仍为根级整页（Root 分支）。**主区视图互斥**：知识库（tabStore）与自动化/插件市场（workspaceMainView）同一时刻只有一个生效——进自动化/插件市场（含重复点击入口）先 `closeTab(KNOWLEDGE_TAB_ID)`，KB 激活时另两个导航不高亮（2026-11-25 双高亮/点击无反应 bug 修复）。
- **分析现有文档入口**（用户确认 2026-11-25：KB 页头部「分析现有文档」）：填文档路径**或目录**（每行一个）→ host `scanFeatureDocs` 展开（递归 md/markdown/txt，跳过 node_modules/dist/.git 等，展开上限 200 并明示 truncated）+ 只读标题/开头行 + 词面候选归属。**≤20 份**直接 `buildFeatureDistillDocInstruction` 派内联子智能体 Read→按功能点归组判归属（一份文档可跨多功能点拆分；**同功能点的多份文档聚合成一条提案**：一个功能点读一次底稿、只提一条，避免多条基于同一旧版本互相冲突返工，用户确认 2026-11-26）→段落级合并→ProposeFeatureUpdate。**>20 份主题驱动**（用户确认 2026-11-25：不是一个文件一个会话，先读个大概再按相同主题派发；知识有交集→多对多）：① dialog 勾选文档范围；② `buildFeatureDocScoutInstruction` 派侦察子智能体读大概、按主题聚类（文档↔主题↔功能点多对多），经 Write 落盘 `<workspace>/.zcode/doc-themes-plan.json`（不提案）；③ KB 页轮询 `readDocThemePlan`（host 读+形状校验）落盘即**自动**经 `buildFeatureDistillThemeInstruction` 按全部主题派提炼子智能体（全自动、无主题人闸；自动失败/未派发留 waiting 由「分析中」行手动派发兜底）；④ 每主题对涉及的每个功能点各提一条提案，同功能点多主题串行+baseVersion 冲突闸。复用确认人闸/部分接受/归属纠正；只读文档与知识库、不改文档原文；三个内置工具限定同会话提炼。承载会话 = **专用工作区 `~/zcode-kb` 下新建的普通会话**（用户指定 2026-11-25：根目录 zcode-kb 文件夹作为分析文档工作区，没有就创建，session 建在这里；host `ensureDocAnalysisWorkspace` mkdir recursive）；一个正常 session 派多个内联子智能体，**不接编排**；会话权限=完全访问（yolo，用户指定 2026-11-25：分析会话不再逐工具确认）。链路：ensure 目录 → `createTask`（同步索引+落库，不用 defer）→ `onJumpToSession` 跳转挂载 pane（KB 开页时 chat pane 卸载、把手不存在）→ 把手发送（等 composer 配置就绪、disabled 不拦 sendInstruction）→ `readSession` 落库校验（messages>0 / projection.lastError，防坏模型静默丢指令）。「分析中」tab 承担可见性与跳转。单会话「提炼」仍走当前会话内联子智能体，不受影响。
  - **可见性**（用户反馈 2026-11-24：未开始的会话不该有提炼）：仅当当前会话**已有对话内容**（`rows.totalCount > 0`）且非只读时显示；草稿/空会话隐藏。composer 禁用态（connecting/rebuilding/queueEdit/quota）下按钮 disabled。
  - **当前会话发指令 + 内联子智能体（唯一动作所有者 `SessionPane.handleDistill`）**：运行时没有 host/UI 直接派生内联子智能体的协议方法（内联子智能体唯一 launch 入口是模型 Agent 工具 `core/tool/handlers/agent.ts`；`session/steer` 已删除，仅 `session/subagents` 查询），故点击经 `handleSendText` 向**当前会话**提交一条派发指令：主 agent 用 Agent 工具派 `run_in_background` 子智能体执行提炼、派完简短告知即结束回合。子智能体是当前会话的 child，渲染为内联「子智能体」块并进会话子智能体目录，**不产生侧栏新 session**。指令内嵌完整提炼规则，并要求主 agent 把本次会话工作要点写进子智能体 prompt（主 agent 持有当前上下文，UI 不搬运转录）。focused SessionPane 把 `{ disabled, requestDistill }` 注册进 UI store（`featureKnowledgeDistillStore`，按 sessionId）；头部按 `activeSessionId` 读取并哑渲染按钮，**不在 header 另起动作路径**。键盘可达。发送成功 toast 提示，失败/被拒 toast 报错；busy 会话按 `CommandInbox` 排队 admission。
- 提炼指令引导**子智能体**：`SearchFeatures` 找已有功能点 → `ReadFeatureDoc` 读旧文档 → 判定实体归属（合并到已有 / 新建）→ 按段落级重写契约产出完整新文档（只改相关章节、无关章节逐字保留）→ `ProposeFeatureUpdate` 提交提案。**重写由子智能体完成**（prompt 携带主 agent 整理的本次工作要点），host 不调 LLM。提案落库后仍由确认 dialog 人闸（与其他来源一致）。
  - **工具面继承**：子 runtime 必须继承 `featureKnowledgePort`（core/runtime/methods/subagent.ts），否则注册门 `includeFeatureKnowledge` 判 false、子智能体看不到三个工具而转用其他 skill 的文件型知识库（2026-11-25 跑偏根因）。
  - **指令边界**：只总结当前会话、只对比 ZCode 内置知识库；读写只用三个内置工具，禁止 wm-search / references/feature / 其他 skill 索引 / 会话外文档替代；工具不可用时报告失败停止，不自行交付文本提案。
- **提案-确认闸门**：提案落 `feature_proposals`（pending），UI 弹合并确认 dialog（旧/新文档 **git 式 unified diff**：`diffIndicators=classic` 的 +/- 行标记 + 词级高亮 + hunk 行号，用户确认 2026-11-25「git 式 diff」；变更摘要 + 实体归属明示「合并到 X / 新建」）。人确认 → host 事务提交新版本；拒绝 → 提案置 rejected 墓碑（不物理删除）。确认前功能点状态零变化。
  - **章节级部分接受**（用户确认 2026-11-25「想接收一部分拒绝一部分」）：dialog 列出有改动的章节勾选框（默认全接受），diff 展示**将要提交的内容**（旧文档为底 + 勾选章节，`mergeFeatureDocSections`，shared 无损分块工具）；确认时 `commitProposal(id, acceptedSections)` 由 host 合并提交，未勾选章节保持原文；全选时与整份提交字节一致；一个都不勾禁用确认。新建提案（无底稿）不显示勾选。行级（git add -p）挑选不做：补丁应用与冲突裁决复杂度/写坏风险过高。
  - **批量确认**（用户确认 2026-11-26「待确认有时根本不想看，加批量确认」）：待确认段「批量确认（N）」按钮（`useBatchConfirmProposals`），整份接受顺序提交全部 pending；同功能点后续提案因 baseVersion 冲突**跳过并保留 pending**（不静默丢），结束 toast 汇报 已合并/冲突跳过/失败 计数；busy 期间禁用防重入。逐条 diff 人闸仍保留，批量是显式免逐条审查的快捷路径。
  - **归属纠正**（用户确认 2026-11-25：投错功能点时不能只靠拒绝重跑）：dialog 第三动作「归属不对」→ 选择正确功能点（或新建）→ 先拒绝旧提案留墓碑 → 向**来源会话**发纠正指令（`buildFeatureDistillCorrectionInstruction`：指定 featureId/新建 + 完整提炼契约），经 `featureKnowledgeDistillStore.sendInstruction` 复用 pane 唯一发送路径派内联子智能体基于正确底稿重新合并重提；来源会话 pane 未聚焦时先 `activateTab` 并 bounded 2s 等把手登记，超时 toast 提示手动重试。**不允许只换提案目标 id**（旧正文按错误底稿重写，必须重新合并）。外部 MCP 来源无会话 → 明示无法自动纠正。选择器打开期间 Enter 不确认、Esc 只关选择器（`onEscapeKeyDown` 接管 Radix dismiss）。
  - **来源归因**：propose 工具在内联子智能体里调用，`source.sessionId` 是 child session；纠正发送用当前会话的子智能体目录（`listSessionSubagents.childSessionIds`）把 child 反查回父会话，否则落空。
- **不自动弹确认框**（用户确认 2026-11-26：自动弹框会重复弹/确认后还弹已处理，「不要弹框，放待确认我自己点」）：提案一律落「待确认」列表 + 侧栏 pending 角标，用户自行点开单条确认或批量确认；移除 SessionProposalWatcher 自动弹窗。
- **末级文档右键菜单（删除 / 订正，用户需求 2026-11-26）**：列表里**仅末级文档**（无子文档的叶子 feature）行有右键菜单（`ContextMenu` 原语，先例任务列表右键），两项：
  - **删除**：二次确认 Dialog（明示名称与不可恢复）→ host `deleteFeature(id)` 库级事务删除 features / feature_versions / feature_relations（from 或 to）/ features_fts / feature_embeddings → bump 广播 → 列表刷新。**有子文档的父节点不显示菜单**（先移走/删子再删父）；repo 侧同样拒绝删父（稳定错误码），UI 门禁不是唯一防线。提案队列 append-only 不随删（指向已删功能点的 pending 提案提交时按 featureNotFound 拒绝，既有失败语义）。删除与 commit/reject 同属 **UI 人闸**，只走 `IFeatureKnowledgeService` 服务面（ProxyChannel），**不进 CLI 反向协议**（与 setFeatureParent/createFeatureCategory 同范式）。
  - **订正**：开一个**新 session** 自动代入修复上下文（文档当前全文 + 名称 + 域/别名/锚点 + 版本），上下文**不在输入框显示为文字**，只在 composer 上方显示 chip「订正 · {文档名}」（可移除）。用户对话描述要改什么，agent 结合隐藏上下文按段落级重写契约修复并走 ProposeFeatureUpdate → 提案人闸。**不自动发送任何指令**，等用户输入。链路：`readFeature` 读全文 → `ensureDocAnalysisWorkspace`（~/zcode-kb）→ `createTask`（mode=yolo、**不 deferred**——订正不立即发首条指令，会话立即落库 renameTask 的 v4 renameSession 才有落点，否则 pane/侧栏仍 New session；默认健康 GLM-5.4 + reasoningLevel low）→ `renameTask` 命名「订正 · {文档名}」（不叫 New session，用户反馈 2026-11-26）→ 把 featureCorrection context 写入该 session 的 composer scope store → `onJumpToSession` 跳转。隐藏上下文复用 composer「尾块 + chip」范式（第五类 context `featureCorrection`，JSON 尾块无损序列化/解析，历史 user row 剥离不显示）；per-scope store 是唯一所有者（`featureCorrectionContextStore`，key=workspaceKey+scopeId），composer 经 hook 读取、发送成功后清除，跳转前写入不依赖 pane 挂载时序。
- **知识库页面**：全局单例 tab（先例 `openSettingsTab`），侧栏 Footer 新增入口（设置按钮旁）。内容：功能点列表（按业务域分组）+ 搜索框 + 活文档阅读 + 版本历史（只读）+ 关联功能点跳转 + 「待确认」提案区 + **「分析中」目录**（用户确认 2026-11-25：必须明确知道哪个 session 在工作并可点击跳转）。不做关系图可视化（v2）。
  - **分析中 / 分析完成目录**（用户确认 2026-11-25 加「分析完成」tab；2026-11-26 修正完成判定）：派发时登记（`featureKnowledgeAnalysisStore`：会话提炼 / 文档分析会话，含 sessionId/workspace/批次数）；页级 5s 轮询定状态：**主 task 终态（listTasks completed/error）且 `listSessionSubagents` running 清空（全部子智能体结束）才进「分析完成」**；主 task 仍在跑或 running>0 → 「分析中」。主 agent 派完子智能体即结束回合（主 task completed）但分类子智能体仍在跑时**不算完成**（用户确认 2026-11-26：全部完成才算分析完成）；子智能体读取失败不降级为 done。runtime 空闲释放后 running=[] 即全部结束。**done 仍参与轮询复查**（用户反馈 2026-11-26：还有子智能体在跑却进分析完成）：批次间隙 running=0 误判的 done，在后续子智能体 spawn（running>0）时拉回 running；读不到 meta 的 unknown 不把 done 降级。**分阶段**（用户确认 2026-11-26：侦察/分类只是第一阶段，不得侦察一结束就进分析完成）：侦察会话第一阶段完成且第二阶段（主题派发）未派发时置 `waiting`（分类完成·待派发）留在「分析中」，行内「手动派发第二阶段」读计划直接派发兜底；主题派发后立即置 running 防间隙误判；全部主题子智能体结束才 done。**全自动 + 手动兜底（用户确认 2026-11-26：除提案确认外全自动；自动失败/未派发要有手动入口）**：无开关、无主题勾选人闸；KB 页轮询到主题计划落盘即经共用 `dispatchDocThemes` 按全部主题自动派发并 reset；自动失败不 reset、entry 留 waiting 并 toast 一次，「分析中」waiting 行「手动派发第二阶段」读计划直接派发兜底。提案确认仍人闸（diff/部分接受/批量确认）。**派发回执校验（防口头交付，用户反馈 2026-11-26：主 agent 声称派了子智能体实际没调 Agent 工具）**：发送 ack/主回合结束都不算派发；`verifySubagentSpawned` 轮询子智能体目录（childSessionIds/running/ended 任一非空）确认真 spawn，30s 未 spawn 重发一次指令再校验，仍无则报失败不登记 entry（主题派发抛错交自动/手动兜底）；指令同时硬话「必须实际调用 Agent 工具、禁止口头声称已派发」。「分析完成」行带提案结果角标（待确认/已合并/已拒绝，按 source.sessionId 归集）；点击行经 `handleSelectTaskInChat` 跳转该会话；可移出列表。登记经 sessionStorage 跨重载保留；live 状态轮询刷新；提案事实以 host 库为准（待确认始终可见）。
- **检索分层（核心需求 2026-11-24「无论我怎么说都要能找得到」）**：纯词面倒排只认字面，文档写「库存成本核算」、用户搜「存货计价」就漏，故采用三层并联召回，任一命中即可，融合排序：
  - **① 词面倒排层**：FTS5（trigram，中文子串友好）全文 + 别名精确 + 代码锚点前缀匹配。这是倒排索引本体，保证精确词/代码路径命中。代码路径反查是一等检索方式（改 bug 时手里有文件路径，比文字更强）。
  - **② 词汇桥层**：提炼时 agent **必须**为功能点沉淀别名（业务黑话/同义词/英文/缩写/口语叫法），把「用户可能怎么说」前置写进索引；查询时做扩展——agent 工具侧由 agent 把口语翻成多组检索词多次召回，UI 搜索框经 host `generateWorkspaceText` 一次性扩展同义词（现成通道，无新 infra）。此层始终在线，是「换个说法」的主兜底。
  - **③ 语义向量层**：embedding 召回。提交时异步对文档分块 embed 落库，检索时 embed query 取 cosine top-k，与词面层 RRF 融合。embedding 经一次性模型通道（复用 provider runtime 鉴权/base，OpenAI-compatible `/embeddings`）。embedding 引用作为**知识库设置项**（`AppSettings.featureKnowledgeEmbedding`：providerId + embedding modelId + workspacePath，用户确认 2026-11-24），不改 provider 包 schema；modelId 直传 `/embeddings`（不必是注册 chat 模型）。**未配置时降级到 ①② 并在 UI 明示「语义召回未启用」**，不静默假装满足。
  - 召回保证口径：①② 始终在线覆盖大部分换说法场景，③ 兜底加强词汇无关召回；三层并联 + 锚点加权，最大化「无论怎么说都找得到」。
- **对外 MCP**（用户确认 2026-11-24：ZCode 内置可视化 + 向外提供 MCP）：独立 stdio MCP server 进程，读操作直读 SQLite（ro），写操作仅插入提案（append-only）。**提交/拒绝只在 ZCode UI**（人闸），外部工具经 `get_proposal_status` 轮询结果。ZCode 未运行时外部仍可读、可提案。
- 开工自动注入相关功能点、存量散落文档批量导入、功能点拆合 UI、agent 侧提案结果通知：均为 v2，本期不做。**例外（用户确认 2026-11-25「1+2」）：开工自动召回已落地**——每轮用户输入提交时（turn.ts，`inputVisibility!=model-only`）以本轮问题经 `featureKnowledgePort.searchFeatures` 检索，top-3 摘要+代码锚点+命中层作为当轮 system reminder（source `feature_knowledge_recall`，per_current_turn）注入；全文不注入、按需 ReadFeatureDoc；子代理/工作流 actor、空输入、slash 命令不召回；检索失败不阻断对话。配合常设指令（SearchFeatures description/modelInstructions：分析需求/bug/评审前先检索）兜底自动召回未命中时的主动搜索。

## 状态所有者

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 功能点状态（features / versions / relations） | host `featureKnowledgeService` 提交事务 | 唯一写入者；MCP 与 CLI 均不直接改 |
| 活文档当前版 | `features.doc_md`（投影） | 单一真相在 `feature_versions` 最新行；投影供读侧与 FTS 加速，提交事务内同步 |
| 提案队列 | `feature_proposals` 表 | append-only 队列：host（CLI 反向 RPC）与 MCP server 均可插入；状态迁移（pending→committed/rejected）仅 host |
| 版本账本 | `feature_versions` 表 | append-only，不更新不删除；回滚 = 以旧版内容提交新版本（v2 UI，本期可手工） |
| 检索索引 | FTS5 虚表 | features 投影的派生，提交事务内重建该行 |
| 语义向量 | `feature_embeddings` 表 | 文档分块 embedding 的派生，host 提交后异步写入；embed 失败不阻塞提交，标记待重试 |
| 提案确认 UI 态 | renderer 局部状态 | dialog 开关/选中提案；事实以 host 广播为准 |

## 数据模型（独立全局库）

路径 `~/.zcode/v2/feature-knowledge.sqlite`（跨平台经 `os.homedir()` + `path.join` 解析，先例 `packages/services/src/paths.ts`）。**独立文件，不进 tasks-index**：避免与安装版共用 `~/.zcode` 的 migration 编号冲突（0006 事故先例），且知识库天然跨 workspace 全局积累。WAL + busy_timeout 支持多进程共读。自有 migration 账本从 0001 起。

- `features`：`id`（uuid PK）、`name`、`aliases_json`、`domain`、`anchors_json`（[{repo, paths[], symbols[]}]）、`doc_md`（当前版投影）、`current_version`、`created_at`、`updated_at`。
- `feature_versions`：`feature_id` + `version`（PK）、`doc_md`、`change_summary`、`source_json`（sessionId/taskId/workspaceKey/traceId）、`created_at`。
- `feature_relations`：`from_id` + `to_id` + `kind`（relates | depends | affects，PK）；无向语义读侧双向展开。
- `feature_proposals`：`id`（uuid PK）、`feature_id`（可空 = 新建）、`proposed_name`、`proposed_aliases_json`、`proposed_domain`、`proposed_anchors_json`、`proposed_relations_json`、`doc_md`、`change_summary`、`source_json`、`status`（pending | committed | rejected）、`created_at`、`resolved_at`。
- `features_fts`：FTS5 trigram 虚表（name + aliases + doc_md），features 投影派生。
- `feature_embeddings`：`feature_id` + `chunk_idx`（PK）、`chunk_text`、`vector`（blob）、`model`、`created_at`；当前版提交后异步重建该功能点全部分块。corpus 小，cosine 在 JS 内算即可，不引向量库。

## 接口

### host 服务（UI 消费）

新增 `IFeatureKnowledgeService`（`packages/services/src/feature-knowledge/`），`node.ts` 注册 + `ServiceChannels.FeatureKnowledge` 常量，host `host/index.ts` 与 server `http.ts` 按 ZCodeTask 同款暴露（ProxyChannel 自动代理，**无新 preload**）。方法族：

- `listFeatures(domain?)` / `searchFeatures(query)`（三层并联召回 + RRF 融合 + 锚点加权，返回命中来源层）/ `readFeature(id)`（含版本历史与关联）
- `listProposals(status?)` / `commitProposal(id)` / `rejectProposal(id)`
- `deleteFeature(id)`（末级文档删除，UI 人闸 + 二次确认；库级事务，拒绝删有子文档的父）
- 事件：`onDynamicFeatureKnowledgeChanged`（bump 串号广播，先例编排 planSync；reason 含 `deleted`）。

### v1 协议（CLI 反向 RPC，`packages/shared/src/zcode-protocol/index.ts`）

新增方法（模板：`orchestration/spawnSubTask`）：`featureKnowledge/search`、`featureKnowledge/read`、`featureKnowledge/propose`。zod params/result schema + `zcodeProtocolMethods` 登记 + host `zcodeAgentService` if 分支（safeParse → resolver → respond）。commit/reject 仅 UI 服务面，不进 CLI 协议。

### embedding 一次性通道（host → CLI，复用 provider runtime）

先例 `generateWorkspaceText`（`zcodeAgentService.ts:4754` → 正向一次性模型请求，不建会话）。新增 `workspace/embedText` 一次性请求：入参 texts[] + selection（providerId + embedding modelId），出参 vectors[] + model；CLI 侧 facade 经 provider registry 取 provider 的 baseUrl/apiKey/headers，调 adapters `requestProviderEmbeddings`（OpenAI-compatible `/embeddings`，复用 `createNetworkProxyFetch` 代理/CA）。embedding 引用读知识库设置项 `AppSettings.featureKnowledgeEmbedding`（providerId/modelId/workspacePath）；未配置 → host embedder 返回 null，服务层跳过向量层并标注 `semanticEnabled=false`。account 动态鉴权 provider 暂不支持 embedding（抛错降级）。网络 I/O 收敛在 CLI adapter，host 不直接 fetch。

### CLI agent 工具（所有会话可用，端口在场即启用）

| 工具 | 副作用 | 只读 | 幂等 | 说明 |
| --- | --- | --- | --- | --- |
| `SearchFeatures` | none | 是 | 是 | query（关键词/路径）→ 候选列表（id/name/domain/摘要/锚点命中），有界输出 |
| `ReadFeatureDoc` | none | 是 | 是 | id → 完整活文档 + 关联 + 版本摘要 |
| `ProposeFeatureUpdate` | knowledge-proposal | 否 | 否（每次新提案行） | featureId（可空=新建）+ 完整新 doc_md + change_summary + 锚点/别名/关系增量 → 提案 id + pending |

工具契约按 CLI 规范声明 inputSchema/outputSchema/超时/取消/最大输出；注册链：contracts/tools + interfaces port → core handlers 薄透传 + ToolEntry → handlers/index + include 门 → bootstrap `feature-knowledge-port.ts`（requestClient 反向 RPC）→ server-operations 注入 → call-runner 透传。traceId 全程携带，提案 source_json 记录。

### 对外 MCP server（新包 `apps/zcode-cli/packages/feature-knowledge-mcp`）

TS stdio 进程（`@modelcontextprotocol/server` + `serveStdio`，先例 node-repl-host）。工具：`search_features`、`read_feature`、`propose_feature_update`、`get_proposal_status`。读 = sqlite ro 直读；提案 = append-only 插入；**不暴露 commit/reject**。注册形式先例 qoder-repowiki：`~/.zcode/cli/config.json` mcp.servers 加 stdio 项（command/args 指向构建产物），Qoder 侧同款配置。DB 路径解析跨平台；连接失败/库不存在 → 明确错误（不静默建空库误导）。

#### 构建与注册

构建：`pnpm --filter @zcode/feature-knowledge-mcp build` → 产物 `apps/zcode-cli/packages/feature-knowledge-mcp/dist/mcp/server.js`（esbuild 单文件 bundle，banner 注入 `createRequire` 以加载 `node:sqlite`）。

注册（`~/.zcode/cli/config.json` 的 `mcp.servers` 加一项；Qoder 侧 MCP 配置同款）：

```jsonc
{
  "mcp": {
    "servers": {
      "feature-knowledge": {
        "type": "stdio",
        "command": "node",
        "args": ["/绝对路径/ZCode/apps/zcode-cli/packages/feature-knowledge-mcp/dist/mcp/server.js"]
      }
    }
  }
}
```

- `protocolVersion` 省略即可：CLI adapter 默认 `auto` 协商，本 server 仅接受 modern era `2026-07-28`（`legacy: "reject"`），auto 会协商到 modern；显式 pin 可写 `"2026-07-28"`。
- DB 路径由 `paths.ts` 统一解析（默认 `~/.zcode/v2/feature-knowledge.sqlite`），生产不新增环境变量；测试经 `ZCODE_DATA_BASE_DIR` 指向临时库。库不存在 → `notReady` 明确错误，不建空库。
- 四工具均只读或仅插入 pending 提案；**commit/reject 不在 MCP 面**，人闸只在 ZCode UI。外部经 `get_proposal_status` 轮询 committed/rejected。
- 检索返回 `semanticEnabled: false`（MCP 进程不做 query embedding，降级到词面/别名/锚点三层），不静默假装语义召回。

## 事件顺序

```text
提炼：用户点「提炼」→ handleSendText(提炼指令) → CLI CommandInbox 串行 admission
  → agent SearchFeatures / ReadFeatureDoc（反向 RPC host 读库）
  → agent 段落级重写（只改相关章节，无关章节逐字保留）→ ProposeFeatureUpdate
  → 反向 RPC host:featureKnowledge/propose → zod 校验 + 实体校验 → INSERT 提案(pending)
  → 广播 → 待确认列表 + pending 角标（不自动弹框，用户自行点开/批量确认）

确认：人点确认 → IFeatureKnowledgeService.commitProposal
  → 事务：INSERT feature_versions(version+1) → UPDATE features 投影(文档/锚点/别名/域)
    → upsert relations → 重建 FTS 行 → 提案置 committed
  → 广播 bump → 知识库页/角标刷新
  → 异步：分块 → workspace/embedText → 重建 feature_embeddings（失败标记待重试，不阻塞）

拒绝：rejectProposal → 提案置 rejected（墓碑）→ 广播

删除：末级行右键「删除」→ Dialog 二次确认 → IFeatureKnowledgeService.deleteFeature
  → 事务：校验存在且无子（part_of 指向它）→ DELETE features/feature_versions/
    feature_relations(from或to)/features_fts/feature_embeddings
  → 广播 bump(reason=deleted) → 列表/详情刷新（选中项被删则清详情）

订正：末级行右键「订正」→ readFeature 全文 → ensureDocAnalysisWorkspace(~/zcode-kb)
  → createTask(yolo, deferPersistenceUntilFirstPrompt, GLM-5.4+low 默认)
  → featureCorrectionContextStore.set(scope=workspaceKey+sessionId, 隐藏上下文)
  → onJumpToSession 跳转 → composer 挂载读 store → chip「订正 · {name}」（不自动发送）
  → 用户输入发送 → serializeComposerPromptContexts 追加 JSON 尾块 → ACK 后清 scope
  → agent 结合隐藏上下文修复 → ProposeFeatureUpdate → 提案人闸（同提炼）
  历史 user row：parseComposerPromptContexts 先剥 featureCorrection 尾块，正文不显示上下文

外部：Qoder agent → MCP search_features/read_feature（ro 直读）
  → propose_feature_update（INSERT 提案）→ ZCode 侧角标/toast → 人确认同上
  → MCP get_proposal_status 轮询 committed/rejected
```

## 不变量与失败语义

- 单一写入者：features/versions/relations 只由 host 提交事务写；提案队列 append-only 多生产者插入安全（WAL + busy_timeout + BEGIN IMMEDIATE）。
- 幂等：commitProposal 对已 resolved 提案拒绝（稳定错误码）；版本单调递增，事务失败整体回滚无半态。
- 实体校验：propose 带 featureId 必须存在且未删除；新建必须带 name；锚点/关系引用的目标功能点必须存在（关系悬空拒绝）。
- 删除边界：`deleteFeature` 仅末级（无 part_of 子文档）；事务失败整体回滚；删除不物理清提案队列（append-only 墓碑语义不变）。订正隐藏上下文只经 composer 尾块进入 prompt，输入框/历史正文零显示；chip 移除即放弃上下文；发送成功只清本次冻结 scope。
- 确认前零副作用：提案 pending 期间功能点状态、检索结果不变。
- 并发提案：同一功能点可有多条 pending；确认时以**提交时刻**的最新版为 base 做 diff 展示，若 base 已变（他人先提交）→ 提示冲突，要求基于新版重提（不自动合并，人闸）。
- MCP 进程与 host 并发：读不阻塞写（WAL）；提案插入 busy 重试有界；host 未运行不影响读与提案。
- 检索降级：embedding 未配置/调用失败/向量缺失 → 自动退到词面+词汇桥层，结果标注命中层，UI 明示语义召回状态；**不得静默返回空假装无命中**。embed 异步失败标记待重试，下次提交或启动补 embed。
- 普通任务零回归：不改动既有任务/编排/协议字段；新协议方法与新服务全部 additive。
- 跨平台：路径经标准库解析；MCP server 与 host 在 Windows/macOS/Linux 同行为；不新增环境变量（DB 路径走 paths.ts 统一解析）。

## 迁移边界

- 独立库自有账本 0001：建全部表 + FTS。tasks-index 不动（当前最大 0010，不占用）。
- 协议 additive optional；既有会话/任务/编排行为不变。
- 回滚策略：库文件独立，删除即完全回滚；版本账本 append-only 支持内容级回滚（以旧版提交新版）。

## 验收场景

1. 会话中点「提炼」→ 注入提炼指令 → agent 检索/读旧/重写/提案 → 提案落「待确认」（不自动弹框），用户点开 diff 正确展示旧/新文档与实体归属，或批量确认。
2. 确认 → 知识库页该功能点文档为新版、版本历史 +1、关联/锚点/别名更新、搜索可命中新内容；拒绝 → 功能点无任何变化，提案留墓碑。
3. 同一功能点二次提炼 → 提案 diff 的 base 是最新版；段落级重写使 diff 只含相关章节 hunk、无关章节逐字不变，保真字段（代码路径/决策 why/坑）不丢。
4. 新建功能点提案 → 确认后出现在列表对应域；搜索按名称/别名/代码路径均可命中。
5. ZCode 关闭时外部 MCP 仍可 search/read/propose；ZCode 打开后角标提示，确认后外部 get_proposal_status 返回 committed。
6. 两条 pending 提案同功能点：先确认 A，再打开 B 提示 base 已变冲突，B 不能直接提交。
7. 键盘全流程可达：按钮聚焦、dialog Enter 确认/Esc 拒绝、页面搜索键盘操作。
8. 既有任务/编排/普通会话行为零回归；`pnpm typecheck`、`pnpm lint`、CLI 侧 typecheck/lint 与新增测试通过。
9. 换说法召回：文档用「库存成本核算」，搜「存货计价」「存货成本」均命中（词汇桥/语义层）；搜代码路径命中（锚点层）；结果标注命中来源层。
10. 未配 embedding：搜索仍经词面+词汇桥返回结果，UI 明示「语义召回未启用」，不返回空假装无命中；配置后异步补 embed，向量层生效。
11. 别名沉淀：提炼提案含同义/黑话/英文/缩写别名，确认后这些词均可检索命中。
12. 末级文档行右键出「删除 / 订正」菜单；父节点（有子文档）行无菜单。删除需 Dialog 二次确认，确认后列表/检索不再命中该功能点；取消零副作用。
13. 订正开新 session（~/zcode-kb，yolo），composer 只显示「订正 · {文档名}」chip、输入框无上下文文字、不自动发送；用户描述修改后发送，agent 基于隐藏全文提案，走确认人闸；chip 可移除；历史消息正文不显示上下文尾块。

## 测试与验证

- repo 单测（node:sqlite 内存库）：migration、提交事务原子性、版本单调、提案状态机、并发提案冲突、FTS 中文检索。
- 检索分层测试：词面/别名/锚点/向量各层召回与 RRF 融合排序；换说法召回用例；embedding 未配置/失败的降级路径与命中层标注。
- MCP server 契约测试：四个工具输入输出、ro 连接、提案插入、错误形态。
- E2E：提炼按钮 → 提案 → 确认 → 知识库页可见全链路（先例 desktop e2e）。
- 验证命令：根 `pnpm typecheck` / `pnpm lint`；CLI `pnpm --dir apps/zcode-cli typecheck` / `lint`；测试入口以目标包现有 package.json 为准。