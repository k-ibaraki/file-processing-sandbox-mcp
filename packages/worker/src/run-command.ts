// 前処理の外部コマンド（LibreOffice・poppler・ImageMagick・heif-convert）を実行する。

import { execFile } from "node:child_process";
import type { RunCommand } from "./preprocess";

/** 1 コマンドの制限時間。大きな文書の変換でも収まる長さにし、固まったときに止める */
const TIMEOUT_MS = 10 * 60_000;

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
          // イメージには UTF-8 のロケールが設定されておらず、LibreOffice が日本語のシート名を ??? にするため
          env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
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
