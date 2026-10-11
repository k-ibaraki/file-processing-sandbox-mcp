import { describe, expect, test, vi } from "vitest";
import { type JobDeps, runJob } from "../src/job";
import type { RunRequest } from "../src/run-request";

const request: RunRequest = {
  microvmId: "mvm-0001",
  jobId: "01JOB",
  modelId: "jp.anthropic.claude-sonnet-4-6",
  probe: {},
};

function deps(overrides: Partial<JobDeps> = {}): JobDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  // 呼ばれた順番を calls に残すモック
  const record = <T>(name: string, value?: T) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return value as T;
    });
  return {
    calls,
    getInstruction: record("getInstruction", "質問"),
    setStatus: record<void>("setStatus"),
    downloadInputs: record<void>("downloadInputs"),
    runAgent: record("runAgent", { answer: "回答", report: { numTurns: 2 } }),
    putAnswer: record<void>("putAnswer"),
    putReport: record<void>("putReport"),
    terminate: record<void>("terminate"),
    probe: record("probe", { imds: "reachable" } as Record<string, unknown>),
    ...overrides,
  };
}

describe("runJob", () => {
  test("入力を取得してエージェントを動かし、回答を保存して SUCCEEDED にし、自分を終了する", async () => {
    const d = deps();
    await runJob(d, request);
    expect(d.calls.map((c) => c.split(":")[0])).toEqual([
      "getInstruction",
      "setStatus",
      "downloadInputs",
      "runAgent",
      "putAnswer",
      "putReport",
      "setStatus",
      "terminate",
    ]);
    expect(d.setStatus).toHaveBeenNthCalledWith(1, "01JOB", "RUNNING");
    expect(d.runAgent).toHaveBeenCalledWith("質問", request);
    expect(d.putAnswer).toHaveBeenCalledWith("01JOB", "回答");
    expect(d.setStatus).toHaveBeenLastCalledWith("01JOB", "SUCCEEDED");
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("エージェントが失敗したら FAILED と理由を記録し、それでも自分を終了する", async () => {
    const d = deps({
      runAgent: vi.fn().mockRejectedValue(new Error("Bedrock に届かない")),
    });
    await runJob(d, request);
    expect(d.setStatus).toHaveBeenLastCalledWith(
      "01JOB",
      "FAILED",
      "Bedrock に届かない",
    );
    expect(d.putAnswer).not.toHaveBeenCalled();
    expect(d.terminate).toHaveBeenCalledWith("mvm-0001");
  });

  test("失敗したときも、理由と観測結果を報告に残す", async () => {
    const d = deps({
      runAgent: vi.fn().mockRejectedValue(new Error("Bedrock に届かない")),
    });
    await runJob(d, { ...request, probe: { collect: true } });
    expect(d.putReport).toHaveBeenCalledWith("01JOB", {
      error: "Bedrock に届かない",
      probe: { imds: "reachable" },
    });
  });

  test("試験オプションがあれば、ワーカー側の観測結果も報告に入れる", async () => {
    const d = deps();
    await runJob(d, { ...request, probe: { collect: true } });
    expect(d.probe).toHaveBeenCalledOnce();
    expect(d.putReport).toHaveBeenCalledWith(
      "01JOB",
      expect.objectContaining({
        probe: { imds: "reachable" },
        agent: { numTurns: 2 },
      }),
    );
  });

  test("試験オプションで自己終了を止められる", async () => {
    const d = deps();
    await runJob(d, { ...request, probe: { skipTerminate: true } });
    expect(d.terminate).not.toHaveBeenCalled();
  });
});
