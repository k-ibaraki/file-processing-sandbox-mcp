// 1 ジョブの流れ。入力の取得 → エージェントの実行 → 回答の保存 → 状態の更新 → 自己終了。
// 前処理とハートビートは実装ステップ 2 で足す。いまはエージェントに元のファイルをそのまま読ませる。

import type { RunRequest } from "./run-request";

/** ワーカーが書く状態。RUNNING にするのは前段 Lambda（run_job）の役割 */
export type FinishedStatus = "SUCCEEDED" | "FAILED";

export interface JobRecord {
  status: string | undefined;
  instruction: string | undefined;
}

export interface AgentResult {
  answer: string;
  /** 実測の記録（ターン数・トークン・使えた道具など） */
  report: Record<string, unknown>;
}

export interface JobDeps {
  getJob: (jobId: string) => Promise<JobRecord>;
  setStatus: (
    jobId: string,
    status: FinishedStatus,
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

async function processJob(
  deps: JobDeps,
  request: RunRequest,
  instruction: string | undefined,
): Promise<void> {
  const { jobId } = request;
  if (!instruction) throw new Error(`ジョブ ${jobId} に指示がありません`);
  await deps.downloadInputs(jobId);
  const result = await deps.runAgent(instruction, request);
  await deps.putAnswer(jobId, result.answer);
  await deps.putReport(jobId, { agent: result.report });
  await deps.setStatus(jobId, "SUCCEEDED");
}

export async function runJob(
  deps: JobDeps,
  request: RunRequest,
): Promise<void> {
  const { jobId } = request;
  try {
    const job = await deps.getJob(jobId);
    if (job.status === "RUNNING") {
      await processJob(deps, request, job.instruction);
    } else {
      // 起動直後に削除されたジョブなど。状態は書き換えずに終了する
      console.log(
        JSON.stringify({ event: "job-skipped", jobId, status: job.status }),
      );
    }
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
