#!/usr/bin/env bash
# 桌面应用打包一键脚本（默认 mac/arm64）。会话实测经验固化（2026-11-11）：
# - 必须 Node ≥24（mise.toml pin 24.14）：低版本加载 vite 配置里直接 import 的
#   shared .ts 源码会报 ERR_UNKNOWN_FILE_EXTENSION ".ts"（构建起手即炸）。
# - ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向本地 provider 配置：绕开 CDN 缓存的
#   配置 schema 漂移（不设则构建早期校验失败）。
# - 不要用 `| tail` 等管道包裹本脚本：会把 pnpm 的非零退出码洗成 0
#   （实测拿着旧 dmg 当新包交过差）。
# 用法：scripts/package-desktop.sh [--os mac] [--arch arm64] [--dry-run]
#   其余参数原样透传 pnpm bundle:desktop。产物在 packages/desktop/dist/。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# ── Node ≥24 探测：nvm 安装的 v24.x 优先（取版本号最高的），其次 mise，最后当前 node。
current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$current_major" -lt 24 ]; then
  if compgen -G "$HOME/.nvm/versions/node/v24.*" > /dev/null; then
    node24_bin="$(ls -d "$HOME"/.nvm/versions/node/v24.* | sort -V | tail -1)/bin"
    export PATH="$node24_bin:$PATH"
  elif command -v mise >/dev/null 2>&1; then
    mise_bin="$(mise where node 2>/dev/null || true)"
    if [ -n "$mise_bin" ] && [ -x "$mise_bin/bin/node" ]; then
      export PATH="$mise_bin/bin:$PATH"
    fi
  fi
fi
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$major" -lt 24 ]; then
  echo "需要 Node ≥24（vite 配置直接 import shared 的 .ts 源码）；当前: ${major:-无}" >&2
  exit 1
fi

export ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=config/provider/zcode-builtin.json

if [ "${1:-}" = "--dry-run" ]; then
  echo "node $(node -v) @ $(command -v node)"
  echo "cd $root && pnpm bundle:desktop（参数: ${*:2}）"
  exit 0
fi

pnpm bundle:desktop "$@"
newest_dmg="$(ls -t packages/desktop/dist/*.dmg 2>/dev/null | head -1 || true)"
echo "打包完成。产物目录: $root/packages/desktop/dist/"
[ -n "$newest_dmg" ] && echo "最新 dmg: $newest_dmg"
