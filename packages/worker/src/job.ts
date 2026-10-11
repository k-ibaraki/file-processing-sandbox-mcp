// 1 ジョブの流れ。入力の取得 → エージェントの実行 → 回答の保存 → 状態の更新 → 自己終了。
// 試作（実装ステップ 1）のため前処理とハートビートはまだ無く、エージェントには元のファイルをそのまま読ませる。

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
  /** 試作の観測。認証情報の在りかなどを調べる */
  probe: () => Promise<Record<string, unknown>>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runJob(
  deps: JobDeps,
  request: RunRequest,
): Promise<void> {
  const { jobId } = request;
  let probe: Record<string, unknown> | undefined;
  try {
    const instruction = await deps.getInstruction(jobId);
    await deps.setStatus(jobId, "RUNNING");
    probe = request.probe.collect ? await deps.probe() : undefined;
    await deps.downloadInputs(jobId);
    const result = await deps.runAgent(instruction, request);
    await deps.putAnswer(jobId, result.answer);
    await deps.putReport(jobId, { agent: result.report, probe });
    await deps.setStatus(jobId, "SUCCEEDED");
  } catch (error) {
    // 試作では MicroVM の標準エラーが CloudWatch Logs に届かなかったため、標準出力に出す
    console.log(
      JSON.stringify({ event: "job-failed", jobId, error: String(error) }),
    );
    await deps
      .putReport(jobId, { error: message(error), probe })
      .catch((e) => console.log(`報告を保存できません: ${e}`));
    await deps
      .setStatus(jobId, "FAILED", message(error))
      .catch((e) => console.log(`FAILED を記録できません: ${e}`));
  }
  if (!request.probe.skipTerminate) {
    await deps.terminate(request.microvmId);
  }
}
