# 视觉委托（Vision Delegate）：非视觉主模型的图片描述代理

## 背景与问题

主模型 `inputFormat.supportsImage === false`（如 GLM-5.3 直连 API）时，请求组装层的
media capability projection 会把图片块替换成占位文本（`media-capability.ts` /
`media-policy.ts`），主模型对粘贴图、Read 读图、浏览器截图「失明」，只能靠自带 MCP
工具换回文字，体验割裂。

## 产品规则

1. Composer 工具栏：当前选中主模型 `supportsImage !== true` 时，在模型选择器右侧出现
   「视觉模型」下拉；主模型支持视觉时不显示。选项 = 模型注册表中 `supportsImage` 的模型。
2. 语义与主模型选择完全一致：点击只更新 renderer 草稿意图，随下一次提交（sendText /
   createSession envelope）生效；CLI 在 turn 开始时应用到 runtime 会话态并持久化。
3. 生效后，请求组装时对将被能力投影剔除的图片块：先由视觉模型单轮描述（无工具），
   把描述文本注入消息流替代图片块；主模型直接读到描述。
4. 失败回退：视觉模型不可用 / 超时 / 返回空 → 保持现状（占位文本），行为不劣化。
5. v1 范围：仅 image 块（PDF/video 不委托）；缓存为 runtime 内存态（按图片内容 hash，
   进程重启后首图重描述一次）；URL 型 / 本地路径型图片引用不拦截。

## 状态所有者与事件顺序

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 视觉模型选择（用户意图） | UI composer draft（composerDraftStore），随提交携带 | 与 modelSelection 同通道同语义 |
| 视觉模型选择（会话真值） | core runtime `sessionVisionDelegateSelection`（`setVisionDelegateSelection` 唯一写入口） | `applySubmissionExecutionState` 在 turn 开始应用 intent 时写入 |
| 持久化 | sessionStore entry `runtime/vision_delegate`（数据 = ModelSelection） | resume 时读回；写失败仅 warn 不阻断 |
| 描述缓存 | runtime 实例内 `Map<sha256(dataUrl), Promise<描述文本>>` | 并发去重；失败不缓存 |
| 注入点 | `runModelTextRequest`（methods/model.ts），`projectMessagesForInputFormat` 之前 | 唯一改写消息流的点，不新增第二条投影路径 |

```
用户贴图发送 → sendText { modelSelection, visionDelegateModel }
  → turn 开始 applySubmissionExecutionState：setVisionDelegateSelection + 持久化
  → runModelTextRequest：
      supportsImage=false 且 delegate 已配置 且 消息含 image 块
        → 逐图（hash 去重）调 generateWorkspaceText(delegate selection, [描述 prompt + image 块])
        → 成功：image 块 → text 块（带模型署名的描述）；失败：保留原块（走既有占位投影）
      → 既有 capability/budget projection 照常执行
```

描述调用复用 `generateWorkspaceText`（`runtime/methods/workspace-generate-text.ts`）：
`createRuntimeModel(this, { selection })` + `model.generateText`，带 60s 超时与
`runWithModelInvocationContext`（skipTranscript 语义），不经过 `runModelTextRequest`，无递归。

## 协议变更

- `zcode-protocol-v4/command.ts`：sendText / createSession payload 增加可选
  `visionDelegateModel?: { provider: string; model: string } | null`（null = 显式清除）。
- `TurnInputIntentMetadata`（contracts）增加 `visionDelegateSelection?: ModelSelection`。
- 不改 `ZCodeSessionSettingsState` 投影（v1 UI 从 draft 读显示值）。

## 验收场景

1. 主模型无视觉 + 已选视觉模型：贴图提问 → 主模型回答内容包含图中信息；日志出现描述调用记录。
2. 主模型无视觉 + 未选视觉模型：现状不变（占位文本）。
3. 主模型支持视觉：下拉不出现，图片直发。
4. 视觉模型配错 / 超时：回退占位文本，turn 不失败。
5. 同一图片第二次出现在后续轮次：命中缓存，无重复模型调用。
6. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
