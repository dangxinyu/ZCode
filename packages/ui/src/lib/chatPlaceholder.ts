type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskOrchestration"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
  /** 编排草稿（draftCreateSource=orchestration）：无历史时换编排专用 placeholder。 */
  isOrchestrationDraft?: boolean;
}): ChatPlaceholderMessageKey {
  const {
    compactNewTask = false,
    hasHistoryMessages,
    isTaskProcessing,
    isOrchestrationDraft = false,
  } = options;

  // 按语义分流：
  // 1) 无历史 -> newTask（编排草稿换编排变体，输入时即可区分要创建的任务类型）
  // 2) 有历史且空闲 -> followUpAsk
  // 3) 有历史且处理中 -> followUpQueue
  if (!hasHistoryMessages) {
    if (isOrchestrationDraft) return "chat.placeholder.newTaskOrchestration";
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing ? "chat.placeholder.followUpQueue" : "chat.placeholder.followUpAsk";
}
