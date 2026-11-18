# Skill 目录发现与同名解析

约定双方：桌面/服务端 catalog（`packages/services/src/skills/skillsService.ts`）与 agent 端
（`apps/zcode-cli/packages/adapters/src/skills/` NodeSkillAdapter）。目录扫描的进入规则共享
自 `packages/shared/src/skill-scan-policy.ts`。

## 双根合并（2026-10-31 起）

workspace 与 user 两个级别都**同时扫描** `.zcode/skills` 与 `.agents/skills`（合并不是
fallback）：同层 `.zcode` 只要有一个技能就整根截断 `.agents`，会让外部 Agent 的全局技能
从设置页消失（skillsService `resolveAncestorWorkspaceRoots` 注释记录的发现语义分裂实测）。
只装在 `.agents` 的技能（如 gql-query、voucher 系列）必须继续可见。

## 同名解析（用户需求 2026-11-05"skill 重复只要 .zcode 的"）

同一技能（如 ai-novel-assistant）在 `~/.zcode/skills` 与 `~/.agents/skills` 各装一份时，
常驻 Skill 下拉出现两条重复。规则：

- **同 scope 内，`agents` 来源根的技能若已被 `zcode` 来源根的同名技能收录则跳过。**
  名称 key = frontmatter `name`（缺省回落目录名），trim + 小写。
- **只对 `source === "agents"` 生效**：plugin/bundled/remote/自定义根的同名技能（不同
  生态共存是合法安装形态）不受影响。
- 按根优先级顺序生效（低 priority 先扫先赢）：用户级 `~/.zcode/skills` 先于
  `~/.agents/skills`；workspace 级同层 `.zcode` 先于 `.agents`、更近目录先于更远目录。
  这是 `adapters/src/skills/roots.ts` "同一级别仍保持 `.zcode` 优先，后续同名按 root
  顺序解析"注释的落地（此前从未实现）。
- 两端口径一致：服务端 catalog 与 CLI adapter 必须同规则。服务端用户级另有前置快速
  检查 `isUserAgentsSkillCoveredByZcode`（目录命中或名称命中即跳过，省一次文件解析）；
  本规则是同口径的通用兜底 + workspace 级补齐。
- 跨 scope 同名共存不变（workspace foo + user foo 是合法的就近覆盖形态）。
- 会话权威：已有会话以 AgentRuntime 冻结快照为准，修复只对新会话生效（UI useSkills
  的 authority 语义）。
- 仅装在 `.agents` 的技能不受影响（无同名 `.zcode` 技能则不命中覆盖）。
