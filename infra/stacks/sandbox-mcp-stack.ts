import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cdk from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { createWorker } from "./worker";

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
 * S3・DynamoDB・前段 Lambda・掃除用 Lambda・MicroVM イメージをまとめるスタック。
 * いまはジョブのバケットと表、MicroVM のワーカーまで。前段 Lambda と掃除用 Lambda は実装ステップ 3 で足す（決定18）。
 */
export function createSandboxMcpStack(
  scope: Construct,
  id: string,
  props: SandboxMcpStackProps,
): cdk.Stack {
  const { parameters, ...stackProps } = props;
  const stack = new cdk.Stack(scope, id, stackProps);

  // ファイルは作成から 1 日で消す。ジョブ表の項目も ttl で同じ頃に消える
  const bucket = new s3.Bucket(stack, "JobsBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [{ prefix: "jobs/", expiration: cdk.Duration.days(1) }],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    // ファイルは 1 日で消えるが、その間に cdk destroy しても失敗しないよう、スタックの削除時に中身も消す
    autoDeleteObjects: true,
  });

  const table = new dynamodb.TableV2(stack, "JobsTable", {
    partitionKey: { name: "job_id", type: dynamodb.AttributeType.STRING },
    timeToLiveAttribute: "ttl",
    // 利用者ごとのジョブ一覧と、実行中のジョブの数の判定に使う
    globalSecondaryIndexes: [
      {
        indexName: "owner-created_at",
        partitionKey: { name: "owner", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "created_at", type: dynamodb.AttributeType.NUMBER },
      },
    ],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const worker = createWorker(stack, {
    bucket,
    table,
    modelId: parameters.modelId,
  });

  new cdk.CfnOutput(stack, "BucketName", { value: bucket.bucketName });
  new cdk.CfnOutput(stack, "TableName", { value: table.tableName });
  new cdk.CfnOutput(stack, "WorkerImageArn", {
    value: worker.image.attrImageArn,
  });
  new cdk.CfnOutput(stack, "WorkerExecutionRoleArn", {
    value: worker.executionRole.roleArn,
  });
  return stack;
}
