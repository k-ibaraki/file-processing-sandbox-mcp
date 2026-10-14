import type { ProgressEvent } from "@sandbox-mcp/shared";
import { describe, expect, test, vi } from "vitest";
import { type JobDeps, runJob } from "../src/job";
import type { RunRequest } from "../src/run-request";

const request: RunRequest = {
  microvmId: "mvm-0001",
  jobId: "01JOB",
  modelId: "jp.anthropic.claude-sonnet-4-6",
};

function deps(overrides: Partial<JobDeps> = {}): JobDeps & {
  calls: string[];
  heartbeats: ProgressEvent[][];
} {
  const calls: string[] = [];
  const heartbeats: ProgressEvent[][] = [];
  // 呼ばれた順番を calls に残すモック
  const record = <T>(name: string, value?: T) =>
    vi.fn(async (..._args: unknown[]) => {
      calls.push(name);
      return value as T;
    });
  return {
    calls,
    heartbeats,
    getJob: record("getJob", {
      status: "RUNNING",
      instruction: "質問",
      progress: [],
    }),
    setStatus: record<void>("setStatus"),
    writeHeartbeat: vi.fn(async (_jobId: string, events: ProgressEvent[]) => {
      heartbeats.push(events);
    }),
    hasExtracted: record("hasExtracted", false),
    downloadExtracted: record<void>("downloadExtracted"),
    downloadInputs: record<void>("downloadInputs"),
    preprocess: vi.fn(async (onProgress: (m: string) => void) => {
      calls.push("preprocess");
      onProgress("前処理 1/1件: a.pdf");
      return [
        { name: "a.pdf", kind: "pdf" as const, outputs: [], warnings: [] },
      ];
    }),
    uploadExtracted: record<void>("uploadExtracted"),
    clearInputs: record<void>("clearInputs"),
    runAgent: vi.fn(
      async (_i: string, _r: RunRequest, onProgress: (m: string) => void) => {
        calls.push("runAgent");
        onProgress("a.pdf/pages/001.txt を読み込み中");
        return { answer: "回答", report: { numTurns: 2 } };
      },
    ),
    putAnswer: record<void>("putAnswer"),
    putReport: record<void>("putReport"),
    terminate: record<void>("terminate"),
    ...overrides,
  };
}

const messages = (events: ProgressEvent[] | undefined) =>
  (events ?? []).map((e) => e.message);

describe("runJob", () => {
  test("入力を前処理して結果を保存し、元のファイルを消してからエージェントを動かす", async () => {
    const d = deps();
    await runJob(d, request);
    expect(d.calls).toEqual([
      "getJob",
      "hasExtracted",
      "downloadInputs",
      "preprocess",
      "uploadExtracted",
      "clearInputs",
      "runAgent",
      "putAnswer",
      "putReport",
      "setStatus",
      "terminate",
    ]);
    expect(d.runAgent).toHaveBeenCalledWith(
      "質問",
      request,
      expect.any(Function),
    );
    expect(d.putAnswer).toHaveBeenCalledWith("01JOB", "回答");
    expect(d.setStatus).toHaveBeenLastCalledWith("01JOB", "SUCCEEDED");
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("前処理の結果が S3 にあれば、作り直さずに取得する", async () => {
    const d = deps({ hasExtracted: vi.fn().mockResolvedValue(true) });
    await runJob(d, request);
    expect(d.downloadExtracted).toHaveBeenCalledWith("01JOB");
    expect(d.downloadInputs).not.toHaveBeenCalled();
    expect(d.preprocess).not.toHaveBeenCalled();
    expect(d.setStatus).toHaveBeenLastCalledWith("01JOB", "SUCCEEDED");
  });

  test("前処理に失敗したファイルがあれば結果を保存せず、再実行で前処理をやり直せるようにする", async () => {
    // 保存すると _done.json の印で、一時的な失敗（タイムアウトなど）が以後の再実行にも使い回されるため
    const d = deps({
      preprocess: vi.fn(async () => [
        {
          name: "a.pdf",
          kind: "pdf" as const,
          outputs: [],
          warnings: [],
          error: "pdftotext が失敗しました",
        },
      ]),
    });
    await runJob(d, request);
    expect(d.uploadExtracted).not.toHaveBeenCalled();
    expect(d.runAgent).toHaveBeenCalled();
    expect(d.setStatus).toHaveBeenLastCalledWith("01JOB", "SUCCEEDED");
  });

  test("未対応の形式は、やり直しても結果が変わらないので、失敗に数えず結果を保存する", async () => {
    const d = deps({
      preprocess: vi.fn(async () => [
        {
          name: "a.exe",
          kind: "unsupported" as const,
          outputs: [],
          warnings: [],
          error: "対応していない形式です",
        },
      ]),
    });
    await runJob(d, request);
    expect(d.uploadExtracted).toHaveBeenCalledWith("01JOB");
  });

  test("完了の記録に失敗したときも、失敗の進捗を書く", async () => {
    // 完了の前に進捗を止めているが、その後の失敗も進捗に残す
    const d = deps({
      setStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("DynamoDB に届かない"))
        .mockResolvedValue(undefined),
    });
    await runJob(d, request);
    expect(messages(d.heartbeats.at(-1)).at(-1)).toBe(
      "失敗しました: DynamoDB に届かない",
    );
    expect(d.setStatus).toHaveBeenLastCalledWith(
      "01JOB",
      "FAILED",
      "DynamoDB に届かない",
    );
  });

  test("進捗をハートビートとして書き、完了を記録する前に最後の進捗を書く", async () => {
    const d = deps();
    await runJob(d, request);
    expect(messages(d.heartbeats.at(-1))).toEqual([
      "入力ファイルを取得中",
      "前処理 1/1件: a.pdf",
      "前処理の結果を保存中",
      "回答を作成中",
      "a.pdf/pages/001.txt を読み込み中",
      "回答を保存しました",
    ]);
  });

  test("前の実行の進捗の続きに書く", async () => {
    const d = deps({
      getJob: vi.fn().mockResolvedValue({
        status: "RUNNING",
        instruction: "別の質問",
        progress: [{ seq: 4, at: 0, message: "回答を保存しました" }],
      }),
    });
    await runJob(d, request);
    expect(d.heartbeats.at(-1)?.[1]?.seq).toBe(5);
  });

  test("前段 Lambda が RUNNING にしたジョブでなければ、何も書かずに自分を終了する", async () => {
    // 起動直後に delete_job で DELETED になったジョブを、ワーカーが上書きしないため
    const d = deps({
      getJob: vi.fn().mockResolvedValue({
        status: "DELETED",
        instruction: "質問",
        progress: [],
      }),
    });
    await runJob(d, request);
    expect(d.runAgent).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.writeHeartbeat).not.toHaveBeenCalled();
    expect(d.putReport).not.toHaveBeenCalled();
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("指示が無ければ FAILED と理由を記録する", async () => {
    const d = deps({
      getJob: vi.fn().mockResolvedValue({
        status: "RUNNING",
        instruction: undefined,
        progress: [],
      }),
    });
    await runJob(d, request);
    expect(d.setStatus).toHaveBeenLastCalledWith(
      "01JOB",
      "FAILED",
      expect.stringContaining("指示"),
    );
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("エージェントが失敗したら FAILED と理由を記録し、進捗にも残して、自分を終了する", async () => {
    const d = deps({
      runAgent: vi.fn().mockRejectedValue(new Error("Bedrock に届かない")),
    });
    await runJob(d, request);
    expect(d.setStatus).toHaveBeenLastCalledWith(
      "01JOB",
      "FAILED",
      "Bedrock に届かない",
    );
    expect(messages(d.heartbeats.at(-1)).at(-1)).toBe(
      "失敗しました: Bedrock に届かない",
    );
    expect(d.putAnswer).not.toHaveBeenCalled();
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("失敗の進捗は 1 行目だけを短く載せ、標準エラーの全文は載せない", async () => {
    const d = deps({
      runAgent: vi
        .fn()
        .mockRejectedValue(
          new Error(`エージェントが失敗しました\n[stderr] ${"x".repeat(3000)}`),
        ),
    });
    await runJob(d, request);
    expect(messages(d.heartbeats.at(-1)).at(-1)).toBe(
      "失敗しました: エージェントが失敗しました",
    );
    // 理由の全文は error と報告に残す
    expect(d.setStatus).toHaveBeenLastCalledWith(
      "01JOB",
      "FAILED",
      expect.stringContaining("[stderr]"),
    );
  });

  test("失敗したときも、理由を報告に残す", async () => {
    const d = deps({
      runAgent: vi.fn().mockRejectedValue(new Error("Bedrock に届かない")),
    });
    await runJob(d, request);
    expect(d.putReport).toHaveBeenCalledWith(
      "01JOB",
      expect.objectContaining({ error: "Bedrock に届かない" }),
    );
  });

  test("成功したときは前処理とエージェントの実測を報告に残す", async () => {
    const d = deps();
    await runJob(d, request);
    expect(d.putReport).toHaveBeenCalledWith(
      "01JOB",
      expect.objectContaining({
        reusedExtracted: false,
        files: [expect.objectContaining({ name: "a.pdf" })],
        timingsMs: {
          inputs: expect.any(Number),
          preprocess: expect.any(Number),
          agent: expect.any(Number),
        },
        agent: { numTurns: 2 },
      }),
    );
  });
});
