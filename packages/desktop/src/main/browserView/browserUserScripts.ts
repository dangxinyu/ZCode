// 内置浏览器用户脚本（userscripts）注入。
// Electron <webview> guest 不支持 Chrome 扩展体系（篡改猴装不上）；这里在 guest 的
// CDP 会话建立时用 Page.addScriptToEvaluateOnNewDocument 挂一个引导脚本，在页面脚本
// 之前按 location 匹配 ==UserScript== 元数据并执行正文（document-start 语义）。
// 脚本文件即配置：{zcodeDataRoot}/userscripts/*.user.js，无 UI、无持久化、无 IPC。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";

interface UserScriptPattern {
  /** 正则字面量的 source，如 ^https?:\/\/...（已在主进程预编译验证过合法）。 */
  source: string;
  flags: string;
}

interface UserScriptEntry {
  name: string;
  patterns: UserScriptPattern[];
  code: string;
}

export function resolveUserScriptsDir(): string {
  return join(getZCodeDataRootDir(), "userscripts");
}

/** 读取并解析 userscripts 目录；目录缺失/为空返回 undefined（功能未启用）。 */
export async function loadUserScriptEntries(log?: (message: string) => void): Promise<UserScriptEntry[] | undefined> {
  const dir = resolveUserScriptsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return undefined;
  }
  const entries: UserScriptEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".user.js")) continue;
    try {
      const content = await readFile(join(dir, file), "utf8");
      const entry = parseUserScript(file, content);
      if (entry) entries.push(entry);
    } catch (error) {
      log?.(`[userscripts] 读取失败，跳过 ${file}: ${String(error)}`);
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/** 解析 ==UserScript== 元数据；缺 @match/@include 或正则非法返回 undefined。 */
function parseUserScript(fileName: string, content: string): UserScriptEntry | undefined {
  const headerMatch = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(content);
  if (!headerMatch?.[1] || headerMatch.index < 0) return undefined;
  const patterns: UserScriptPattern[] = [];
  let name = fileName;
  let codeStart = headerMatch.index + headerMatch[0].length;
  for (const line of headerMatch[1].split("\n")) {
    const field = /^\s*\/\/\s*@(name|match|include)\s+(.+)$/.exec(line);
    const value = field?.[2]?.trim();
    if (!field?.[1] || !value) continue;
    if (field[1] === "name") {
      name = value;
      continue;
    }
    const pattern = compilePattern(value);
    if (pattern) patterns.push(pattern);
  }
  if (patterns.length === 0) return undefined;
  return { name, patterns, code: content.slice(codeStart) };
}

/** @match/@include 值 → 正则：/regex/flags 字面量原样用；其余按 glob（* → .*）转正则。 */
function compilePattern(value: string): UserScriptPattern | undefined {
  const literal = /^\/(.+)\/([gimsuy]*)$/.exec(value);
  const source = literal?.[1];
  if (source === undefined) {
    const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return { source: escaped, flags: "i" };
  }
  try {
    // 预编译验证；flags 里的 g 对 test 无意义，剥掉避免无谓状态。
    const flags = (literal?.[2] ?? "").replace("g", "");
    new RegExp(source, flags);
    return { source, flags };
  } catch {
    return undefined;
  }
}

/**
 * 生成注入页面的引导脚本。纯字符串拼接，最后一个表达式无返回值要求；
 * 页面上下文里自防重入（同一文档 CDP 只 add 一次，这里再兜一层）。
 */
export function buildUserScriptsBootstrap(entries: UserScriptEntry[]): string {
  const payload = JSON.stringify(
    entries.map((entry) => ({
      name: entry.name,
      patterns: entry.patterns,
      code: entry.code,
    })),
  );
  return `(function () {
  if (window.__zcodeUserScripts) return;
  window.__zcodeUserScripts = true;
  var scripts = ${payload};
  var url = location.href;
  for (var i = 0; i < scripts.length; i++) {
    var s = scripts[i];
    var matched = false;
    for (var j = 0; j < s.patterns.length; j++) {
      try {
        if (new RegExp(s.patterns[j].source, s.patterns[j].flags).test(url)) { matched = true; break; }
      } catch (e) {}
    }
    if (!matched) continue;
    try {
      (0, eval)(s.code);
      console.info("[userscripts] injected " + s.name);
    } catch (e) {
      console.error("[userscripts] " + s.name + " failed", e);
    }
  }
})();`;
}
