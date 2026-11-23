import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelConfigRules, type ModelConfig, type ProviderConfigSnapshot } from "@zcode/provider";
import { OFFICIAL_GLM_MODEL_IDS, normalizeOfficialGlmModelId } from "@zcode/shared";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

// 加载仓库内真实的 Built-in 兜底配置做验收，spec 见
// packages/provider-node/specs/official-glm-model-onboarding.md。
// 能力数字取自官方远端配置 revision 47 对 GLM-5.4 的裁决结果。
const MODEL_ID = "GLM-5.4";
const PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const TEMPLATES = ["zai-api", "bigmodel-api", "zai-standard-api", "bigmodel-standard-api"];
const PROVIDERS = [
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:zai-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan",
];

interface PlainModelConfig {
  enabled?: boolean;
  properties?: {
    contextWindow?: number;
    inputFormat?: Record<string, boolean | undefined>;
  };
  optionSpecs?: {
    reasoningLevel?: { values?: string[] };
    maxOutputTokens?: { max?: number };
  };
}

function plain(config: ModelConfig): PlainModelConfig {
  return JSON.parse(JSON.stringify(config.toJSON())) as PlainModelConfig;
}

function pick(config: PlainModelConfig) {
  return {
    contextWindow: config.properties?.contextWindow,
    pdf: config.properties?.inputFormat?.supportsPdf,
    reasoning: config.optionSpecs?.reasoningLevel?.values,
  };
}

/** 与 ProviderSettingsFacade.resolveModelConfig 同一条解析路径：Built-in 规则叠加 Personal 精确规则。 */
function resolveModel(
  snapshot: ProviderConfigSnapshot,
  input: { providerId: string; templateId?: string; modelId: string },
): ModelConfig {
  const provider = snapshot.zcodeBuiltinProviders.get(input.providerId);
  return ModelConfigRules.composeEffective(
    snapshot.zcodeBuiltinModelRules,
    snapshot.personalModels,
  ).resolve({
    providerId: input.providerId,
    templateId:
      input.templateId ?? snapshot.zcodeBuiltinProviders.getRule(input.providerId)?.templateId,
    modelId: input.modelId,
    apiType: provider?.api?.type,
    baseUrl: provider?.api?.baseUrl,
  });
}

/** Personal 配置落临时目录，不读写用户数据，也不触发远端同步。 */
async function withBuiltinSnapshot(run: (snapshot: ProviderConfigSnapshot) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-builtin-glm54-"));
  setDataBaseDir(dir);
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "personal.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }),
  );
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(configDir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    await runtime.start();
    run(await runtime.configService.read());
  } finally {
    runtime.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("GLM-5.4 is listed and enabled wherever the official release offers it", async () => {
  await withBuiltinSnapshot((snapshot) => {
    for (const providerId of PROVIDERS) {
      assert.ok(
        snapshot.zcodeBuiltinProviders.get(providerId)?.builtinModelIds?.includes(MODEL_ID),
        providerId,
      );
      assert.equal(
        snapshot.zcodeBuiltinModelRules.getExactRule(providerId, MODEL_ID)?.config.enabled,
        true,
        providerId,
      );
    }
    for (const templateId of TEMPLATES) {
      assert.ok(
        snapshot.zcodeBuiltinProviderTemplates
          .get(templateId)
          ?.config.builtinModelIds?.includes(MODEL_ID),
        templateId,
      );
      assert.equal(
        plain(
          resolveModel(snapshot, { providerId: "template-probe", templateId, modelId: MODEL_ID }),
        ).enabled,
        true,
        templateId,
      );
    }
  });
});

test("GLM-5.4 resolves to the official capability set, not the legacy GLM-5 fallback", async () => {
  await withBuiltinSnapshot((snapshot) => {
    const resolved = resolveModel(snapshot, { providerId: PROVIDER_ID, modelId: MODEL_ID });
    const config = plain(resolved);
    assert.equal(config.properties?.contextWindow, 1_000_000);
    assert.equal(config.properties?.inputFormat?.supportsImage, true);
    assert.equal(config.properties?.inputFormat?.supportsVideo, true);
    assert.equal(config.properties?.inputFormat?.supportsPdf, true);
    assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["low", "high", "max"]);
    assert.equal(config.optionSpecs?.maxOutputTokens?.max, 128_000);
    assert.equal(config.enabled, true);
    assert.deepEqual(resolved.validateComplete(["providers", PROVIDER_ID, "models", MODEL_ID]), []);
  });
});

test("other GLM-5 family models keep their existing resolution", async () => {
  await withBuiltinSnapshot((snapshot) => {
    // 套餐端点下所有模型的图片/视频都由按站点匹配的 provider-site 桥接规则（modelMatch ".*"）打开，
    // supportsImage 在这里不具区分度；用上下文、思考档位和 PDF 区分各模型自己的规则。
    const resolve = (modelId: string): PlainModelConfig =>
      plain(resolveModel(snapshot, { providerId: PROVIDER_ID, modelId }));
    assert.deepEqual(pick(resolve("GLM-5")), {
      contextWindow: 200_000,
      pdf: false,
      reasoning: ["disabled", "enabled"],
    });
    assert.deepEqual(pick(resolve("GLM-5.2")), {
      contextWindow: 1_000_000,
      pdf: false,
      reasoning: ["disabled", "high", "max"],
    });
    assert.deepEqual(pick(resolve("GLM-5.3")), {
      contextWindow: 1_000_000,
      pdf: false,
      reasoning: ["low", "high", "max"],
    });
  });
});

test("GLM-5.4 is part of the official GLM model id whitelist", () => {
  assert.ok(OFFICIAL_GLM_MODEL_IDS.includes(MODEL_ID));
  assert.equal(normalizeOfficialGlmModelId("glm-5.4"), MODEL_ID);
});
