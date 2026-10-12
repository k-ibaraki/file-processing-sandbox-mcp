// Claude Code の awsCredentialExport から呼ばれるコマンド。Bedrock 専用ロールの一時認証情報を標準出力に JSON で返す。
// Claude Code のプロセス（サンドボックスの外）で動くので、実行ロールの認証情報（IMDS）で STS を呼べる。
// エージェントの Bash はサンドボックス内で外と通信できないため、このコマンドを使っても認証情報は取れない。

import { STSClient } from "@aws-sdk/client-sts";
import { assumeBedrockRole } from "./bedrock-credentials";

async function main(): Promise<void> {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) throw new Error("BEDROCK_ROLE_ARN がありません");
  const output = await assumeBedrockRole(
    new STSClient({ region: process.env.AWS_REGION }),
    {
      roleArn,
      durationSeconds: Number(process.env.BEDROCK_CREDENTIAL_SECONDS ?? 3600),
      sessionName: "restricted-claude-code",
    },
  );
  process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
