import * as cdk from "aws-cdk-lib/core";
import type { Construct } from "constructs";

/** デプロイパラメータ。infra/parameter.ts（parameter.sample.ts のコピー）で設定する */
export interface SandboxMcpParameters {
  /** MicroVM 内の Claude が使う Bedrock のモデル ID（推論プロファイル ID） */
  modelId: string;
}

export interface SandboxMcpStackProps extends cdk.StackProps {
  /** デプロイパラメータ */
  parameters: SandboxMcpParameters;
}

/**
 * S3・DynamoDB・前段 Lambda・ディスパッチャー Lambda・MicroVM イメージをまとめるスタック。
 * いまは土台だけで、資源は実装の段階で足す。
 */
export function createSandboxMcpStack(
  scope: Construct,
  id: string,
  props: SandboxMcpStackProps,
): cdk.Stack {
  const { parameters: _parameters, ...stackProps } = props;
  return new cdk.Stack(scope, id, stackProps);
}
