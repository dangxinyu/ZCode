/* eslint-disable max-lines -- 计划服务单一工厂承载生命周期/DAG 校验/意图注入全链路，拆散会让 spec 对照更难追踪。 */
// 编排计划服务 v2 —— 多计划生命周期（spec: packages/services/specs/orchestration-plan.md）。
// 计划模式（per-orchestration 开关，orchestration_plan_mode 表）+ 多计划
// （orchestration_plans 表，plan_id + is_active 选中态 + completed 推导）。
// 执行者始终是编排 agent：本服务只持有计划事实、校验 DAG、注入确认消息；
// 微调重执行复用原子任务（reuseChildTaskId），变更传播由 agent 经
// MarkPlanNodesStale 工具标 stale（判断权在 agent，host 管状态机）。
// 纯函数模型（DAG 校验/修订 diff/完成推导/确认文案）在 orchestrationPlanModel.ts。
import { randomUUID } from "node:crypto";
import type { ModelSelection, ZCodeOrchestrationPlansMapProtocol } from "@zcode/shared";
import { ORCHESTRATION_PLANS_CHANGED_BROADCAST_CHANNEL } from "@zcode/shared";
// 分层布局落库（用户需求 2026-11-04）：与 UI 整理布局/渲染兜底同一算法（shared 单一实现）。
import { applyMissingLayouts } from "@zcode/shared/orchestration-plan-layout";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import { createEmptyPlanRow, deletePlanRow, renamePlanRow } from "./orchestrationPlanAdmin.js";
import { applyStaleMarks, markNodeTerminalByChild } from "./orchestrationPlanNodeStatus.js";
import {
  buildConfirmNotice,
  deriveStatus,
  revisePlanNodes,
  rowToPlan,
  parsePlanJson,
  validatePlanGraph,
  wireRootsToStart,
  withStartNode,
  type OrchestrationPlan,
  type OrchestrationPlanNode,
  type OrchestrationPlanServiceApi,
  type ProposedPlanNode,
  type WorkspaceScope,
} from "./orchestrationPlanModel.js";

const logger = createServiceLogger("zcode-orchestration");

export type {
  IOrchestrationPlanService,
  OrchestrationPlan,
  OrchestrationPlanNode,
  ProposedPlanNode,
} from "./orchestrationPlanModel.js";

type OrchestrationPlansMap = ZCodeOrchestrationPlansMapProtocol;

type PlanRow = Awaited<ReturnType<TaskIndexRepo["listOrchestrationPlanRows"]>>[number];

function parseOrigin(planJson: string): "agent" | "manual" {
  try {
    const parsed = JSON.parse(planJson) as { origin?: unknown };
    return parsed.origin === "manual" ? "manual" : "agent";
  } catch {
    return "agent";
  }
}

export function createOrchestrationPlanService(options: {
  taskIndexRepo: TaskIndexRepo;
  /**
   * 确认计划的注入通道（v1 sendPrompt）。模式切换/选中切换不发消息（用户确认
   * 2026-10-28）；确认是执行触发，注入确认消息（节点清单；执行规则是 CLI 常驻引导）。
   */
  zcodeAgentService: Pick<IZCodeAgentService, "readSession" | "sendPrompt">;
  /** 注入选型合法性的 host 侧裁决面：view 由 Provider Registry 构造（用户需求 2026-10-30）。 */
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  /** 计划变更广播：agent 侧变更不经 UI 动作，无信号则画布/列表停在旧快照（用户需求 2026-10-30）。 */
  broadcastService: Pick<IBroadcastService, "send">;
}): OrchestrationPlanServiceApi {
  const { taskIndexRepo, zcodeAgentService, modelSelectionService, broadcastService } = options;

  async function readMode(
    params: WorkspaceScope & { orchestrationTaskId: string },
  ): Promise<boolean> {
    return taskIndexRepo.isOrchestrationPlanModeOn(params);
  }

  async function readPlans(
    params: WorkspaceScope & { orchestrationTaskId: string },
  ): Promise<OrchestrationPlansMap> {
    const [planMode, pendingNewPlan, rows] = await Promise.all([
      readMode(params),
      taskIndexRepo.getOrchestrationNewPlanPending(params),
      taskIndexRepo.listOrchestrationPlanRows(params),
    ]);
    const active = rows.find((row) => row.isActive);
    return {
      planMode,
      activePlanId: active?.planId ?? null,
      plans: rows.map(rowToPlan),
      pendingNewPlan,
    };
  }

  async function readActiveRow(
    params: WorkspaceScope & { orchestrationTaskId: string },
  ): Promise<PlanRow | null> {
    const rows = await taskIndexRepo.listOrchestrationPlanRows(params);
    return rows.find((row) => row.isActive) ?? null;
  }

  // spawn 占位/绑定的公共前置：active 行 → confirmed 计划 → 节点定位 → 结构/锁定检查。
  // 无 active 计划返回 null（调用方静默跳过，与 bind 的宽容语义一致）。
  async function readSpawnTargetNode(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planNodeId: string;
  }): Promise<{ plan: OrchestrationPlan; node: OrchestrationPlanNode } | null> {
    const activeRow = await readActiveRow(params);
    if (!activeRow) return null;
    const plan = rowToPlan(activeRow);
    if (plan.status !== "confirmed") {
      throw new Error("Plan is not confirmed yet. Wait for the 【编排计划·确认】 message.");
    }
    const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
    if (!node) throw new Error(`Unknown plan node "${params.planNodeId}".`);
    if (node.isStart) {
      throw new Error("The start node is a structural marker and cannot be dispatched.");
    }
    // 用户手动确定的绑定不可被主任务改派（用户需求 2026-10-30）：向既定子任务下发
    // 指令，而不是派生新任务。childTaskId 与 List 工具结果同源，模型侧可用。
    if (node.childTaskLocked && node.childTaskId) {
      throw new Error(
        `Plan node "${params.planNodeId}" already has a child task chosen by the user (${node.childTaskId}). Send instructions to that existing child task instead of spawning a new one.`,
      );
    }
    return { plan, node };
  }

  /** 计划事实变更后广播（fire-and-forget）：UI 订阅频道重拉 plansMap，画布/列表即时跟随。 */
  function publishPlansChanged(params: WorkspaceScope & { orchestrationTaskId: string }): void {
    void broadcastService
      .send({
        channel: ORCHESTRATION_PLANS_CHANGED_BROADCAST_CHANNEL,
        payload: { orchestrationTaskId: params.orchestrationTaskId },
      })
      .catch((error: unknown) => {
        logger.warn("Orchestration plans-changed broadcast failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          orchestrationTaskId: params.orchestrationTaskId,
        });
      });
  }

  async function writePlanRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    orchestrationTaskId: string;
    planId: string;
    title: string;
    status: string;
    nodes: OrchestrationPlanNode[];
    version: number;
    isActive: boolean;
    createdAt: number;
    /** 新建时指定来源；缺省 = 已有行沿用（修订不改来源）。 */
    origin?: "agent" | "manual";
    /** 计划级子任务默认模型（用户需求 2026-11-05）；缺省沿用存量（任何状态写入不得抹掉）。 */
    childModelDefault?: ModelSelection | null;
  }): Promise<void> {
    const existing = (await taskIndexRepo.listOrchestrationPlanRows(params)).find(
      (row) => row.planId === params.planId,
    );
    // origin 缺省沿用已有行（修订不改来源）：此前算了没用、planJson 写死
    // `params.origin ?? "agent"`，手动计划（origin=manual）一经修订即被翻成
    // agent，与参数注释承诺矛盾——以变量为准。
    const origin = params.origin ?? (existing ? parseOrigin(existing.planJson) : "agent");
    // 计划级子任务默认模型（用户需求 2026-11-05）：缺省沿用存量——writePlanRow 是所有
    // 状态写入（终态/占位/绑定等）的公共通道，任何一条都不许把用户设的默认模型抹掉。
    const childModelDefault =
      params.childModelDefault !== undefined
        ? params.childModelDefault
        : existing
          ? parsePlanJson(existing.planJson).childModelDefault ?? null
          : null;
    await taskIndexRepo.upsertOrchestrationPlanRow({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      orchestrationTaskId: params.orchestrationTaskId,
      planId: params.planId,
      title: params.title,
      planMode: true,
      status: params.status,
      planJson: JSON.stringify({
        version: params.version,
        nodes: params.nodes,
        origin,
        ...(childModelDefault !== undefined ? { childModelDefault } : {}),
      }),
      isActive: params.isActive,
      createdAt: existing?.createdAt ?? params.createdAt,
    });
  }

  async function injectNotice(
    params: WorkspaceScope & { orchestrationTaskId: string },
    content: string,
  ): Promise<void> {
    // server 重启后主会话 runtime 是冷的、无模型选型，注入触发的首轮会被模型闸门
    // 拒绝（"Select a model before continuing"）。UI 正常发送会带 modelSelection，
    // 注入通道不带。候选链：会话快照 current/lastUsed → tasks-index meta——两者都是
    // 历史产物，跨环境可能整体失效（实测会话快照停在旧环境的 "glm"，ProviderNotFound，
    // 用户需求 2026-10-30）。所以拿到候选后必须用 ModelSelectionView（Registry 构造，
    // provider/model 全部合法）逐个校验，全部失效则退 view.preferredSelection（Registry
    // 背书的缺省选型）。选型仍无效时错误经外层 catch 吞掉，不阻断会话。
    const target = {
      sessionId: params.orchestrationTaskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    };
    const candidates: ModelSelection[] = [];
    try {
      const snapshot = await zcodeAgentService.readSession(target);
      const current = snapshot.settings.model.current;
      const lastUsed = snapshot.settings.model.lastUsed;
      if (current) candidates.push(current);
      if (lastUsed) candidates.push(lastUsed);
    } catch {
      // 快照读取失败（会话行缺失等）不阻断，继续 meta 兜底。
    }
    {
      const meta = await taskIndexRepo
        .getTaskMeta({ ...target, taskId: params.orchestrationTaskId })
        .catch(() => null);
      if (meta?.provider && meta?.model) {
        candidates.push({
          providerId: meta.provider,
          modelId: meta.model,
          // 与 zcodeTaskServiceAdapter 的 thoughtLevel→reasoningLevel 映射一致。
          ...(meta.thoughtLevel ? { options: { reasoningLevel: meta.thoughtLevel } } : {}),
        });
      }
    }
    const view = await modelSelectionService.getView().catch(() => null);
    const isRegistryValid = (candidate: ModelSelection): boolean =>
      view?.providers.some(
        (provider) =>
          provider.providerId === candidate.providerId &&
          provider.models.some((model) => model.modelId === candidate.modelId),
      ) === true;
    const modelSelection =
      candidates.find(isRegistryValid) ?? view?.preferredSelection ?? undefined;
    try {
      await zcodeAgentService.sendPrompt({
        ...target,
        content,
        clientMode: "desktop-continuous",
        ...(modelSelection ? { modelSelection } : {}),
      });
    } catch (error: unknown) {
      logger.warn("Orchestration plan notice injection failed", {
        event: "orchestration.plan.notice_inject_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        orchestrationTaskId: params.orchestrationTaskId,
      });
    }
  }

  return {
    async createEmptyPlan(params) {
      const plan = await createEmptyPlanRow({ taskIndexRepo, logger }, params);
      publishPlansChanged(params);
      return plan;
    },
    async setNewPlanPending(params) {
      // 只翻服务端等待态，不发任何消息（用户需求 2026-10-29 改版：起不起新计划由
      // 后续对话决定，agent 经 List 工具结果的 pendingNewPlan 感知）。
      await taskIndexRepo.setOrchestrationNewPlanPending({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        pending: params.pending,
      });
      publishPlansChanged(params);
      return readPlans(params);
    },
    async renamePlan(params) {
      const next = await renamePlanRow({ taskIndexRepo }, params);
      publishPlansChanged(params);
      return next;
    },
    async deletePlan(params) {
      const next = await deletePlanRow({ taskIndexRepo, logger }, params);
      publishPlansChanged(params);
      return next;
    },
    getActivePlan: async (params) => {
      const row = await readActiveRow(params);
      return row ? rowToPlan(row) : null;
    },
    isPlanModeOn: readMode,
    getPlansMap: async (params) => {
      const map: Record<string, OrchestrationPlansMap> = {};
      for (const orchestrationTaskId of params.orchestrationTaskIds) {
        map[orchestrationTaskId] = await readPlans({ ...params, orchestrationTaskId });
      }
      return map;
    },
    async setPlanMode(params) {
      if (params.enabled) {
        // 默认选中规则（spec v2）：最近创建的计划未完成 → 自动选中；已完成/无计划 → 清选中。
        const rows = await taskIndexRepo.listOrchestrationPlanRows(params);
        const latest = rows.reduce<PlanRow | null>(
          (acc, row) => (!acc || row.createdAt > acc.createdAt ? row : acc),
          null,
        );
        const autoSelect = latest && latest.status !== "completed" ? latest.planId : null;
        await taskIndexRepo.setPlanModeAndSelection({
          ...params,
          planMode: true,
          planId: autoSelect,
        });
        // 零计划开启计划模式 → 默认进入「另起新计划」等待态（用户需求 2026-10-30）：
        // 没有任何计划时首个需求天然该起新计划，agent 经 pendingNewPlan 感知后由
        // 对话决定是否落地；用户可随时在下拉里取消。
        if (rows.length === 0) {
          await taskIndexRepo.setOrchestrationNewPlanPending({
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            orchestrationTaskId: params.orchestrationTaskId,
            pending: true,
          });
        }
      } else {
        // 关闭只翻模式（plan_mode 表），选中态保留——重开时恢复原选中。
        await taskIndexRepo.setPlanModeAndSelection({ ...params, planMode: false, planId: null });
      }
      logger.info("Orchestration plan mode toggled", {
        enabled: params.enabled,
        event: "orchestration.plan.mode_toggled",
        orchestrationTaskId: params.orchestrationTaskId,
        workspacePath: params.workspacePath,
      });
      publishPlansChanged(params);
      return readPlans(params);
    },
    async selectPlan(params) {
      const { clearNewPlanPending, ...selection } = params;
      await taskIndexRepo.setPlanModeAndSelection({
        ...selection,
        planMode: await readMode(selection),
        planId: selection.planId,
      });
      // 下拉单选语义（用户需求 2026-11-02）：等待态与现有计划互斥，用户显式点选
      // 现有计划即放弃新建意图。只清不设，且仅选中非 null 计划时生效。
      if (clearNewPlanPending && selection.planId) {
        await taskIndexRepo.setOrchestrationNewPlanPending({
          workspacePath: selection.workspacePath,
          ...(selection.workspaceIdentity
            ? { workspaceIdentity: selection.workspaceIdentity }
            : {}),
          orchestrationTaskId: selection.orchestrationTaskId,
          pending: false,
        });
      }
      publishPlansChanged(selection);
      return readPlans(selection);
    },
    async proposePlan(params) {
      if (!(await readMode(params))) {
        throw new Error(
          "Plan mode is disabled for this orchestration task. Execute the requirement directly; do not call ProposeOrchestrationPlan.",
        );
      }
      const proposed = wireRootsToStart(
        withStartNode(
          params.nodes.map((node) => ({
            nodeId: node.nodeId,
            name: node.name,
            goal: node.goal,
            dependsOn: node.dependsOn,
            needsUpstreamResult: node.needsUpstreamResult ?? true,
            ...(node.isStart ? { isStart: true } : {}),
            // autoExecute 是画布可编辑配置（用户需求 2026-11-03 改版）：UI 保存随节点携带，
            // 有值原样透传；缺省时新建分支默认开（agent 新提案）、修订分支由
            // revisePlanNodes 按存量/origin 取默认，不在映射里拍死。
            ...(node.isStart
              ? {}
              : node.autoExecute !== undefined
                ? { autoExecute: node.autoExecute }
                : params.createNew
                  ? { autoExecute: true }
                  : {}),
            // 绑定随保存落库（用户需求 2026-11-03 改版）：UI 保存逐节点携带
            // （含显式解绑的 null）；agent 提案不带该字段 → 修订按存量语义处理。
            ...(node.isStart || node.childTaskId === undefined
              ? {}
              : { childTaskId: node.childTaskId, childTaskLocked: node.childTaskLocked ?? false }),
            ...(node.isStart || node.pinnedSkills === undefined
              ? {}
              : { pinnedSkills: node.pinnedSkills }),
            // 子任务模型透传（用户需求 2026-11-05）：UI 保存逐节点携带（null = 跟随主任务
            // 的显式表达，undefined = agent 提案按存量语义）；丢了会让用户改回跟随主任务
            // 的操作存不上。
            ...(node.isStart || node.model === undefined
              ? {}
              : { model: node.model }),
            // 思考档位同口径透传（用户需求 2026-11-05）。
            ...(node.isStart || node.thoughtLevel === undefined
              ? {}
              : { thoughtLevel: node.thoughtLevel }),
            // 布局必须透传：UI 画布保存（拖动/缩放）走的就是本通道，丢了 layout
            // 修订 diff 会保留旧位置，用户改动的位置和尺寸永远存不上（用户实测）。
            ...(node.layout ? { layout: node.layout } : {}),
          })),
          (seed) => ({ ...seed }),
        ),
      );
      validatePlanGraph(proposed);
      // 绑定允许多挂（用户需求 2026-11-04）：同一子任务可同时挂多个节点（一个子任务
      // 的完成会同时把挂它的节点全部置 terminal）。
      // 修订目标：UI 编辑显式带 planId（用户需求 2026-10-30：看哪个存哪个，查看
      // 不改 active 选中）；agent 提案不带 planId → 修订 active 计划。指定计划
      // 不存在（并发删除等）直接报错，不静默落到新建分支。
      const targetRow = params.planId
        ? ((await taskIndexRepo.listOrchestrationPlanRows(params)).find(
            (row) => row.planId === params.planId,
          ) ?? null)
        : await readActiveRow(params);
      if (params.planId && !targetRow) {
        throw new Error(`Plan ${params.planId} no longer exists; reload the plan list.`);
      }
      if (targetRow && !params.createNew) {
        // 修订目标计划（微调 diff：修改的 terminal 节点回 pending 复用原子任务等）。
        const current = rowToPlan(targetRow);
        // 新增节点的自动执行默认值跟计划 origin（用户需求 2026-11-03）：agent 提案开、
        // 手动建的计划关；按 nodeId 匹配的存量节点保留用户设定（revisePlanNodes 内处理）。
        let reviseDefaultAuto = false;
        try {
          reviseDefaultAuto = JSON.parse(targetRow.planJson).origin === "agent";
        } catch {
          reviseDefaultAuto = false;
        }
        // 修订后重新规范起始（agent 修订可能丢掉 start）、根节点接线兜底，并复验不变量。
        // 布局只补缺（用户需求 2026-11-04）：新增/注入节点（含 start 种子）按分层布局
        // 补算坐标并与存量位置避让；用户拖过/存过的 layout 一律不动（布局必须透传）。
        const nodes = applyMissingLayouts(
          wireRootsToStart(
            withStartNode(revisePlanNodes(current.nodes, proposed, reviseDefaultAuto), (seed) => ({
              ...seed,
              status: "pending" as const,
              childTaskId: null,
              layout: { x: 60, y: 60 },
            })),
          ),
        );
        validatePlanGraph(nodes);
        // 查缺补漏（用户需求 2026-10-30，完成态可编辑的配套）：修订后被改节点回
        // pending/新增节点 pending——结果依赖它的已完成节点交付不再可信，级联标 stale
        //（上游标 stale 本身即非 terminal，继续传染其直接下游，直到不动点）。
        // 只看 needsUpstreamResult=true 的结果依赖（纯排序边不携带交付，不传染）；
        // stale 收敛仍归 MarkPlanNodesStale 复核流程。完成态计划编辑后自动脱离 completed
        //（读取时推导：存在非 terminal 节点即不再是 completed）。
        const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
        const staleIds = new Set<string>();
        let staleChanged = true;
        while (staleChanged) {
          staleChanged = false;
          for (const node of nodes) {
            if (node.status !== "terminal" || staleIds.has(node.nodeId)) continue;
            if (!node.needsUpstreamResult) continue;
            const upstreamBroken = node.dependsOn.some((dep) => {
              const upstream = nodeById.get(dep);
              return upstream
                ? upstream.status !== "terminal" || staleIds.has(upstream.nodeId)
                : false;
            });
            if (upstreamBroken) {
              staleIds.add(node.nodeId);
              staleChanged = true;
            }
          }
        }
        const finalNodes =
          staleIds.size === 0
            ? nodes
            : nodes.map((node) =>
                staleIds.has(node.nodeId) ? { ...node, status: "stale" as const } : node,
              );
        const version = current.version + 1;
        await writePlanRow({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          orchestrationTaskId: params.orchestrationTaskId,
          planId: current.planId,
          // 计划名一经确定不可被改名（用户需求 2026-10-30）：修订一律沿用现名，
          // 提案侧 title 只在建新计划时生效——实测 agent 修订带 title 变体
          //（"（重新发起）"后缀）会静默改名。改名唯一入口 = 用户 UI 重命名。
          title: current.title,
          // 确认/完成后的画布编辑（用户需求 2026-10-30）走同一修订通道：列值归位
          // confirmed（完成态由读取推导），不把执行中的计划打回草稿（打回会重阻塞
          // 派发并让确认按钮复现）。
          status: current.status === "draft" ? "draft" : "confirmed",
          nodes: finalNodes,
          version,
          // 保留目标行自身的选中标志：upsert 不维护唯一 active，按 planId 修订一个
          // 非 active 计划时写 true 会凭空造出第二个 active 行。
          isActive: targetRow.isActive,
          // 计划级子任务默认模型（用户需求 2026-11-05）：UI 编辑显式携带，缺省沿用存量。
          ...(params.childModelDefault !== undefined
            ? { childModelDefault: params.childModelDefault }
            : {}),
          createdAt: current.createdAt,
        });
        logger.info("Orchestration plan revised", {
          event: "orchestration.plan.revised",
          nodeCount: finalNodes.length,
          orchestrationTaskId: params.orchestrationTaskId,
          planId: current.planId,
          staleCount: staleIds.size,
          version,
        });
        publishPlansChanged(params);
        return { planId: current.planId, version, status: "draft", nodeCount: finalNodes.length };
      }
      // 新建计划：host 生成 planId，置 active。
      const planId = `plan-${randomUUID().slice(0, 8)}`;
      const title =
        params.title?.trim() ||
        (params.nodes[0]?.name
          ? `${params.nodes[0].name} 等 ${params.nodes.length} 项`
          : "编排计划");
      const now = Date.now();
      // 创建即落库布局（用户需求 2026-11-04"创建计划时也遵守梳理办法"）：agent 协议
      // 不带坐标，服务端按分层布局算法补算每个节点（画布打开即整齐，不再是定义顺序堆叠）。
      const nodes: OrchestrationPlanNode[] = applyMissingLayouts(
        proposed.map((node) => ({
          ...node,
          status: "pending" as const,
          childTaskId: null,
        })),
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId,
        title,
        status: "draft",
        nodes,
        version: 1,
        // 计划级子任务默认模型（用户需求 2026-11-05）：agent 提案不带 → null（跟随主任务）。
        ...(params.childModelDefault !== undefined
          ? { childModelDefault: params.childModelDefault }
          : {}),
        isActive: true,
        createdAt: now,
      });
      // 新计划落地 = 「另起新计划」等待态使命完成（用户需求 2026-10-30：agent 重试
      // 可能不带 createNew——只要走到新建分支就清，不依赖模型怎么标记）。
      await taskIndexRepo.setOrchestrationNewPlanPending({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        pending: false,
      });
      logger.info("Orchestration plan proposed", {
        event: "orchestration.plan.proposed",
        nodeCount: nodes.length,
        orchestrationTaskId: params.orchestrationTaskId,
        planId,
        version: 1,
      });
      publishPlansChanged(params);
      return { planId, version: 1, status: "draft", nodeCount: nodes.length };
    },
    async confirmPlan(params) {
      // 确认目标：UI 显式带 planId（确认正在查看的草稿，用户需求 2026-10-30）；
      // agent/缺省 = active 计划。
      const targetRow = params.planId
        ? ((await taskIndexRepo.listOrchestrationPlanRows(params)).find(
            (row) => row.planId === params.planId,
          ) ?? null)
        : await readActiveRow(params);
      if (!targetRow) {
        throw new Error("No plan to confirm. Submit a plan via ProposeOrchestrationPlan first.");
      }
      const plan = rowToPlan(targetRow);
      if (plan.status !== "draft") {
        throw new Error(
          `Plan "${plan.title}" is not a pending draft (status: ${plan.status}). Propose a new revision first.`,
        );
      }
      // 至少一个非起始节点才可确认（用户需求 2026-11-02）：起始节点只是结构标记，
      // 只有「开始」的计划没有可执行内容，确认后会被读时推导直接判成 completed。
      if (!plan.nodes.some((node) => !node.isStart)) {
        throw new Error(
          `Plan "${plan.title}" has no task nodes (only the start marker). Add at least one node before confirming.`,
        );
      }
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: "confirmed",
        nodes: plan.nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      // 确认哪个计划就执行哪个计划：确认即置为唯一 active（agent 派发门/绑定都以
      // active 为口径；upsert 不清旧行，须显式切换）。
      await taskIndexRepo.setActiveOrchestrationPlan({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
      });
      await injectNotice(params, buildConfirmNotice(plan));
      logger.info("Orchestration plan confirmed", {
        event: "orchestration.plan.confirmed",
        nodeCount: plan.nodes.length,
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        version: plan.version,
      });
      publishPlansChanged(params);
      return { ...plan, status: "confirmed" };
    },
    /** spawn 占位（用户需求 2026-11-05 派发竞态修复）：pending/stale → dispatched
     * （childTaskId 留空）是并发派发的序列化点——host 引擎扫描与用户点击在此决出胜负，
     * 落空者在创建子任务**之前**收到错误，孤儿会话不再产生。无 active 计划静默跳过
     * （与 bind 的宽容语义一致，计划门已在任务服务拦截）。
     * **僵尸自愈**（用户需求 2026-11-05 实测：解链后节点卡 dispatched 点执行被拒）：
     * dispatched 且无 childTaskId 的节点没有任何子任务会回报终态，是解链/历史竞态留下的
     * 死状态——点「执行」视为可重新派发（保持 dispatched 直接放行，由 bind 挂上新子任务），
     * 不再拒。dispatched **有** childTaskId 才是真在跑，照旧拒绝。
     * **failed 同口径**（用户需求 2026-11-05 实测：解链后 failed 节点点执行被拒）：failed
     * 是人工停留点（红色），用户点「执行」= 显式重跑指令——无绑定子任务的 failed 节点
     * 放行重派（failed → dispatched）；有绑定的 failed 走 sendChildTaskPrompt 复用原子
     * 任务（不经本函数）。 */
    async reservePlanNodeForSpawn(params) {
      const target = await readSpawnTargetNode(params);
      if (!target) return;
      const { plan, node } = target;
      // 僵尸/失败自愈：dispatched 或 failed 且无绑定子任务（未锁定）= 没有任何子任务会
      // 回报终态或已明确失败待重跑，点「执行」都是显式重跑指令，放行。
      const manualRetry =
        (node.status === "dispatched" || node.status === "failed") &&
        !node.childTaskId &&
        !node.childTaskLocked;
      if (node.status !== "pending" && node.status !== "stale" && !manualRetry) {
        throw new Error(`Plan node "${params.planNodeId}" is already dispatched.`);
      }
      if (node.childTaskId) {
        throw new Error(`Plan node "${params.planNodeId}" is already dispatched.`);
      }
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId
          ? { ...candidate, status: "dispatched" as const }
          : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: "confirmed",
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      publishPlansChanged(params);
    },
    /** 占位接续：把已创建的子任务挂到已占位（dispatched 且无 childTaskId）的节点上。
     * 未占位/已有绑定属编程性错误，抛错暴露而不是静默。无 active 计划静默跳过。 */
    async bindPlanNodeForSpawn(params) {
      const activeRow = await readActiveRow(params);
      if (!activeRow) return;
      const plan = rowToPlan(activeRow);
      const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node) throw new Error(`Unknown plan node "${params.planNodeId}".`);
      if (node.status !== "dispatched" || node.childTaskId) {
        throw new Error(
          `Plan node "${params.planNodeId}" was not reserved for spawn (status=${node.status}, childTaskId=${node.childTaskId ?? "null"}).`,
        );
      }
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId
          ? { ...candidate, childTaskId: params.childTaskId }
          : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: "confirmed",
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      publishPlansChanged(params);
    },
    /** 占位回滚：仅当节点仍处于 dispatched 且无 childTaskId（占位未被接续）才回 pending；
     * 已接续的节点由 sendPrompt 失败路径的既有语义处理，这里不碰。stale 标记在回滚中
     * 丢失（回 pending）可接受：stale 本就要经 MarkPlanNodesStale 复核。 */
    async releasePlanNodeReservation(params) {
      const activeRow = await readActiveRow(params);
      if (!activeRow) return;
      const plan = rowToPlan(activeRow);
      const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node || node.status !== "dispatched" || node.childTaskId) return;
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId
          ? { ...candidate, status: "pending" as const }
          : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: "confirmed",
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      publishPlansChanged(params);
    },
    async assertDispatchAllowed(params) {
      const [planMode, activeRow] = await Promise.all([readMode(params), readActiveRow(params)]);
      if (!planMode) return;
      if (activeRow) {
        const plan = rowToPlan(activeRow);
        if (plan.status === "confirmed") return;
        throw new Error(
          plan.status === "draft"
            ? `Plan "${plan.title}" is not confirmed by the user yet. Wait for the 【编排计划·确认】 message.`
            : `Plan "${plan.title}" is completed. Propose a revision via ProposeOrchestrationPlan for adjustments.`,
        );
      }
      throw new Error(
        "Plan mode is on but no plan is selected. Submit a complete plan via ProposeOrchestrationPlan first and wait for user confirmation.",
      );
    },
    async markPlanNodeTerminal(params) {
      // 遍历全部计划（bug 修复 2026-11-04 实测）：此前首匹配即 return——同一子任务在
      // 多个计划里都有绑定（老计划副本残留绑定很常见）时，终态写进遍历序靠前的老计划，
      // 当前活跃计划里刚派发的节点永远停在 dispatched（用户中断后节点卡"执行中"）。
      // 现在每个含匹配节点的计划都各自落库；返回本轮真实发生迁移的节点 id 集合，
      // 供自动派发扫描限定触发范围（上游完成只释放自己的下游）。
      const rows = await taskIndexRepo.listOrchestrationPlanRows(params);
      const finalStatus = params.outcome === "failed" ? "failed" : "terminal";
      const markedNodeIds = new Set<string>();
      let touched = false;
      for (const row of rows) {
        const plan = rowToPlan(row);
        const transitionedBefore = plan.nodes.filter(
          (candidate) =>
            candidate.childTaskId === params.childTaskId && candidate.status !== finalStatus,
        );
        if (transitionedBefore.length === 0) continue;
        const nodes = markNodeTerminalByChild(plan.nodes, params.childTaskId, params.outcome);
        if (!nodes) continue;
        await writePlanRow({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          orchestrationTaskId: params.orchestrationTaskId,
          planId: plan.planId,
          title: plan.title,
          status: deriveStatus(nodes, plan.status),
          nodes,
          version: plan.version,
          isActive: row.isActive,
          createdAt: plan.createdAt,
        });
        for (const node of transitionedBefore) markedNodeIds.add(node.nodeId);
        logger.info("Orchestration plan node terminal", {
          childTaskId: params.childTaskId,
          event: "orchestration.plan.node_terminal",
          markedNodeIds: [...transitionedBefore.map((node) => node.nodeId)],
          orchestrationTaskId: params.orchestrationTaskId,
          planId: plan.planId,
        });
        touched = true;
      }
      if (touched) publishPlansChanged(params);
      return { markedNodeIds: [...markedNodeIds] };
    },
    async clearPlanNodesForUnlinkedChild(params) {
      // 解链清绑定（用户需求 2026-11-04）：子任务与编排断开联系后，计划里对它的
      // 绑定失去意义（重新绑定会因无 link 被拒；派发/终态通道也一并断掉）——
      // 遍历全部计划清 binding+锁定；dispatched 回落 pending：脱离统筹的子任务
      // 终态不再回传，留着 dispatched 会永久卡住「继续执行」。terminal/failed
      // 是历史结果，保留不动。同版本落库 + 广播（画布 patchServerFacts 会把
      // 未被用户改过的缓冲绑定同步清掉，下拉候选列表墓碑过滤后也不再出现）。
      const rows = await taskIndexRepo.listOrchestrationPlanRows(params);
      let clearedPlans = 0;
      for (const row of rows) {
        const plan = rowToPlan(row);
        if (!plan.nodes.some((candidate) => candidate.childTaskId === params.childTaskId)) {
          continue;
        }
        const nodes = plan.nodes.map((candidate) =>
          candidate.childTaskId === params.childTaskId
            ? { ...candidate, childTaskId: null, childTaskLocked: false, status: candidate.status === "dispatched" ? ("pending" as const) : candidate.status }
            : candidate,
        );
        await writePlanRow({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          orchestrationTaskId: params.orchestrationTaskId,
          planId: plan.planId,
          title: plan.title,
          status: deriveStatus(nodes, plan.status),
          nodes,
          version: plan.version,
          isActive: row.isActive,
          createdAt: plan.createdAt,
        });
        clearedPlans += 1;
        logger.info("Orchestration plan bindings cleared for unlinked child", {
          childTaskId: params.childTaskId,
          event: "orchestration.plan.unlink_clear_bindings",
          orchestrationTaskId: params.orchestrationTaskId,
          planId: plan.planId,
        });
      }
      if (clearedPlans > 0) publishPlansChanged(params);
      return { clearedPlans };
    },
    async markPlanNodesStale(params) {
      const activeRow = await readActiveRow(params);
      if (!activeRow) throw new Error("No active plan to update.");
      const plan = rowToPlan(activeRow);
      const { nodes, updated } = applyStaleMarks(plan.nodes, params.nodeIds, params.stale);
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: deriveStatus(nodes, plan.status),
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      publishPlansChanged(params);
      return { updated };
    },
    /**
     * 显式绑定（BindOrchestrationPlanNodes 工具，spec: orchestration-plan.md）：
     * 手动关联的子任务没有 spawn 通道的 planNodeId，计划画布的执行可见性
     * （⧉ 子任务标题/状态灯/进度）依赖这里把 childTaskId 写进节点。
     * 绑定时按子任务 tasks-index 现状回填节点状态——用户常把已完成的
     * 历史任务关进来，不回填的话画布永远一片 pending（用户实测）。
     */
    async bindPlanNodesToChildren(params) {
      const activeRow = await readActiveRow(params);
      if (!activeRow) {
        throw new Error("No active plan to bind. Propose and confirm a plan first.");
      }
      const plan = rowToPlan(activeRow);
      if (plan.status !== "confirmed") {
        throw new Error(
          "Plan is not confirmed yet. Wait for the 【编排计划·确认】 message before binding.",
        );
      }
      const findNode = (planNodeId: string) =>
        plan.nodes.find((candidate) => candidate.nodeId === planNodeId);
      // 一个子任务允许挂多个节点（用户需求 2026-11-04）：批次内同一子任务重复出现
      // 视为重复操作（同一目标绑两次），不再拒绝。
      for (const binding of params.bindings) {
        const node = findNode(binding.planNodeId);
        if (!node) throw new Error(`Unknown plan node "${binding.planNodeId}".`);
        if (node.isStart) {
          throw new Error(
            "The start node is a structural marker and cannot be bound to a child task.",
          );
        }
        // 用户手动确定的绑定不可被 agent 改绑/解绑（用户需求 2026-10-30）；
        // 绑同一子任务 = no-op，放行走 no-op 短路。
        if (node.childTaskLocked && binding.childTaskId !== (node.childTaskId ?? null)) {
          throw new Error(
            `Plan node "${binding.planNodeId}" has a child task chosen by the user (${node.childTaskId}) and cannot be rebound. Send instructions to the existing child task instead.`,
          );
        }
        if (!binding.childTaskId) continue;
        // 同一子任务在批次内出现多次 = 对多个节点的重复绑定，允许多挂（用户需求
        // 2026-11-04），这里只登记用于幂等说明，不再拒绝。
      }
      // 全量校验通过后才动手：批量绑定半成功比整体拒绝更难向 agent 解释。
      const resolved = new Map<
        string,
        { childTaskId: string | null; status: OrchestrationPlanNode["status"]; locked: boolean }
      >();
      for (const binding of params.bindings) {
        const node = findNode(binding.planNodeId);
        if (!node || node.isStart) continue;
        if (binding.childTaskId === null) {
          resolved.set(binding.planNodeId, {
            childTaskId: null,
            status: "pending",
            locked: false,
          });
          continue;
        }
        const link = await taskIndexRepo.getOrchestrationLink({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          orchestrationTaskId: params.orchestrationTaskId,
          childTaskId: binding.childTaskId,
        });
        if (!link || link.unlinkedAt !== null) {
          throw new Error(
            `A bound child task is not linked to this orchestration (node "${binding.planNodeId}"). Link it first, then bind.`,
          );
        }
        // 绑定只记关联、不动节点状态（用户原则 2026-11-02：节点是否完成由节点自己的执行
        // 决定，不由子任务是否执行过决定）。此前按子任务当前状态回填——把已完成的历史任务
        // 绑上来会让没派发过的节点直接 terminal、整个计划"未执行先完成"（用户实测）。
        // 节点只在被派发、且派发的那轮执行完成时才变 terminal（markPlanNodeTerminal）。
        const status = node.status;
        // 锁定节点走到这里只可能是"同子任务 no-op"（变更已被上面整体拒绝），锁定原样保留；
        // agent 绑定自身永不落锁——锁定只由用户手动改绑产生（用户需求 2026-10-30）。
        const locked = node.childTaskLocked ?? false;
        resolved.set(binding.planNodeId, { childTaskId: binding.childTaskId, status, locked });
      }
      let updated = 0;
      const nodes = plan.nodes.map((candidate) => {
        const binding = resolved.get(candidate.nodeId);
        if (!binding) return candidate;
        if (
          candidate.childTaskId === binding.childTaskId &&
          candidate.status === binding.status &&
          (candidate.childTaskLocked ?? false) === binding.locked
        ) {
          return candidate;
        }
        updated += 1;
        return {
          ...candidate,
          childTaskId: binding.childTaskId,
          status: binding.status,
          childTaskLocked: binding.locked,
        };
      });
      if (updated === 0) return { updated: 0 };
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: deriveStatus(nodes, plan.status),
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      publishPlansChanged(params);
      return { updated };
    },
    /**
     * 用户手动改绑子任务（UI 画布/编辑器，用户需求 2026-10-30）：绑定即"确定"——
     * 落 childTaskLocked=true，此后主任务/agent 不可再改绑该节点；用户解绑（null）
     * 回到未确定态（锁清除，agent 可再关联）。门 = 节点未执行完成（terminal 不可改）。
     * 与 agent 绑定同源的状态回填/在册校验；写库后广播，返回最新 plansMap 供 UI 直更。
     */
    async markPlanNodeDispatched(params) {
      // 节点进入 dispatched 的唯一口径（spec 执行通道统一，用户需求 2026-11-02）：
      // SendChildTaskPrompt 带 planNodeId / UI 手动执行（有绑定子任务）共用。此前只有
      // SpawnSubTask 能让节点进 dispatched，给已有子任务下发的执行永远不被计划观察到。
      const activeRow = await readActiveRow(params);
      if (!activeRow) throw new Error("No active plan to execute. Confirm a plan first.");
      const plan = rowToPlan(activeRow);
      if (plan.status === "draft") {
        throw new Error("Plan is not confirmed yet. Wait for the 【编排计划·确认】 message.");
      }
      const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node) throw new Error(`Unknown plan node "${params.planNodeId}".`);
      if (node.isStart) {
        throw new Error("The start node is a structural marker and cannot be executed.");
      }
      // 用户手动确定的绑定不可被改派（同 spawn 规则）：只能向既定子任务下发。
      if (node.childTaskLocked && node.childTaskId && node.childTaskId !== params.childTaskId) {
        throw new Error(
          `Plan node "${params.planNodeId}" already has a child task chosen by the user (${node.childTaskId}). Send instructions to that existing child task instead.`,
        );
      }
      if (node.status === "dispatched") {
        throw new Error(
          `Plan node "${params.planNodeId}" is already executing; wait for its outcome before dispatching it again.`,
        );
      }
      // 一个子任务允许挂多个节点（用户需求 2026-11-04）：多挂节点可各自派发（同一
      // 子任务收到多轮指令），终态回报会把挂它的节点全部置 terminal。
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId
          ? { ...candidate, status: "dispatched" as const, childTaskId: params.childTaskId }
          : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        // 完成态计划重跑某节点后自然脱离 completed（读取时推导）。
        status: deriveStatus(nodes, "confirmed"),
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      logger.info("Orchestration plan node dispatched", {
        childTaskId: params.childTaskId,
        event: "orchestration.plan.node_dispatched",
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        planNodeId: params.planNodeId,
      });
      publishPlansChanged(params);
      return { previousStatus: node.status, previousChildTaskId: node.childTaskId ?? null };
    },
    async revertPlanNodeDispatch(params) {
      // 下发失败回滚（bug 修复 2026-11-03）：此前失败后节点保持 dispatched，而重派又被
      // "already executing" 拒绝，agent 把拒绝当成已派发——节点永远卡死且无回报在途。
      // 只回滚"仍是本次置的 dispatched + 同一 childTaskId"的节点，并发的新派发不受影响。
      const activeRow = await readActiveRow(params);
      if (!activeRow) return;
      const plan = rowToPlan(activeRow);
      const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node || node.status !== "dispatched" || node.childTaskId !== params.childTaskId) return;
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId
          ? {
              ...candidate,
              status: params.previousStatus,
              childTaskId: params.previousChildTaskId,
            }
          : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: deriveStatus(nodes, "confirmed"),
        nodes,
        version: plan.version,
        isActive: true,
        createdAt: plan.createdAt,
      });
      logger.warn("Orchestration plan node dispatch reverted", {
        childTaskId: params.childTaskId,
        event: "orchestration.plan.node_dispatch_reverted",
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        planNodeId: params.planNodeId,
        previousStatus: params.previousStatus,
      });
      publishPlansChanged(params);
    },
    async setPlanNodeManualDone(params) {
      // 手动完成滑块（用户需求 2026-11-02）：回报丢失/线下完成等容错场景由用户替节点定夺；
      // 开 → terminal，关 → pending，关联与锁定不动。
      const targetRow = params.planId
        ? ((await taskIndexRepo.listOrchestrationPlanRows(params)).find(
            (row) => row.planId === params.planId,
          ) ?? null)
        : await readActiveRow(params);
      if (!targetRow) throw new Error("No plan to update.");
      const plan = rowToPlan(targetRow);
      const node = plan.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node) throw new Error(`Unknown plan node "${params.planNodeId}".`);
      if (node.isStart) {
        throw new Error("The start node is a structural marker and has no completion state.");
      }
      const nextStatus = params.done ? ("terminal" as const) : ("pending" as const);
      if (node.status === nextStatus) return readPlans(params);
      const nodes = plan.nodes.map((candidate) =>
        candidate.nodeId === params.planNodeId ? { ...candidate, status: nextStatus } : candidate,
      );
      await writePlanRow({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        title: plan.title,
        status: deriveStatus(nodes, plan.status),
        nodes,
        version: plan.version,
        // 保留目标行自身选中标志（upsert 不维护唯一 active）。
        isActive: targetRow.isActive,
        createdAt: plan.createdAt,
      });
      logger.info("Orchestration plan node manual completion toggled", {
        done: params.done,
        event: "orchestration.plan.node_manual_done",
        orchestrationTaskId: params.orchestrationTaskId,
        planId: plan.planId,
        planNodeId: params.planNodeId,
      });
      publishPlansChanged(params);
      return readPlans(params);
    },
  };
}
