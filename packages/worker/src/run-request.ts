// /run フックの本文。Lambda が microvmId と、run-microvm の --run-hook-payload の文字列を JSON で渡してくる。

/** 試作（実装ステップ 1）の実機確認だけに使う試験オプション。検証が済んだら消す */
export interface ProbeOptions {
  /** Bash サンドボックスで enableWeakerNestedSandbox を有効にする */
  weakerNestedSandbox?: boolean;
  /** Bedrock 専用の認証情報の有効秒数（再発行の確認用に短くする） */
  credentialSeconds?: number;
  /** 自己終了しない（アイドルポリシーの確認用） */
  skipTerminate?: boolean;
  /** ワーカー側で認証情報の在りかなどを観測し、報告に入れる */
  collect?: boolean;
  /** Claude Code のデバッグログを報告に入れる */
  debug?: boolean;
  /** Bash サンドボックスの autoAllowBashIfSandboxed を明示する（既定値は true） */
  autoAllowBashIfSandboxed?: boolean;
  /** Bash サンドボックスの denyRead から /proc を外す */
  allowProc?: boolean;
}

export interface RunRequest {
  microvmId: string;
  jobId: string;
  modelId: string;
  probe: ProbeOptions;
}

const PROBE_TYPES = {
  weakerNestedSandbox: "boolean",
  credentialSeconds: "number",
  skipTerminate: "boolean",
  collect: "boolean",
  debug: "boolean",
  autoAllowBashIfSandboxed: "boolean",
  allowProc: "boolean",
} as const;

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

function parseProbe(value: unknown): ProbeOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("probe はオブジェクトで指定します");
  const probe: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(PROBE_TYPES)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== type) {
      throw new Error(`probe.${key} は ${type} で指定します`);
    }
    probe[key] = value[key];
  }
  return probe as ProbeOptions;
}

export function parseRunRequest(body: string): RunRequest {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed))
    throw new Error("本文が JSON オブジェクトではありません");
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
    probe: parseProbe(payload.probe),
  };
}
