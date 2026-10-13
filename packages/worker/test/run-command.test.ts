import { describe, expect, test } from "vitest";
import { commandEnv, createRunCommand } from "../src/run-command";

describe("commandEnv", () => {
  test("実行に要る変数と UTF-8 のロケールだけを渡し、ワーカーの設定や認証情報は渡さない", () => {
    const env = commandEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      TMPDIR: "/data/tmp",
      JOBS_TABLE_NAME: "jobs",
      BEDROCK_ROLE_ARN: "arn:aws:iam::000000000000:role/x",
      AWS_SESSION_TOKEN: "secret",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/root",
      TMPDIR: "/data/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });

  test("元の環境に無い変数は含めない", () => {
    expect(commandEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });
});

describe("createRunCommand", () => {
  test("標準出力を返し、失敗したら標準エラーの末尾を添えて例外にする", async () => {
    const run = createRunCommand();
    expect((await run("echo", ["こんにちは"])).trim()).toBe("こんにちは");
    await expect(run("sh", ["-c", "echo 壊れた >&2; exit 3"])).rejects.toThrow(
      /sh が失敗しました: 壊れた/,
    );
  });

  test("実行するコマンドには、ワーカーの設定の環境変数が見えない", async () => {
    process.env.JOBS_TABLE_NAME = "jobs-table";
    try {
      const out = await createRunCommand()("sh", [
        "-c",
        'printf "%s|%s" "$JOBS_TABLE_NAME" "$LANG"',
      ]);
      expect(out).toBe("|C.UTF-8");
    } finally {
      delete process.env.JOBS_TABLE_NAME;
    }
  });
});
