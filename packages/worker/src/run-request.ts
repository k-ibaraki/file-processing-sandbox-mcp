// /run フックの本文。Lambda が microvmId と、run-microvm の --run-hook-payload の文字列を JSON で渡してくる。
// --run-hook-payload は CLI の制約では 4096 文字まで（ドキュメントの 16KB とは食い違う）。ジョブ ID とモデル ID だけを渡す。

export interface RunRequest {
  microvmId: string;
  jobId: string;
  modelId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where} に ${key} がありません`);
  }
  return value;
}

export function parseRunRequest(body: string): RunRequest {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("本文が JSON オブジェクトではありません");
  }
  const microvmId = requireString(parsed, "microvmId", "本文");
  const payload: unknown = JSON.parse(
    requireString(parsed, "runHookPayload", "本文"),
  );
  if (!isRecord(payload)) {
    throw new Error("runHookPayload が JSON オブジェクトではありません");
  }
  return {
    microvmId,
    jobId: requireString(payload, "jobId", "runHookPayload"),
    modelId: requireString(payload, "modelId", "runHookPayload"),
  };
}
