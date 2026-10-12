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
});
