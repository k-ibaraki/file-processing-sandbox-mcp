// 1 ジョブの流れ。入力の取得と前処理（または前回の結果の取得）→ エージェントの実行 → 回答の保存 → 状態の更新 → 自己終了。
// その間、ハートビートと進捗を DynamoDB に書く。

import { HEARTBEAT_INTERVAL_MS, type ProgressEvent } from "@sandbox-mcp/shared";
import type { FileSummary } from "./preprocess";
import { ProgressReporter } from "./progress";
import type { RunRequest } from "./run-request";

/** ワーカーが書く状態。RUNNING にするのは前段 Lambda（run_job）の役割 */
export type FinishedStatus = "SUCCEEDED" | "FAILED";

export interface JobRecord {
  status: string | undefined;
  instruction: string | undefined;
  progress: ProgressEvent[];
}

export interface AgentResult {
  answer: string;
  /** 実測の記録（ターン数・トークン・使えた道具など） */
  report: Record<string, unknown>;
}

type OnProgress = (message: string) => void;

export interface JobDeps {
  getJob: (jobId: string) => Promise<JobRecord>;
  setStatus: (
    jobId: string,
    status: FinishedStatus,
    error?: string,
  ) => Promise<void>;
  /** ハートビートの時刻と進捗を書く。RUNNING のときだけ */
  writeHeartbeat: (jobId: string, progress: ProgressEvent[]) => Promise<void>;
  /** 前回の実行で前処理の結果を S3 に保存したか */
  hasExtracted: (jobId: string) => Promise<boolean>;
  downloadExtracted: (jobId: string) => Promise<void>;
  downloadInputs: (jobId: string) => Promise<void>;
  preprocess: (onProgress: OnProgress) => Promise<FileSummary[]>;
  uploadExtracted: (jobId: string) => Promise<void>;
  /** 元のファイルを手元から消す。エージェントには前処理の結果だけを見せる（決定23） */
  clearInputs: () => Promise<void>;
  runAgent: (
    instruction: string,
    request: RunRequest,
    onProgress: OnProgress,
  ) => Promise<AgentResult>;
  putAnswer: (jobId: string, answer: string) => Promise<void>;
  putReport: (jobId: string, report: Record<string, unknown>) => Promise<void>;
  terminate: (microvmId: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 処理にかかった時間を測る */
async function timed<T>(
  timings: Record<string, number>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    timings[key] = Date.now() - started;
  }
}

async function processJob(
  deps: JobDeps,
  request: RunRequest,
  instruction: string | undefined,
  reporter: ProgressReporter,
  report: Record<string, unknown>,
): Promise<void> {
  const { jobId } = request;
  if (!instruction) throw new Error(`ジョブ ${jobId} に指示がありません`);
  const timings: Record<string, number> = {};
  report.timingsMs = timings;
  const onProgress = (m: string) => reporter.add(m);

  report.reusedExtracted = await deps.hasExtracted(jobId);
  if (report.reusedExtracted) {
    // 再実行では前処理を作り直さない。省けるのは前処理の時間だけで、モデルは毎回読み直す
    reporter.add("前回の前処理の結果を取得中");
    await timed(timings, "inputs", () => deps.downloadExtracted(jobId));
  } else {
    reporter.add("入力ファイルを取得中");
    await timed(timings, "inputs", () => deps.downloadInputs(jobId));
    const files = await timed(timings, "preprocess", () =>
      deps.preprocess(onProgress),
    );
    report.files = files;
    // 失敗したファイルがあれば保存しない。保存すると _done.json の印で、一時的な失敗（タイムアウトなど）が
    // 以後の再実行にも使い回される。未対応の形式はやり直しても結果が変わらないので、失敗に数えない
    const complete = files.every((f) => !f.error || f.kind === "unsupported");
    report.savedExtracted = complete;
    if (complete) {
      reporter.add("前処理の結果を保存中");
      await deps.uploadExtracted(jobId);
    }
  }
  await deps.clearInputs();

  reporter.add("回答を作成中");
  const result = await timed(timings, "agent", () =>
    deps.runAgent(instruction, request, onProgress),
  );
  report.agent = result.report;
  await deps.putAnswer(jobId, result.answer);
  await deps.putReport(jobId, report);
  reporter.add("回答を保存しました");
  // 完了を書いた後は RUNNING でなくなりハートビートを書けないので、先に最後の進捗を書く
  await reporter.stop();
  await deps.setStatus(jobId, "SUCCEEDED");
}

export async function runJob(
  deps: JobDeps,
  request: RunRequest,
): Promise<void> {
  const { jobId } = request;
  let reporter: ProgressReporter | undefined;
  const report: Record<string, unknown> = {};
  try {
    const job = await deps.getJob(jobId);
    if (job.status === "RUNNING") {
      reporter = new ProgressReporter(
        (events) => deps.writeHeartbeat(jobId, events),
        job.progress,
      );
      reporter.start(HEARTBEAT_INTERVAL_MS);
      await processJob(deps, request, job.instruction, reporter, report);
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
    // 進捗は呼び出し側に通知として流れるので、理由の 1 行目だけを載せる。全文は error と報告に残す
    reporter?.add(
      `失敗しました: ${message(error).split("\n")[0]?.slice(0, 200)}`,
    );
    await reporter?.stop();
    await deps
      .putReport(jobId, { ...report, error: message(error) })
      .catch((e) => console.log(`報告を保存できません: ${e}`));
    await deps
      .setStatus(jobId, "FAILED", message(error))
      .catch((e) => console.log(`FAILED を記録できません: ${e}`));
  }
  await reporter?.stop();
  await deps.terminate(request.microvmId);
}
