// 前処理の外部コマンド（LibreOffice・poppler・ImageMagick・heif-convert）を実行する。

import { execFile } from "node:child_process";
import type { RunCommand } from "./preprocess";

/** 1 コマンドの制限時間。大きな文書の変換でも収まる長さにし、固まったときに止める */
const TIMEOUT_MS = 10 * 60_000;

/**
 * 前処理のコマンドに渡す環境変数。信頼できないファイルを読むコマンドなので、ワーカーの設定は渡さない。
 * イメージには UTF-8 のロケールが設定されておらず、LibreOffice が日本語のシート名を ??? にするため、ここで指定する
 */
export function commandEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

export function createRunCommand(): RunCommand {
  return (command, args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          timeout: TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024 * 1024,
          env: commandEnv(process.env),
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim().slice(-1000) || error.message;
            reject(new Error(`${command} が失敗しました: ${detail}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
}
