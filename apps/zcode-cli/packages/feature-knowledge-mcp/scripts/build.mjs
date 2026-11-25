import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// esm 产物的 __require shim 在 ESM 作用域没有 require 可用；store 经 createRequire 取 node:sqlite，
// 注入真实 createRequire 兜底（先例 node-repl-host/scripts/build.mjs）。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export const buildFeatureKnowledgeMcpBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  return { outfile };
};

// Windows argv[1] 与 import.meta.url 路径形态不同，用 pathToFileURL 比较（先例 node-repl-host）。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildFeatureKnowledgeMcpBundle();
  console.log(`[feature-knowledge-mcp] ${outfile}`);
}