// MicroVM イメージのビルドに渡す zip の中身を作る。ワーカーを esbuild でまとめ、Dockerfile と並べる。
// Agent SDK だけは esbuild でまとめず、イメージの中で npm install する（決定12）。

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";
const workerDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/worker",
);

export function workerImagePackageJson(workerPackage: {
  dependencies?: Record<string, string>;
}): string {
  const version = workerPackage.dependencies?.[AGENT_SDK];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `${AGENT_SDK} の版を packages/worker/package.json で固定してください（現在: ${version}）`,
    );
  }
  return JSON.stringify(
    {
      name: "worker-image",
      private: true,
      type: "module",
      dependencies: { [AGENT_SDK]: version },
    },
    null,
    2,
  );
}

export function bundleWorkerImage(outputDir: string): void {
  buildSync({
    entryPoints: {
      index: join(workerDir, "src/index.ts"),
      "export-credentials": join(workerDir, "src/export-credentials.ts"),
    },
    outdir: outputDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: [AGENT_SDK],
    // AWS SDK の一部は CommonJS の require を使うため、ESM の中で require を使えるようにする
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  copyFileSync(
    join(workerDir, "image/Dockerfile"),
    join(outputDir, "Dockerfile"),
  );
  const workerPackage = JSON.parse(
    readFileSync(join(workerDir, "package.json"), "utf8"),
  );
  writeFileSync(
    join(outputDir, "package.json"),
    workerImagePackageJson(workerPackage),
  );
}
