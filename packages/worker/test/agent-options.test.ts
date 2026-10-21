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
};

describe("buildAgentOptions", () => {
  test("渡す道具は Read・Glob・Grep・Bash だけを列挙し、それ以外は定義ごと出さない", () => {
    const options = buildAgentOptions(base);
    // disallowedTools だけでは Glob・Grep が無く、想定外の道具が並んだため tools で列挙する（決定14）
    expect(options.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
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
      filesystem: { denyWrite: ["/work"] },
    });
  });

  test("MicroVM のコンテナでも bubblewrap が動くよう、/proc を bind する弱いサンドボックスにする", () => {
    // 既定の権限では新しい /proc をマウントできないため（決定13）
    const sandbox = buildAgentOptions(base).sandbox;
    expect(sandbox?.enableWeakerNestedSandbox).toBe(true);
    // weaker では /proc の読み取り禁止が効かないため、設定しない（決定15）
    expect(sandbox?.filesystem?.denyRead).toBeUndefined();
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

  test("システムプロンプトは前処理の結果の目次から読ませ、画像はテキストで足りないときだけ見させる", () => {
    const prompt = String(buildAgentOptions(base).systemPrompt);
    expect(prompt).toContain("/work/extracted/index.md");
    expect(prompt).toContain("テキストで足りない");
    expect(prompt).toContain("DuckDB");
  });

  test("Bash の書き方は実測で通った形を示し、拒否される形（ファイルへの書き出し）を避けさせる", () => {
    const prompt = String(buildAgentOptions(base).systemPrompt);
    // 実測（B1・M2）で、標準入力から渡す形は通り、cat > ファイル の形は拒否された
    expect(prompt).toContain("python3 - <<'EOF'");
    expect(prompt).toContain("ファイルへの書き出し");
  });

  test("回答の根拠は、作業用のパスではなく元のファイル名で示させる", () => {
    // 実測（V1・V2）で、根拠に「売上明細.csv/売上明細.csv」や /work/extracted/index.md と書いた。利用者には意味が分からない
    const prompt = String(buildAgentOptions(base).systemPrompt);
    expect(prompt).toContain("元のファイル名");
    expect(prompt).toContain("/work/extracted の下の作業用のパス");
  });

  test("前処理に失敗したファイルは読めていないことを、回答で伝えさせる", () => {
    // 前処理に失敗してもジョブは失敗にしないので、利用者が知る手段は回答だけ（決定28）
    const prompt = String(buildAgentOptions(base).systemPrompt);
    expect(prompt).toContain("前処理に失敗しました");
    expect(prompt).toContain("読めなかった");
  });

  test("Bash の書き方の指示に、実測していない形（tee）を拒否されると断定して書かない", () => {
    // 実測で拒否されたのは cat > ファイル だけ。tee は試していない
    const prompt = String(buildAgentOptions(base).systemPrompt);
    expect(prompt).toContain("cat >");
    expect(prompt).not.toContain("tee");
  });
});
