// 「提炼」按钮提交给当前会话的派发指令（spec: packages/services/specs/feature-knowledge.md 手动提炼触发）。
// 内联子智能体只能由当前会话模型调用 Agent 工具产生（core/tool/handlers/agent.ts 是唯一 launch 入口），
// 运行时没有 host 直接派生的协议方法，故点击向当前会话发一条指令：主 agent 派后台子智能体后即结束回合。
// 主 agent 持有当前上下文，由它把本次工作要点写进子智能体 prompt，UI 不搬运转录。
// 工具名对应 CLI agent 工具 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate。

export const FEATURE_DISTILL_INSTRUCTION = `请把本次会话的工作提炼进功能点知识库（merge-on-write 活文档，不是新增一篇文档）：

0. 边界：只总结当前会话的工作，只对比 ZCode 内置功能点知识库；读写一律用 SearchFeatures / ReadFeatureDoc / ProposeFeatureUpdate 这三个内置工具。禁止用 wm-search、references/feature 目录、其他 skill 的索引或会话之外的文档替代；若这三个工具不可用，直接报告失败并停止，不要改用其他检索或自行交付文本提案。

1. 用 SearchFeatures 检索已有功能点（关键词、别名、代码路径都试一遍），判定本次工作归属哪个功能点；确实没有匹配才新建。
2. 若合并到已有功能点，先用 ReadFeatureDoc 读取它当前的完整活文档。
2.5 层级归属（part_of）：先判父功能点（大分类整篇活文档，如「以销定采操作台」）。本次工作能并入父文档某章节就并入父文档，不要单开；只有独立可检索的子主题才新建/合并子功能点，并在 relations 加 {toId: 父功能点id, kind: "part_of"}。
3. 段落级重写：只重写与本次工作相关的章节/段落，无关章节逐字保留（措辞与顺序都不动），不做全局重排或跨章节压缩，让确认 diff 只出现相关 hunk。固定结构：需求背景 / 业务规则 / 代码位置 / 关键修改决策（含 why）/ 坑与注意 / 关联功能点；新建功能点时整份都是相关章节。相关章节内部去重、压缩、重新组织；保真字段不可丢失：代码路径、关键决策依据（why）、坑与注意。发现无关章节有过时或重复内容时不要改正文，只在 change_summary 里提一句留待专项整理。整份目标约 300 行以内。
4. 必须为功能点沉淀别名（业务黑话 / 同义词 / 英文 / 缩写 / 口语叫法），让换个说法也能检索命中。
5. 用 ProposeFeatureUpdate 提交提案：合并到已有功能点带 featureId，新建不带；附 change_summary 与锚点 / 别名 / 关系增量。提交后等我确认，不要自行假定已合并。`;

export const FEATURE_DISTILL_DISPATCH_INSTRUCTION = `请用 Agent 工具派一个后台子智能体（run_in_background: true）执行下面的功能点提炼任务。子智能体的 prompt 里先概述本次会话已完成工作的要点（改了哪些功能、关键决策与坑），再附完整任务说明；派完后只简短告知用户已派发，立即结束本回合，不要自己做提炼。

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
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true）做文档侦察：读下列文档的大概（全文扫但只产出摘要，不要逐字精读），按**相同主题**聚类，产出主题计划并用 Write 落盘到 ${planPath}（JSON：{"themes":[{"name":"主题名","docPaths":["..."],"features":[{"featureId":"可选","name":"功能点名"}]}]}）。要求：一份文档可进多个主题；一个主题可涉及多个功能点（用 SearchFeatures 判定候选，判不定就只写 name 不写 featureId）；不要提案、不要改文档。落盘后简短回报主题数与文档数，立即结束本回合。

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
  return `请用 Agent 工具按下列主题逐批派后台子智能体（run_in_background: true；同一功能点被多主题涉及时串行派）提炼进功能点知识库。每个子智能体 prompt 附该主题任务说明与文档清单；全部派完后简短告知用户，立即结束本回合。

${lines}

每批任务：Read 该主题文档（一份文档可能同时服务多个功能点，按内容拆分归属）→ 对涉及的每个功能点先 ReadFeatureDoc 读底稿 → 段落级重写只改相关章节 → 每个功能点各提一条 ProposeFeatureUpdate 提案等人在 ZCode 确认。层级归属：能并入父功能点（大分类整篇活文档）章节就并入父；独立子主题才建子功能点并 relations 加 {toId: 父id, kind: "part_of"}。保真字段不可丢；沉淀别名。读写知识库只用三个内置工具；不可用则报告失败停止。`;
}

export function buildFeatureDistillDocInstruction(paths: readonly string[]): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true）分析下列现有文档并提炼进功能点知识库。子智能体的 prompt 里附完整任务说明与文档清单；派完后只简短告知用户已派发，立即结束本回合，不要自己做提炼。

文档清单（只读这些文档与知识库，不要修改文档原文）：
${list}

任务：
1. 用 Read 逐份读文档（大文档分块读完整），识别其中涉及的功能点；一份文档跨多个功能点时按功能点拆成多条提案。
2. 每个功能点用 SearchFeatures 判定归属（关键词、别名、代码路径都试一遍），确实没有匹配才新建。
3. 合并到已有功能点先 ReadFeatureDoc 读它当前的完整底稿，按段落级重写只改相关章节、无关章节逐字保留；保真字段（代码路径、决策 why、坑）不可丢失。
4. 用 ProposeFeatureUpdate 逐条提交提案：合并带 featureId、新建不带；附 change_summary 与锚点/别名增量；提交后等人在 ZCode 确认，不要自行假定已合并。
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
  return `请用 Agent 工具派一个后台子智能体（run_in_background: true）纠正上一轮提炼的归属错误：上一轮把本次工作投到了「${options.wrongTargetName}」，正确归属是${target}。子智能体的 prompt 里先概述本次会话已完成工作的要点，再附指定归属与完整任务说明；不要沿用上一轮提案正文；派完后只简短告知用户已派发，立即结束本回合。

${FEATURE_DISTILL_INSTRUCTION}`;
}