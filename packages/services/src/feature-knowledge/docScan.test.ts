// 文档扫描阶段单测（spec: feature-knowledge.md 分析现有文档入口 / >20 份两阶段）。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOC_SCAN_MAX_DOCS, readFeatureDocThemePlan, scanFeatureDocs } from "./docScan.js";

test("目录递归展开 md/txt、跳过 node_modules 与非文档扩展名", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-scan-"));
  try {
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "a.md"), "# 甲功能\n正文\n");
    await writeFile(join(root, "b.txt"), "乙功能标题\n正文\n");
    await writeFile(join(root, "c.ts"), "export {}\n");
    await writeFile(join(root, "sub", "d.md"), "# 丁功能\n");
    await writeFile(join(root, "node_modules", "pkg", "e.md"), "# 不该扫到\n");
    const result = await scanFeatureDocs([root], () => []);
    const paths = result.docs.map((doc) => doc.path).sort();
    assert.equal(result.total, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(paths, [join(root, "a.md"), join(root, "b.txt"), join(root, "sub", "d.md")].sort());
    assert.equal(result.docs.find((doc) => doc.path.endsWith("a.md"))?.title, "甲功能");
    assert.equal(result.docs.find((doc) => doc.path.endsWith("b.txt"))?.title, "b.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("候选归属来自注入的检索；文件路径与目录可混合", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-scan-"));
  try {
    await writeFile(join(root, "a.md"), "# 甲功能\n");
    const result = await scanFeatureDocs([join(root, "a.md"), root], () => [
      { feature: { id: "f1", name: "甲功能" }, layers: ["lexical"], score: 1 },
    ] as never);
    assert.equal(result.docs.length, 1);
    const entry = result.docs[0];
    assert.ok(entry);
    assert.deepEqual(entry.candidates, [{ featureId: "f1", name: "甲功能" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("超过展开上限标记 truncated 且只列上限份", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-scan-"));
  try {
    for (let index = 0; index < DOC_SCAN_MAX_DOCS + 5; index += 1) {
      await writeFile(join(root, `doc-${index}.md`), `# 标题${index}\n`);
    }
    const result = await scanFeatureDocs([root], () => []);
    assert.equal(result.truncated, true);
    assert.equal(result.docs.length, DOC_SCAN_MAX_DOCS);
    assert.equal(result.total, DOC_SCAN_MAX_DOCS + 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("主题计划读取：合法 JSON 通过、缺失/非法返回 null", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-plan-"));
  try {
    const planPath = join(root, "plan.json");
    assert.equal(await readFeatureDocThemePlan(planPath), null);
    await writeFile(planPath, "{bad json");
    assert.equal(await readFeatureDocThemePlan(planPath), null);
    await writeFile(
      planPath,
      JSON.stringify({
        themes: [
          { name: "主题甲", docPaths: ["/a.md", "/b.md"], features: [{ featureId: "f1", name: "甲功能" }] },
          { name: "主题乙", docPaths: ["/b.md"], features: [{ name: "新功能" }] },
        ],
      }),
    );
    const plan = await readFeatureDocThemePlan(planPath);
    assert.ok(plan);
    assert.equal(plan.themes.length, 2);
    const second = plan.themes[1];
    assert.ok(second);
    assert.deepEqual(second.features, [{ name: "新功能" }]);
    await writeFile(planPath, JSON.stringify({ themes: [{ name: 1 }] }));
    assert.equal(await readFeatureDocThemePlan(planPath), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
