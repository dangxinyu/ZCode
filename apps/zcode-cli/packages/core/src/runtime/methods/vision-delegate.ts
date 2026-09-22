// 视觉委托（vision delegate）：主模型 inputFormat.supportsImage=false 时，
// 在请求组装处用配置的视觉模型单轮描述图片，把描述文本注入消息流替代图片块。
// 失败一律回退（保留原块，由既有 capability projection 换占位文本），不得阻断 turn。
import { createHash } from "node:crypto";
import type {
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { generateWorkspaceText } from "./workspace-generate-text.js";

// deps.js 桶文件未导出 ModelImageContentBlock；从联合类型提取，避免绕过桶文件直接依赖 contracts。
type ModelImageContentBlock = Extract<ModelMessageContentBlock, { type: "image" }>;

const VISION_DELEGATE_QUERY_SOURCE = "vision_delegate";
const VISION_DELEGATE_TIMEOUT_MS = 60_000;

const VISION_DELEGATE_SYSTEM = [
  "你是图片描述助手。用户的主对话模型无法直接查看图片，你的描述将代替图片提供给它。",
  "请用与用户消息相同的语言输出结构化描述：1) 图片类型与主题；2) 图中所有可见文字（尽量逐字转录并保留排版关系）；",
  "3) 关键视觉内容与布局；4) 与软件任务相关的细节（UI 元素、报错信息、代码片段、数据数值等）。",
  "只输出描述本身，不要寒暄，不要猜测图片之外的信息。",
].join("");

export interface VisionDelegateProjection {
  messages: ModelInputMessage[];
  describedImageCount: number;
  failedImageCount: number;
}

interface ImageBlockTarget {
  messageIndex: number;
  blockIndex: number;
  block: ModelImageContentBlock;
}

export async function applyVisionDelegateDescriptions(
  runtime: AgentRuntimeInternal,
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
  traceContext: TraceContext,
): Promise<VisionDelegateProjection> {
  if (inputFormat.supportsImage) {
    return { messages, describedImageCount: 0, failedImageCount: 0 };
  }
  const selection = runtime.getVisionDelegateSelection();
  if (!selection) {
    return { messages, describedImageCount: 0, failedImageCount: 0 };
  }

  const targets = collectImageBlockTargets(messages);
  if (targets.length === 0) {
    return { messages, describedImageCount: 0, failedImageCount: 0 };
  }

  const describeImage = (block: ModelImageContentBlock): Promise<string> => {
    // hash 只用于进程内去重缓存；同一图片在后续轮次不重复调用委托模型。
    const hash = createHash("sha256").update(block.dataUrl).digest("hex");
    const cached = runtime.visionDelegateDescriptionCache.get(hash);
    if (cached) return cached;
    const attempt = generateWorkspaceText
      .call(runtime, {
        selection,
        querySource: VISION_DELEGATE_QUERY_SOURCE,
        messages: [
          { role: "system", content: VISION_DELEGATE_SYSTEM },
          {
            role: "user",
            content: [block, { type: "text", text: "请描述这张图片。" }],
          },
        ],
      })
      .then((result) => {
        const text = result.text.trim();
        if (!text) {
          throw new Error("vision delegate returned empty description");
        }
        return text;
      });
    runtime.visionDelegateDescriptionCache.set(hash, attempt);
    // 失败不缓存：下一次携带同一图片的请求允许重试。
    void attempt.catch(() => runtime.visionDelegateDescriptionCache.delete(hash));
    return attempt;
  };

  const descriptions = new Map<string, string>();
  let failedImageCount = 0;
  await Promise.all(
    targets.map(async (target) => {
      try {
        const description = await describeImage(target.block);
        descriptions.set(blockTargetKey(target), description);
      } catch (error) {
        failedImageCount += 1;
        runtime.logger?.warn("Vision delegate image description failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "model.request.vision_delegate_describe_failed",
          module: "core.runtime",
          status: "failed",
        });
      }
    }),
  );
  if (descriptions.size === 0) {
    // 全部失败：保留原消息，走既有占位投影，行为与未配置委托一致。
    return { messages, describedImageCount: 0, failedImageCount };
  }

  const describedImageCount = descriptions.size;
  const projected = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block, blockIndex) => {
      const description = descriptions.get(`${messageIndex}:${blockIndex}`);
      if (description === undefined) return block;
      changed = true;
      const projectedBlock: ModelMessageContentBlock = {
        type: "text",
        text: `[图片已由视觉模型 ${selection.modelId} 转述，原图未发送给当前模型]\n${description}`,
      };
      return projectedBlock;
    });
    return changed ? { ...message, content } : message;
  });
  runtime.logger?.info("Vision delegate projected images to descriptions", {
    describedImageCount,
    event: "model.request.vision_delegate_projected",
    failedImageCount,
    module: "core.runtime",
    status: "completed",
  });
  return { messages: projected, describedImageCount, failedImageCount };
}

function collectImageBlockTargets(messages: ModelInputMessage[]): ImageBlockTarget[] {
  const targets: ImageBlockTarget[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type === "image" && typeof block.dataUrl === "string" && block.dataUrl) {
        targets.push({ messageIndex, blockIndex, block });
      }
    });
  });
  return targets;
}

function blockTargetKey(target: ImageBlockTarget): string {
  return `${target.messageIndex}:${target.blockIndex}`;
}
