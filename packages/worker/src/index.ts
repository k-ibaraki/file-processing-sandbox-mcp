// MicroVM 内のワーカー。ライフサイクルフックを受け、制限付き Claude Code で 1 ジョブを最後まで実行する。

import { createDeps, readConfig } from "./aws-deps";
import { createHookServer } from "./hook-server";
import { runJob } from "./job";

const HOOK_PORT = 9000;

const config = readConfig(process.env);
const deps = createDeps(config);
let runningJobId: string | undefined;

const server = createHookServer({
  onRun: async (request) => {
    console.log(
      JSON.stringify({ event: "run", microvmId: request.microvmId, request }),
    );
    runningJobId = request.jobId;
    try {
      await runJob(deps, request);
    } finally {
      runningJobId = undefined;
    }
  },
  onTerminate: async () => {
    console.log(JSON.stringify({ event: "terminate", runningJobId }));
    if (runningJobId) {
      await deps.setStatus(runningJobId, "FAILED", "MicroVM が終了されました");
    }
  },
});

server.listen(HOOK_PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listening", port: HOOK_PORT }));
});
