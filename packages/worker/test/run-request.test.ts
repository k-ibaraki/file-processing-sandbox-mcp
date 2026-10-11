import { describe, expect, test } from "vitest";
import { parseRunRequest } from "../src/run-request";

function body(payload: unknown, microvmId = "mvm-0001"): string {
  return JSON.stringify({
    microvmId,
    runHookPayload: JSON.stringify(payload),
  });
}

describe("parseRunRequest", () => {
  test("microvmId とペイロードのジョブ ID・モデル ID を取り出す", () => {
    const request = parseRunRequest(
      body({ jobId: "01JOB", modelId: "jp.anthropic.claude-sonnet-4-6" }),
    );
    expect(request).toEqual({
      microvmId: "mvm-0001",
      jobId: "01JOB",
      modelId: "jp.anthropic.claude-sonnet-4-6",
      probe: {},
    });
  });

  test("試作用の試験オプションを受け取る", () => {
    const request = parseRunRequest(
      body({
        jobId: "01JOB",
        modelId: "m",
        probe: {
          weakerNestedSandbox: true,
          credentialSeconds: 900,
          skipTerminate: true,
          debug: true,
          autoAllowBashIfSandboxed: true,
          allowProc: true,
        },
      }),
    );
    expect(request.probe).toEqual({
      weakerNestedSandbox: true,
      credentialSeconds: 900,
      skipTerminate: true,
      debug: true,
      autoAllowBashIfSandboxed: true,
      allowProc: true,
    });
  });

  test("JSON でない本文は拒否する", () => {
    expect(() => parseRunRequest("not json")).toThrow();
  });

  test("ペイロードにジョブ ID が無ければ拒否する", () => {
    expect(() => parseRunRequest(body({ modelId: "m" }))).toThrow(/jobId/);
  });

  test("ペイロードにモデル ID が無ければ拒否する", () => {
    expect(() => parseRunRequest(body({ jobId: "01JOB" }))).toThrow(/modelId/);
  });

  test("microvmId が無ければ拒否する", () => {
    expect(() =>
      parseRunRequest(
        JSON.stringify({ runHookPayload: '{"jobId":"j","modelId":"m"}' }),
      ),
    ).toThrow(/microvmId/);
  });

  test("試験オプションの型が違えば拒否する", () => {
    expect(() =>
      parseRunRequest(
        body({ jobId: "j", modelId: "m", probe: { credentialSeconds: "900" } }),
      ),
    ).toThrow(/credentialSeconds/);
  });
});
