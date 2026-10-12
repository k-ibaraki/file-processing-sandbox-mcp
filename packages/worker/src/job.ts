// 1 ジョブの流れ。入力の取得 → エージェントの実行 → 回答の保存 → 状態の更新 → 自己終了。
// 前処理とハートビートは実装ステップ 2 で足す。いまはエージェントに元のファイルをそのまま読ませる。

import type { RunRequest } from "./run-request";

export type JobStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export interface AgentResult {
  answer: string;
  /** 実測の記録（ターン数・トークン・使えた道具など） */
  report: Record<string, unknown>;
}

export interface JobDeps {
  getInstruction: (jobId: string) => Promise<string>;
  setStatus: (
    jobId: string,
    status: JobStatus,
    error?: string,
  ) => Promise<void>;
  downloadInputs: (jobId: string) => Promise<void>;
  runAgent: (instruction: string, request: RunRequest) => Promise<AgentResult>;
  putAnswer: (jobId: string, answer: string) => Promise<void>;
  putReport: (jobId: string, report: Record<string, unknown>) => Promise<void>;
  terminate: (microvmId: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runJob(
  deps: JobDeps,
  request: RunRequest,
): Promise<void> {
  const { jobId } = request;
  try {
    const instruction = await deps.getInstruction(jobId);
    await deps.setStatus(jobId, "RUNNING");
    await deps.downloadInputs(jobId);
    const result = await deps.runAgent(instruction, request);
    await deps.putAnswer(jobId, result.answer);
    await deps.putReport(jobId, { agent: result.report });
    await deps.setStatus(jobId, "SUCCEEDED");
  } catch (error) {
    // MicroVM の標準エラーは CloudWatch Logs に届かなかったため、標準出力に出す
    console.log(
      JSON.stringify({ event: "job-failed", jobId, error: String(error) }),
    );
    await deps
      .putReport(jobId, { error: message(error) })
      .catch((e) => console.log(`報告を保存できません: ${e}`));
    await deps
      .setStatus(jobId, "FAILED", message(error))
      .catch((e) => console.log(`FAILED を記録できません: ${e}`));
  }
  await deps.terminate(request.microvmId);
}
