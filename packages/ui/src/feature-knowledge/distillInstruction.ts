// 「提炼」按钮提交给当前会话的派发指令（spec: packages/services/specs/feature-knowledge.md 手动提炼触发）。
// 内联子智能体只能由当前会话模型调用 Agent 工具产生（core/tool/handlers/agent.ts 是唯一 launch 入口），
// 运行时没有 host 直接派生的协议方法，故点击向当前会话发一条指令：主 agent 派后台子智能体后即结束回合。
// 主 agent 持有当前上下文，由它把本次工作要点写进子智能体 prompt，UI 不搬运转录。
// 工具名对应 CLI agent 工具 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate。

export const FEATURE_DISTILL_INSTRUCTION = `请把本次会话的工作提炼进功能点知识库（merge-on-write 活文档，不是新增一篇文档）：

0. 边界：只总结当前会话的工作，只对比 ZCode 内置功能点知识库；读写一律用 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate 这三个内置工具。禁止用 wm-search、references/feature 目录、其他 skill 的索引或会话之外的文档替代；若这三个工具不可用，直接报告失败并停止，不要改用其他检索或自行交付文本提案。

1. 用 SearchFeatures 检索已有功能点（关键词、别名、代码路径都试一遍），判定本次工作归属哪个功能点；确实没有匹配才新建。**归属按功能实体（知识属于哪个功能），不按触发本次工作的需求/任务**——需求只是切入面（如「发票确认收入」之于「经营流水」），跨需求的功能知识合并进该功能自己的活文档，不要把功能挂到需求/任务文档下。**源文档≠功能点**：一份源文档往往只是某实体的一个方面/一次改动；同一实体的多份源文档必须合并进该实体的一份活文档，**禁止一份源文档新建一个功能点**；新建前必须换多种措辞（名称关键词/别名/代码路径）SearchFeatures 确认确无现有实体。
2. 若合并到已有功能点，先用 ReadFeatureDoc 读取它当前的完整活文档。
2.5 三层归属（用户确认 2026-11-25；2026-11-26 澄清：三层结构必须保持，但允许新开分类、不强制套用现成）：大模块（域，如「供应链」「模型与供应商」）→ 功能分类（part_of 父文档，如「以销定采操作台」「直运」）→ 具体文档。每篇文档必须同时挂一个大模块和一个功能分类父，三层缺一不可。大模块/功能分类按归属选用现成的；确属新模块或新功能分类时按需新建（不是必须用现成的，父不存在先建骨架再挂）。只禁止造重复层级：购销本就属供应链，domain 直接写供应链，不要拉「供应链/购销」子域或把购销单列大类。同一功能点的工作并入其活文档相关章节、避免一问一篇碎片；确属独立可检索子主题才在该功能分类下建子文档：父已存在用 relations 加 {toId: 父id, kind: "part_of"}；父是本批新建（尚未确认、还没有 id）改用 parentName=父分类名（host 同域按名找父、缺则建骨架再挂 part_of），不要因拿不到父 id 就省略层级。**不留空分类**：分类父必须挂子文档；功能点本身是叶子时挂到分类下做普通文档，不要建/留无子的空分类根。
3. 段落级重写：只重写与本次工作相关的章节/段落，无关章节逐字保留（措辞与顺序都不动），不做全局重排或跨章节压缩，让确认 diff 只出现相关 hunk。**逐字保留仅针对持久知识章节；源稿/底稿中的排查步骤、验证、打包、未决等过程段不属于保留范围，须剔除。**固定结构：需求背景 / 业务规则 / 代码位置 / 关键修改决策（含 why）/ 坑与注意 / 关联功能点；新建功能点时整份都是相关章节。相关章节内部去重、压缩、重新组织；保真字段不可丢失：代码路径、关键决策依据（why）、坑与注意。发现无关章节有过时或重复内容时不要改正文，只在 change_summary 里提一句留待专项整理。整份目标约 300 行以内。
3.5 知识 vs 过程（用户确认 2026-11-26）：只沉淀**持久的功能知识**——业务规则/口径/行为、代码锚点、可复用的坑与决策 why。**不收实现过程与任务状态**：本次改哪/不改哪（红线不动）、实施顺序、提交/搁置状态、sql 脚本与 md5/版本基线、执行与回退步骤、验证清单、挂人拍板/分工、待确认项——这些是一次性任务交付，不进知识库。事实须与实际核对（选项 key、实体/BO 编号、口径结论）；过时/矛盾/未验证的不写入，方案稿与已落地事实冲突时以事实为准。**源文档若是排查/实施记录，只提炼根因/口径/锚点/可复用坑，禁止搬运排查步骤/验证/打包/未决/挂人；「坑与注意」章节只放可复用陷阱，不放操作步骤；保真字段（代码路径/决策why/坑）不含过程步骤——过程不属于保真，须剔除。**
4. 必须为功能点沉淀别名（业务黑话 / 同义词 / 英文 / 缩写 / 口语叫法），让换个说法也能检索命中。
5. 用 ProposeFeatureUpdate 提交提案：合并到已有功能点带 featureId，新建不带；附 change_summary 与锚点 / 别名 / 关系增量。提交后等我确认，不要自行假定已合并。`;

export const FEATURE_DISTILL_DISPATCH_INSTRUCTION = `请用 Agent 工具派一个后台子智能体（run_in_background: true；必须实际调用 Agent 工具完成派发，禁止只口头声称已派发而不调用工具）执行下面的功能点提炼任务。子智能体的 prompt 里先概述本次会话已完成工作的要点（改了哪些功能、关键决策与坑），再附完整任务说明；派完后只简短告知用户已派发，立即结束本回合，不要自己做提炼。

${FEATURE_DISTILL_INSTRUCTION}`;

// 文档来源提炼（spec: feature-knowledge.md 分析现有文档入口，用户确认 2026-11-25）：
// 与会话提炼共用内联子智能体 + 人闸；一份文档跨多个功能点时按功能点拆多条提案。
// >20 份：host 扫描勾选范围 → 侦察子智能体读大概按主题聚类落盘 → 人闸看主题清单 → 按主题派发。

// 侦察阶段（用户确认 2026-11-25：先读个大概再按相同主题派发；文档↔主题↔功能点多对多）。
// scout 只读+聚类+落盘计划，不提案；主题清单经 dialog 人闸后再按主题派提炼子智能体。
export function buildFeatureDocScoutInstruction(
  paths: readonly string[],
  planPath: string,
): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true；必须实际调用 Agent 工具完成派发，禁止只口头声称已派发而不调用工具）做文档侦察：读下列文档的大概（全文扫但只产出摘要，不要逐字精读），按**相同主题**聚类，产出主题计划并用 Write 落盘到 ${planPath}（JSON：{"themes":[{"name":"主题名","docPaths":["..."],"features":[{"featureId":"可选","name":"功能点名"}]}]}）。要求：一份文档可进多个主题；一个主题可涉及多个功能点（用 SearchFeatures 换多种措辞判定候选，**优先映射到已有 featureId（合并）**，确无现有实体才只写 name；源文档≠功能点，同一实体的多份文档归到同一 featureId）；不要提案、不要改文档。落盘后简短回报主题数与文档数，立即结束本回合。

文档清单：
${list}`;
}

export interface FeatureDocThemeBatch {
  name: string;
  docPaths: string[];
  features: Array<{ featureId?: string; name: string }>;
}

export function buildFeatureDistillThemeInstruction(
  themes: readonly FeatureDocThemeBatch[],
): string {
  const lines = themes
    .map((theme, index) => {
      const targets = theme.features
        .map((f) => (f.featureId ? `「${f.name}」(featureId=${f.featureId})` : `「${f.name}」(新建或自判)`))
        .join("、");
      const docs = theme.docPaths.map((path) => `  - ${path}`).join("\n");
      return `主题${index + 1}「${theme.name}」：涉及功能点 ${targets || "自判"}；文档：\n${docs}`;
    })
    .join("\n");
  return `请用 Agent 工具按下列主题逐批派后台子智能体（run_in_background: true；同一功能点被多主题涉及时串行派；必须实际调用 Agent 工具完成派发，禁止只口头声称已派发而不调用工具）提炼进功能点知识库。每个子智能体 prompt 附该主题任务说明与文档清单；全部派完后简短告知用户，立即结束本回合。

${lines}

每批任务：Read 该主题文档（一份文档可能同时服务多个功能点，按内容拆分归属；归属按功能实体、不按触发需求，需求只是切入面；**源文档≠功能点，同一实体多份源文档合并进一份活文档，禁止一份源文档新建一个功能点**）→ 对涉及的每个功能点先 SearchFeatures 换多种措辞确认已有实体、优先合并，先 ReadFeatureDoc 读底稿 → 段落级重写只改相关章节 → 每个功能点各提一条 ProposeFeatureUpdate 提案等人在 ZCode 确认。层级归属（三层缺一不可：大模块 domain → 功能分类 part_of 父 → 具体文档）：大模块/功能分类按归属选现成的，确属新模块/新功能分类按需新建（不强制套现成；购销本属供应链，domain 写供应链不拉子域），父不存在先建骨架再挂；同一功能点工作并入父活文档相关章节避免碎片，独立子主题才建子功能点：父已存在用 relations 加 {toId: 父id, kind: "part_of"}，父是本批新建（无 id）用 parentName=父分类名（host 同域找父、缺则建骨架再挂）。只沉淀持久知识（规则/口径/锚点/可复用坑），不收实现过程与任务状态（改哪不改哪/实施顺序/提交搁置状态/sql 脚本/md5/版本基线/执行回退/验证清单/挂人待确认）；源排查/实施稿只提炼根因/口径，禁止搬排查步骤/验证/打包/未决，坑章节只放可复用陷阱、过程不属于保真须剔除；事实与实际核对，过时矛盾未验证不写。保真字段不可丢；沉淀别名。读写知识库只用三个内置工具；不可用则报告失败停止。`;
}

export function buildFeatureDistillDocInstruction(paths: readonly string[]): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true；必须实际调用 Agent 工具完成派发，禁止只口头声称已派发而不调用工具）分析下列现有文档并提炼进功能点知识库。子智能体的 prompt 里附完整任务说明与文档清单；派完后只简短告知用户已派发，立即结束本回合，不要自己做提炼。

文档清单（只读这些文档与知识库，不要修改文档原文）：
${list}

任务：
1. 用 Read 逐份读文档（大文档分块读完整），识别每份文档涉及的功能点，并**按功能点归组**：把命中同一功能点的所有文档归到一起；一份文档跨多个功能点时，其内容按功能点拆分归入各组。**源文档≠功能点**：同一实体的多份源文档合并进该实体的一份活文档，禁止一份源文档新建一个功能点。
2. 每个功能点用 SearchFeatures 判定归属（关键词、别名、代码路径都试一遍，换多种措辞），**优先合并到已有实体**，确实没有匹配才新建。归属按功能实体（知识属于哪个功能），不按触发本次工作的需求/任务——需求只是切入面，跨需求的功能知识合并进该功能自己的活文档，不要挂到需求文档下。三层缺一不可：大模块（domain）→ 功能分类（part_of 父）→ 具体文档；大模块/功能分类按归属选现成的，确属新模块/新功能分类按需新建（不强制套现成；购销本属供应链，domain 写供应链不拉子域）；挂父：父已存在用 relations 加 {toId: 父id, kind: "part_of"}，父是本批新建（尚未确认、无 id）用 parentName=父分类名（host 同域找父、缺则建骨架再挂），不要省略层级。
3. **一个功能点只读一次底稿、只提一条提案**：合并到已有功能点先 ReadFeatureDoc 读它当前完整底稿，把归到该功能点的**所有文档**一次性段落级重写合并进去（只改相关章节、无关章节逐字保留）；不要一份文档提一条、导致同功能点多条提案基于同一旧版本互相冲突返工。保真字段（代码路径、决策 why、坑）不可丢失。只沉淀持久知识（规则/口径/锚点/可复用坑），不收实现过程与任务状态（改哪不改哪/实施顺序/提交搁置状态/sql 脚本/md5/版本基线/执行回退/验证清单/挂人待确认）；源排查/实施稿只提炼根因/口径，禁止搬排查步骤/验证/打包/未决，坑章节只放可复用陷阱、过程不属于保真须剔除；事实与实际核对，过时矛盾未验证不写。
4. 用 ProposeFeatureUpdate **按功能点逐条**提交（每个功能点一条：合并带 featureId、新建不带）；附 change_summary 与锚点/别名增量；提交后等人在 ZCode 确认，不要自行假定已合并。
5. 读写知识库只用 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate 三个内置工具；不可用则报告失败并停止，不要用其他 skill 或索引替代。`;
}

// 归属纠正（spec: feature-knowledge.md 提案-确认闸门）：上一轮投错功能点时，指定正确归属重提。
// 不能只换提案的目标 id——旧正文是按错误底稿重写的，必须基于正确底稿重新合并。
export function buildFeatureDistillCorrectionInstruction(options: {
  targetFeatureId?: string;
  targetName: string;
  wrongTargetName: string;
}): string {
  const target = options.targetFeatureId
    ? `合并到已有功能点「${options.targetName}」（featureId=${options.targetFeatureId}）：先 ReadFeatureDoc 读它当前的完整底稿再合并`
    : `新建功能点「${options.targetName}」`;
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true；必须实际调用 Agent 工具完成派发，禁止只口头声称已派发而不调用工具）纠正上一轮提炼的归属错误：上一轮把本次工作投到了「${options.wrongTargetName}」，正确归属是${target}。子智能体的 prompt 里先概述本次会话已完成工作的要点，再附指定归属与完整任务说明；不要沿用上一轮提案正文；派完后只简短告知用户已派发，立即结束本回合。

${FEATURE_DISTILL_INSTRUCTION}`;
}

// 末级文档「订正」隐藏上下文的任务说明（spec: feature-knowledge.md 末级右键订正，用户需求 2026-11-26）。
// 随 composer 尾块注入（不进输入框、不自动发送）：用户随后在会话里口述要订正的内容，
// agent 以注入的全文为底稿做段落级重写，提案仍走人闸。
export function buildFeatureCorrectionInstruction(options: {
  featureId: string;
  featureName: string;
}): string {
  return `本次会话是功能点「${options.featureName}」（featureId=${options.featureId}）的订正会话。首条消息的隐藏上下文里已附该功能点的完整活文档（docMd）、名称、域、别名、代码锚点与当前版本；用户接下来会口述要订正的内容。

任务约定：
1. 等用户描述订正内容后再动手；不要自行猜测要改什么，也不要一上来就提案。
2. 以隐藏上下文中的 docMd 为底稿（如与知识库现状有出入，用 ReadFeatureDoc 复核当前版本），按段落级重写契约只改与订正相关的章节/段落，无关章节逐字保留（措辞与顺序都不动），不做全局重排；保真字段（代码路径、决策 why、坑与注意）不可丢失。
3. 只沉淀持久功能知识（规则/口径/锚点/可复用坑），不收实现过程与任务状态；用户口述中的过时/矛盾/未验证内容须与实际核对后再写入。
4. 用 ProposeFeatureUpdate 提交提案，必须带 featureId=${options.featureId}，附 change_summary 与锚点/别名增量；提交后等用户在 ZCode 确认，不要自行假定已合并。
5. 读写知识库只用 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate 三个内置工具；不可用则报告失败并停止。`;
}