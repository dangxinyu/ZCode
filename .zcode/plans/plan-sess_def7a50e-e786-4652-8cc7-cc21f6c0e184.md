# 任务目录子条目：直接展示/修改计划节点完成状态

## 现状与结论（探索确认）

- 子任务行（`OrchestrationChildrenList.tsx`）行首圆点目前只反映**子任务自身 status**（running/error/completed），不是计划节点状态；用户要看/改的是**计划节点**的完成状态，每次都得点开计划画布。
- 服务端**专用命令已存在**：`setOrchestrationPlanNodeManualDone`（画布"手动完成"滑块同款通道）——done=true→terminal 并触发下游就绪扫描；done=false→pending 不触发。**零服务端改动**。
- 侧栏已拉好 `plansByParentId`（`useOrchestrationPlans`），`OrchestrationChildrenList` 已收到 `plansMap` prop——子任务↔节点反查可在前端内存 join（按节点 `childTaskId === 子任务 taskId`），零新增查询。
- 服务端变更统一 `publishPlansChanged` 广播 → `bumpOrchestrationPlanVersion` → 画布/计划列表自动重拉，同步机制现成。

## 改动清单（全部在 packages/ui + spec + i18n）

### 1. 反查纯函数（新文件 `packages/ui/src/lib/orchestrationChildPlanNode.ts`）

`resolveChildPlanNode(plansMap, childTaskId)`：遍历 `plansMap.plans[].nodes` 按 `childTaskId` 匹配；**activePlanId 命中优先**，其余计划次之（多计划残留绑定场景取第一个命中）；返回 `{ planId, node } | null`。

### 2. 子任务行（`OrchestrationChildrenList.tsx`）

- **行首圆点升级**：节点命中时按节点状态配色（复用画布语义：terminal→`bg-success`、failed→`bg-status-error`、stale→`bg-warning`、pending→`bg-foreground-subtlest`、dispatched→`bg-status-running`），title/aria-label 显示节点状态文案；未命中节点保持现有子任务 status 圆点。转圈逻辑不动（phase 优先，节点状态只决定"非转圈时"的颜色）。
- **行尾新增完成 toggle 按钮**（放 ↗ 之前，hover 显现，与现有按钮同款样式）：非 terminal → `CircleCheck` 图标，点击标完成（done=true）；terminal → 实心 `CircleCheck`（fill），点击取消完成（done=false）。点击调新 prop `onToggleNodeDone({ planId, planNodeId, done })`。未命中节点的子任务不渲染该按钮。`planBusy` 期间禁用防连点。
- 副作用语义与画布一致：标完成会自动释放直接下游（这是画布同款行为，spec 已定稿），取消完成不触发。

### 3. hook（`hooks/useOrchestrationPlans.ts`）

- `OrchestrationPlanTaskService` 接口加 `setOrchestrationPlanNodeManualDone` 方法签名；
- 新增返回 `setNodeManualDone` action（仿 `renamePlan` 的 `runMutation` 模式：调命令 → 用返回的 plansMap 局部更新 `plansByParentId` → `bumpOrchestrationPlanVersion()` 广播全端）。

### 4. 调用方接线（`WorkspaceTimelineTasksSection.tsx` + `WorkspacePinnedTasksSection.tsx`，同构）

- `useOrchestrationPlans` 解构加 `setNodeManualDone`；
- `OrchestrationChildrenList` 传 `onToggleNodeDone`：`runPlanAction(item.taskId, () => setNodeManualDone({ orchestrationTaskId: item.taskId, workspacePath, ...identity, planId, planNodeId, done }))`，失败走现有 runPlanAction 错误处理（对齐 rename/delete 的报错方式）。

### 5. i18n（`zh-CN.ts` / `en-US.ts`）

- 节点状态 tooltip 文案：待执行/执行中/已完成/待复核/失败（优先复用画布现有 `orchestration.plan.node*` 状态键，缺再新增）；
- 按钮 aria-label/title：标记完成 / 取消完成。

### 6. spec 先行（`packages/services/specs/orchestration-plan.md`）

追加用户需求记录（2026-11-18）：任务目录子条目直接展示/修改节点状态；展示口径 activePlanId 优先；修改复用 `setOrchestrationPlanNodeManualDone` 及其非对称副作用语义（开=terminal+下游扫描、关=pending 不触发）；纯前端 join、零新增服务端查询。

## 验证

1. `pnpm typecheck` + `pnpm lint`
2. dev:web 实测：目录子条目行首圆点按节点状态着色（完成绿/失败红/执行中蓝转圈/待复核黄）→ hover 行尾出现完成按钮 → 点击标完成 → 计划进度 done/total 与画布同步刷新（广播）→ 再点取消完成 → 画布回 pending
3. 边界：无计划关联的子任务行保持原样；关联节点在非 active 计划时仍可展示/操作

## 不做的事

- 不动服务端（命令、副作用、广播全部复用）
- 不做行内文字徽标（圆点配色 + title 足够，行保持紧凑）
- 不改"执行"入口（执行仍在画布/主任务侧，目录行只管完成状态）