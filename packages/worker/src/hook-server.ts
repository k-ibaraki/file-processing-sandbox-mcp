// MicroVM のライフサイクルフックを受ける HTTP サーバー。Lambda はコンテナのネットワーク越しに呼ぶので 0.0.0.0 で待ち受ける。

import { createServer, type IncomingMessage, type Server } from "node:http";
import { parseRunRequest, type RunRequest } from "./run-request";

export const HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1";

export interface HookHandlers {
  /** ジョブを始める。終わりは待たない */
  onRun: (request: RunRequest) => Promise<void> | void;
  /** 未完了のジョブを FAILED にする。制限時間内に終える */
  onTerminate: () => Promise<void> | void;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function createHookServer(handlers: HookHandlers): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    switch (req.url) {
      case `${HOOK_PATH_PREFIX}/ready`:
        res.writeHead(200).end();
        return;
      case `${HOOK_PATH_PREFIX}/run`: {
        let request: RunRequest;
        try {
          request = parseRunRequest(body);
        } catch (error) {
          console.error("/run の本文を読めません", error);
          res.writeHead(400).end();
          return;
        }
        Promise.resolve(handlers.onRun(request)).catch((error) =>
          console.error("ジョブが異常終了しました", error),
        );
        res.writeHead(200).end();
        return;
      }
      case `${HOOK_PATH_PREFIX}/terminate`:
        try {
          await handlers.onTerminate();
        } catch (error) {
          console.error("/terminate の処理に失敗しました", error);
        }
        res.writeHead(200).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
}
