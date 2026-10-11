// エージェント（Claude Code）に渡す「指定モデルの Bedrock 呼び出しだけ」の一時認証情報。
// ワーカーは実行ロールで Bedrock 専用ロールを引き受け、その認証情報だけを awsCredentialExport の形で返す。

import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";

export interface CredentialExport {
  Credentials: {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken: string;
    Expiration: string;
  };
}

interface StsCredentials {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: Date;
}

export function toCredentialExport(
  credentials: StsCredentials,
): CredentialExport {
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } =
    credentials;
  if (!AccessKeyId || !SecretAccessKey || !SessionToken || !Expiration) {
    throw new Error("STS の応答に認証情報が揃っていません");
  }
  return {
    Credentials: {
      AccessKeyId,
      SecretAccessKey,
      SessionToken,
      Expiration: Expiration.toISOString(),
    },
  };
}

export async function assumeBedrockRole(
  sts: Pick<STSClient, "send">,
  params: { roleArn: string; durationSeconds: number; sessionName: string },
): Promise<CredentialExport> {
  const output = await sts.send(
    new AssumeRoleCommand({
      RoleArn: params.roleArn,
      RoleSessionName: params.sessionName,
      DurationSeconds: params.durationSeconds,
    }),
  );
  return toCredentialExport(output.Credentials ?? {});
}
