import { describe, expect, test } from "vitest";
import { buildAgentOptions } from "../src/agent-options";

const base = {
  modelId: "jp.anthropic.claude-sonnet-4-6",
  region: "ap-northeast-1",
  workDir: "/work",
  maxTurns: 40,
  credentialExportCommand: "node /opt/worker/export-credentials.mjs",
  bedrockRoleArn: "arn:aws:iam::000000000000:role/bedrock-only",
  credentialSeconds: 3600,
  path: "/usr/local/bin:/usr/bin",
  home: "/root",
  weakerNestedSandbox: false,
  autoAllowBashIfSandboxed: false,
  debugFile: undefined,
  denyReadProc: true,
};

describe("buildAgentOptions", () => {
  test("読むための道具以外はツールの定義ごと外す", () => {
    const options = buildAgentOptions(base);
    expect(options.disallowedTools).toEqual([
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Agent",
    ]);
    // allowedTools にツール名だけを書くと、どのパスでも自動許可になるので書かない
    expect(options.allowedTools).toBeUndefined();
  });

  test("確認が要る操作はすべて拒否させ、外部の設定は読まない", () => {
    const options = buildAgentOptions(base);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe("/work");
    expect(options.maxTurns).toBe(40);
  });

  test("Bash はサンドボックス内だけで、外向き通信も作業ディレクトリへの書き込みも無し", () => {
    const sandbox = buildAgentOptions(base).sandbox;
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      filesystem: { denyRead: ["/proc"], denyWrite: ["/work"] },
    });
    expect(sandbox?.enableWeakerNestedSandbox).toBeUndefined();
  });

  test("サンドボックス内のコマンドからは AWS の認証情報の環境変数を消す", () => {
    const names = buildAgentOptions(base).sandbox?.credentials?.envVars?.map(
      (v) => (typeof v === "object" && v !== null ? v : { name: "" }),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        { name: "AWS_ACCESS_KEY_ID", mode: "deny" },
        { name: "AWS_SECRET_ACCESS_KEY", mode: "deny" },
        { name: "AWS_SESSION_TOKEN", mode: "deny" },
        { name: "AWS_CONTAINER_CREDENTIALS_FULL_URI", mode: "deny" },
        { name: "AWS_CONTAINER_AUTHORIZATION_TOKEN", mode: "deny" },
      ]),
    );
  });

  test("試験オプションで autoAllowBashIfSandboxed を明示できる", () => {
    expect(
      buildAgentOptions(base).sandbox?.autoAllowBashIfSandboxed,
    ).toBeUndefined();
    const options = buildAgentOptions({
      ...base,
      autoAllowBashIfSandboxed: true,
    });
    expect(options.sandbox?.autoAllowBashIfSandboxed).toBe(true);
  });

  test("試験オプションで /proc の読み取り禁止を外せる", () => {
    const options = buildAgentOptions({ ...base, denyReadProc: false });
    expect(options.sandbox?.filesystem?.denyRead).toEqual([]);
  });

  test("試験オプションで Claude Code のデバッグログを書き出せる", () => {
    expect(buildAgentOptions(base).debugFile).toBeUndefined();
    const options = buildAgentOptions({ ...base, debugFile: "/tmp/d.log" });
    expect(options.debugFile).toBe("/tmp/d.log");
  });

  test("試験オプションで weaker nested sandbox を有効にできる", () => {
    const options = buildAgentOptions({ ...base, weakerNestedSandbox: true });
    expect(options.sandbox?.enableWeakerNestedSandbox).toBe(true);
  });

  test("Bedrock へはモデル ID を明示し、認証情報は awsCredentialExport でだけ渡す", () => {
    const options = buildAgentOptions(base);
    expect(options.model).toBe("jp.anthropic.claude-sonnet-4-6");
    expect(options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/root",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "ap-northeast-1",
      ANTHROPIC_MODEL: "jp.anthropic.claude-sonnet-4-6",
      BEDROCK_ROLE_ARN: "arn:aws:iam::000000000000:role/bedrock-only",
      BEDROCK_CREDENTIAL_SECONDS: "3600",
    });
    expect(options.settings).toEqual({
      awsCredentialExport: "node /opt/worker/export-credentials.mjs",
    });
  });

  test("システムプロンプトは既定のものではなく、文書はデータとして扱うよう指示する専用のもの", () => {
    const prompt = buildAgentOptions(base).systemPrompt;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("/work");
    expect(prompt).toContain("データ");
  });
});
