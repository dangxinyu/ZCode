import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      <ZCodeStartupLogo className="h-auto w-14" animated={animated} />
    </div>
  );
}

function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 256 218"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}<path fill="currentColor" d="M54.87593375601857 0.0H154.95369637539102Q184.54578368780574 0.0 200.75991107561615 8.030013642564796Q216.97403846342655 16.060027285129593 225.12567286547215 31.07912687585265Q233.27730726751776 46.09822646657571 233.66245759558393 66.02455661664392Q234.0476079236501 85.95088676671213 228.48619885613851 108.25648021828104Q219.77332465037034 143.2019099590723 207.01631315769242 162.45907230559345Q194.2593016650145 181.7162346521146 176.88827052297242 194.72783083219645Q159.51723938093033 207.7394270122783 142.23330238640472 212.0518417462483Q118.5933704731765 218.0 100.6001917555776 218.0H0.5224291362051616ZM109.92957391033094 49.36971350613916 80.23164948981898 168.48158253751706H96.73778864397997Q117.85375044479851 168.48158253751706 127.9438837296035 163.7974079126876Q138.0340170144085 159.11323328785812 146.00042227542852 147.4399727148704Q153.96682753644853 135.7667121418827 160.49221417566218 109.59481582537518Q169.13093626053018 74.9467939972715 161.0179767771086 62.15825375170533Q152.90501729368702 49.36971350613916 126.7331209771795 49.36971350613916Z" />
    </svg>
  );
}
