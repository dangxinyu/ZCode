# 编排计划画布：自动整理布局（梳理 + 创建时遵守）

## Context

用户现有计划（如"全体子任务点名"17 节点）画布连线交叉严重：当前唯一布局逻辑 `autoPosition`（`OrchestrationPlanCanvasNodes.tsx:378-411`）按最长路径定层，但**层内按节点定义顺序堆叠**，完全不考虑连线关系，边必然打结；用户拖过的节点更散。另外 agent 通过 `ProposeOrchestrationPlan` 创建计划时协议不带坐标，服务端新建分支也不算布局（`orchestrationPlanService.ts:465-469`），落库后全靠 UI 弱兜底。

目标：① 画布加"整理布局"一键梳理；② agent 创建计划时按同一算法落库坐标；③ 渲染兜底升级为同一算法。

## 方案：一个纯算法 + 三个接入点

### A. 新算法模块 `packages/shared/src/orchestrationPlanLayout.ts`（无新依赖，~120 行）

经典三阶段分层 DAG 布局（左→右流向），纯函数零依赖：

```ts
export interface PlanLayoutInputNode { nodeId: string; dependsOn: string[] }
export interface PlanLayoutOptions {
  fixed?: Map<string, { x: number; y: number }>; // 已有布局节点保持不动（修订补缺用）
  columnPitch?: number; // 默认 320
  rowPitch?: number;    // 默认 200（现 176，卡片加高后留白）
}
export function computePlanLayout(nodes, options?): Map<string, { x: number; y: number }>
export function applyMissingLayouts<T extends { nodeId; dependsOn; layout? }>(nodes: T[]): T[]
// applyMissingLayouts：只给缺 layout 的节点补坐标（服务端修订/新建共用），fixed = 已有 layout
```

1. **定层**：最长路径分层（Kahn 拓扑序迭代）。防御性断环：拓扑序无法覆盖的节点按剩余入度截断归层 0（proposePlan 有 `validatePlanGraph` 拦环，但画布编辑缓冲中间态/存量数据不保证无环，算法绝不死循环）。
2. **层内排序（关键改进）**：重心法（barycenter）——4 轮 down/up 交替扫描，每节点排序键 = 相邻层邻居当前序位的平均值，并列时按原序稳定排序。这是消除连线交叉的核心。
3. **坐标分配**：`x = layer × columnPitch`；层内纵向等距 `rowPitch` 堆叠，**每列相对最高列垂直居中**（经典 DAG 观感，平均边长最短）。

确定性输出（同输入同结果），空输入返回空 Map。

`packages/shared/package.json` exports 加 `"./orchestration-plan-layout": "./src/orchestrationPlanLayout.ts"`（仿照现有 `"./plan-identity"` 条目）。UI 与 services 均已依赖 `@zcode/shared`，架构方向合法（shared 是最底层）。

### B. UI 接入（3 点）

1. **渲染兜底升级** `packages/ui/src/hooks/useOrchestrationPlanCanvasEditor.ts` `buildFlowNodes`（L43-47）：删除对 `autoPosition` 的引用，改调 `computePlanLayout(graph, { fixed: 已保存 layout 的节点位置 })`——存量"部分节点有坐标"的计划，缺坐标节点也落在合理位置而不是和已保存节点互相压盖。`OrchestrationPlanCanvasNodes.tsx` 里的 `autoPosition`（L377-411）删除（唯一使用方就是这里）。
2. **整理动作** hook 新增 `tidyLayout()`：`pushHistory(base)` → 用编辑缓冲 `data.dependsOn` 全量重算 `computePlanLayout` → 位置写回 flow 节点 → `setEditNodesBoth` + `setDirty(true)`。天然接入现有撤销栈（⌘Z 可退）与保存通道（`toSavePayload` 直接读 position），**不自动保存**，与拖动行为一致。
3. **工具栏按钮** `packages/ui/src/OrchestrationPlanPageToolbar.tsx`：撤销/重做组（L108）与保存按钮之间加"整理布局"按钮（lucide `SparklesIcon`），`editable` 时显示、`busy || !hasNodes` 禁用；新 prop `onTidyLayout`，`OrchestrationPlanPage.tsx` 组装传 `editor.tidyLayout`。i18n：`zh-CN.ts` L1306 区段 + `en-US.ts` L1405 区段各加 `orchestration.plan.tidyLayout`（"整理布局" / "Tidy layout"）。

### C. 服务端接入 `packages/services/src/zcode-agent/orchestrationPlanService.ts` `proposePlan`

- **新建分支**（L465）：`proposed`（已经过 `wireRootsToStart(withStartNode(...))`，start 是第 0 层根）整体过 `applyMissingLayouts` 后再落库——agent 创建的计划 v1 就是整齐坐标。
- **修订分支**（L384-391）：`revisePlanNodes` 结果同样过 `applyMissingLayouts`——**只补新增/缺坐标节点**（含注入的 start 种子），存量用户拖过的布局一律不动（守住 spec L351"布局必须透传"约定）；fixed 位置参与碰撞规避（计算位与 fixed 矩形重叠时向下顺移 rowPitch 直到无碰撞）。
- 修订分支注入 start 种子的硬编码 `{x:60,y:60}`（L389）保留（视为已有 layout）。

### D. spec 先行（AGENTS.md 要求）

`packages/services/specs/orchestration-plan.md`：
- 更新"卡片尺寸与自动布局"节（L409-410）：步长改 320/200，补算法三阶段描述；
- 追加用户需求记录（2026-11-04）：整理布局按钮语义（全量重排、入撤销栈、随保存落库不自动存）、新建全量落库 / 修订只补缺不覆盖、渲染兜底 fixed 语义。

### E. 测试 `packages/shared/test/orchestrationPlanLayout.test.ts`（node:test + node:assert/strict，仿 `packages/services/test/*.test.ts` 现有模式，仓库无统一 test 脚本、直接 `node --test` 运行）

用例：线性链单列递增；菱形分层正确；**交叉消除**（定义顺序故意交叉的两条链，重排后层内顺序交换）；fixed 保持不动 + 缺失节点避让；环不挂起；空输入；垂直居中。

## 验证

1. `pnpm typecheck`、`pnpm lint`（根目录）
2. `node --test packages/shared/test/orchestrationPlanLayout.test.ts`
3. `pnpm architecture:check -- --changed`
4. dev:web 实测（vite HMR 生效，server 无需重启——services 改动会被 tsup watch 重建）：打开用户截图中的乱计划 → 点"整理布局"→ 边明显有序 → 保存 → 刷新页面确认坐标已落库；再让 agent 新建一个计划 → 画布打开即是整齐布局。

## 不做的事

- 不引 dagre/elkjs 等新依赖（百行纯函数足够，保持仓库零布局依赖现状）
- 整理不自动保存、不动节点宽高（w/h 只读）、不提供"仅整理未拖动节点"的混合模式（撤销栈 + 保存已覆盖该场景）
- 不做纵向流向/折叠分组（当前需求是消除交叉）