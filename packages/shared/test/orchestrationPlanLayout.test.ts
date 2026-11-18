import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMissingLayouts,
  computePlanLayout,
  fillMissingLayoutPositions,
  PLAN_LAYOUT_COLUMN_PITCH,
  PLAN_LAYOUT_ROW_PITCH,
  type PlanLayoutInputNode,
} from "../src/orchestrationPlanLayout.js";

function graph(...edges: [string, string[]][]): PlanLayoutInputNode[] {
  return edges.map(([nodeId, dependsOn]) => ({ nodeId, dependsOn }));
}

test("空输入返回空 Map", () => {
  assert.equal(computePlanLayout([]).size, 0);
});

test("线性链逐列右移，单列布局垂直居中在 y=0", () => {
  const positions = computePlanLayout(graph(["a", []], ["b", ["a"]], ["c", ["b"]]));
  assert.equal(positions.get("a")!.x, 0);
  assert.equal(positions.get("b")!.x, PLAN_LAYOUT_COLUMN_PITCH);
  assert.equal(positions.get("c")!.x, PLAN_LAYOUT_COLUMN_PITCH * 2);
  for (const id of ["a", "b", "c"]) assert.equal(positions.get(id)!.y, 0);
});

test("菱形定层正确，短列相对长列垂直居中", () => {
  const positions = computePlanLayout(
    graph(["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]),
  );
  // b/c 层 1：y = 0 / rowPitch；a/d 层 0/2：单节点列居中 → y = rowPitch / 2。
  assert.equal(positions.get("b")!.y, 0);
  assert.equal(positions.get("c")!.y, PLAN_LAYOUT_ROW_PITCH);
  assert.equal(positions.get("a")!.y, PLAN_LAYOUT_ROW_PITCH / 2);
  assert.equal(positions.get("d")!.y, PLAN_LAYOUT_ROW_PITCH / 2);
});

test("重心法消除交叉：定义顺序交叉的两条链重排后边平行", () => {
  // 定义顺序故意交叉：b1 依赖 a2、b2 依赖 a1（同层定义序 b1 在前）。
  const positions = computePlanLayout(
    graph(["a1", []], ["a2", []], ["b1", ["a2"]], ["b2", ["a1"]]),
  );
  // 排序后 b2（依赖排前的 a1）应排在 b1 上方，与 a1 同一水平线。
  assert.ok(positions.get("b2")!.y < positions.get("b1")!.y);
  assert.ok(positions.get("a1")!.y < positions.get("a2")!.y);
  assert.equal(positions.get("b2")!.y, positions.get("a1")!.y);
});

test("环图不挂起：环上节点收编层 0，独立节点正常", () => {
  const positions = computePlanLayout(graph(["a", ["b"]], ["b", ["a"]], ["c", []]));
  assert.equal(positions.size, 3);
  for (const position of positions.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
});

test("悬空依赖引用忽略：视作无上游", () => {
  const positions = computePlanLayout(graph(["a", ["ghost"]]));
  assert.equal(positions.get("a")!.x, 0);
});

test("自连依赖忽略，不产生额外层", () => {
  const positions = computePlanLayout(graph(["a", ["a"]]));
  assert.equal(positions.get("a")!.x, 0);
});

test("fillMissingLayoutPositions 只返回缺失节点，锚定位不动", () => {
  const nodes = [
    { nodeId: "a", dependsOn: [], layout: { x: 0, y: 0 } as const },
    { nodeId: "b", dependsOn: [] },
    { nodeId: "c", dependsOn: ["b"] },
  ];
  const positions = fillMissingLayoutPositions(nodes);
  assert.equal(positions.has("a"), false);
  assert.deepEqual(positions.get("b"), { x: 0, y: PLAN_LAYOUT_ROW_PITCH });
  assert.equal(positions.get("c")!.x, PLAN_LAYOUT_COLUMN_PITCH);
});

test("fillMissingLayoutPositions 补算位与锚定卡片碰撞时下移避让", () => {
  // b 计算槽 (0,0) 被锚定的 a 占住 → 下移一个行距腾空。
  const nodes = [
    { nodeId: "b", dependsOn: [] },
    { nodeId: "a", dependsOn: [], layout: { x: 0, y: 0 } as const },
  ];
  const positions = fillMissingLayoutPositions(nodes);
  assert.deepEqual(positions.get("b"), { x: 0, y: PLAN_LAYOUT_ROW_PITCH });
});

test("fillMissingLayoutPositions 全部缺失时全量分层", () => {
  const positions = fillMissingLayoutPositions(
    graph(["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]),
  );
  assert.equal(positions.size, 4);
  assert.equal(positions.get("d")!.x, PLAN_LAYOUT_COLUMN_PITCH * 2);
});

test("applyMissingLayouts 全部已有 layout 时返回原数组引用", () => {
  const nodes = [
    { nodeId: "a", dependsOn: [], layout: { x: 1, y: 2 } },
    { nodeId: "b", dependsOn: ["a"], layout: { x: 3, y: 4, w: 200 } },
  ];
  assert.equal(applyMissingLayouts(nodes), nodes);
});

test("applyMissingLayouts 只补缺失节点且保持已有节点引用不变", () => {
  const a = { nodeId: "a", dependsOn: [], layout: { x: 1, y: 2 } };
  const b = { nodeId: "b", dependsOn: ["a"] };
  const result = applyMissingLayouts([a, b]);
  assert.equal(result[0], a);
  assert.notEqual(result[1], b);
  // b 与 a 不同层（列距错开），补算位 (columnPitch, 0) 不与锚定的 a (1,2) 碰撞。
  assert.deepEqual(result[1]!.layout, { x: PLAN_LAYOUT_COLUMN_PITCH, y: 0 });
});

test("同输入两次调用结果一致（确定性）", () => {
  const input = graph(
    ["a", []],
    ["b", []],
    ["c", ["a", "b"]],
    ["d", ["a"]],
    ["e", ["c", "d"]],
    ["f", ["b"]],
    ["g", ["e", "f"]],
  );
  const first = computePlanLayout(input);
  const second = computePlanLayout(input);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});
