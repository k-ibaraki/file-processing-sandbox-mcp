// ジョブの状態・DynamoDB 項目・S3 のキーなど、gateway・cleanup・worker が共有する型と定数。

/** ジョブの状態。遷移は DESIGN.md の「状態一覧」を参照 */
export type JobStatus =
  | "CREATED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "DELETED";

/** 入力ファイル。URL の取り込みは後の段階で作る */
export interface JobInput {
  name: string;
  kind: "upload" | "url" | "inline";
  url?: string;
  size?: number;
}

/** 進捗イベント。前段 Lambda は seq を見て、まだ通知していないものだけを流す */
export interface ProgressEvent {
  seq: number;
  /** 記録した時刻（エポックミリ秒） */
  at: number;
  message: string;
}

/** Jobs テーブルの項目（パーティションキー job_id、GSI は owner と created_at） */
export interface JobItem {
  job_id: string;
  owner: string;
  created_at: number;
  status: JobStatus;
  title?: string;
  instruction?: string;
  inputs: JobInput[];
  microvm_id?: string;
  progress: ProgressEvent[];
  heartbeat_at?: number;
  error?: string;
  ttl: number;
}

/** 項目に残す進捗イベントの数 */
export const MAX_PROGRESS_EVENTS = 50;
/** ワーカーがハートビートと進捗を書く間隔 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** これより長くハートビートが途絶えた RUNNING のジョブを、掃除用 Lambda が FAILED にする */
export const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;

/** 進捗イベントを 1 件足し、直近の MAX_PROGRESS_EVENTS 件を返す。連番は前の続きから振る */
export function appendProgress(
  events: readonly ProgressEvent[],
  message: string,
  at: number,
): ProgressEvent[] {
  const seq = (events.at(-1)?.seq ?? 0) + 1;
  return [...events, { seq, at, message }].slice(-MAX_PROGRESS_EVENTS);
}

/** ジョブごとの S3 のキー */
export function jobKeys(jobId: string) {
  const prefix = `jobs/${jobId}/`;
  return {
    prefix,
    input: `${prefix}input/`,
    extracted: `${prefix}extracted/`,
    /** 前処理の結果がそろったことを示す印。最後に置き、再実行ではこれを見て前処理を省く */
    extractedDone: `${prefix}extracted/_done.json`,
    answer: `${prefix}answer.md`,
    logs: `${prefix}logs/`,
  };
}
