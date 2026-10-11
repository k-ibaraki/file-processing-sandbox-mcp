import { describe, expect, test, vi } from "vitest";
import {
  assumeBedrockRole,
  toCredentialExport,
} from "../src/bedrock-credentials";

describe("toCredentialExport", () => {
  test("Claude Code の awsCredentialExport が読む形に整える", () => {
    const expiration = new Date("2026-10-12T01:00:00Z");
    expect(
      toCredentialExport({
        AccessKeyId: "AKIA_TEST",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: expiration,
      }),
    ).toEqual({
      Credentials: {
        AccessKeyId: "AKIA_TEST",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: "2026-10-12T01:00:00.000Z",
      },
    });
  });

  test("欠けた項目があれば拒否する", () => {
    expect(() =>
      toCredentialExport({ AccessKeyId: "AKIA_TEST", SecretAccessKey: "s" }),
    ).toThrow();
  });
});

describe("assumeBedrockRole", () => {
  test("Bedrock 専用ロールを指定の秒数で引き受ける", async () => {
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA_TEST",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2026-10-12T01:00:00Z"),
      },
    });
    const output = await assumeBedrockRole({ send } as never, {
      roleArn: "arn:aws:iam::000000000000:role/bedrock-only",
      durationSeconds: 900,
      sessionName: "job-01JOB",
    });

    const input = send.mock.calls[0]?.[0].input;
    expect(input).toEqual({
      RoleArn: "arn:aws:iam::000000000000:role/bedrock-only",
      RoleSessionName: "job-01JOB",
      DurationSeconds: 900,
    });
    expect(output.Credentials.AccessKeyId).toBe("AKIA_TEST");
  });
});
