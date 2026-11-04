import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // Rules of Hooks：两条取数路径必须都无条件执行、再按 workspacePath 选结果。
  // 条件化调用会在 workspacePath 首渲缺席、次渲出现时改变 hook 序列，
  // 直接把调用组件打进 hooks-order 崩溃（OnboardingDialog 实测命中）。
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const fallbackServices = useServices();
  const services = workspacePath ? workspaceServices : fallbackServices;
  return services.zcodeSessionService;
}
