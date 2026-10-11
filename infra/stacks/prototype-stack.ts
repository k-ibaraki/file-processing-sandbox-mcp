import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as cdk from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { bundleWorkerImage } from "./worker-image";

/**
 * 実装ステップ 1（MicroVM の試作）だけに使うスタック。本番のスタックとは別に作り、検証が済んだら消す。
 * MicroVM は run-microvm で手動起動する。
 */
export interface PrototypeStackProps extends cdk.StackProps {
  /** エージェントが使う Bedrock のモデル ID（日本国内推論の推論プロファイル ID） */
  modelId: string;
  /** イメージに OS 権限 ALL を付ける（bubblewrap が既定の権限で動かないときの比較用） */
  additionalOsCapabilitiesAll: boolean;
}

const IMAGE_NAME = "file-processing-sandbox-prototype";
const HOOK_PORT = 9000;
/** 日本国内推論で推論が処理されるリージョン（東京・大阪） */
const JP_INFERENCE_REGIONS = ["ap-northeast-1", "ap-northeast-3"];

const workerImageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/worker/image",
);

function lambdaServiceRole(scope: Construct, id: string, description: string) {
  return new iam.Role(scope, id, {
    description,
    assumedBy: new iam.ServicePrincipal(
      "lambda.amazonaws.com",
    ).withSessionTags(),
  });
}

export function createPrototypeStack(
  scope: Construct,
  id: string,
  props: PrototypeStackProps,
): cdk.Stack {
  const { modelId, additionalOsCapabilitiesAll, ...stackProps } = props;
  const stack = new cdk.Stack(scope, id, stackProps);
  const { region, account } = stack;

  const bucket = new s3.Bucket(stack, "JobsBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const table = new dynamodb.TableV2(stack, "JobsTable", {
    partitionKey: { name: "job_id", type: dynamodb.AttributeType.STRING },
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const imageArn = `arn:aws:lambda:${region}:${account}:microvm-image:${IMAGE_NAME}`;
  const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:/aws/lambda-microvms/*`;
  const writeLogs = new iam.PolicyStatement({
    actions: [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
    resources: [logGroupArn],
  });

  // 実行ロール。使うのはワーカーのコードだけで、エージェントには渡らない
  const executionRole = lambdaServiceRole(
    stack,
    "ExecutionRole",
    "MicroVM execution role (used only by the worker code)",
  );
  bucket.grantReadWrite(executionRole, "jobs/*");
  table.grantReadWriteData(executionRole);
  executionRole.addToPolicy(writeLogs);
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["lambda:TerminateMicrovm"],
      resources: [imageArn],
    }),
  );

  // Bedrock 専用ロール。ワーカーが引き受け、その一時認証情報だけをエージェントに渡す
  const baseModelId = modelId.replace(/^[a-z]+\./, "");
  const bedrockRole = new iam.Role(stack, "BedrockOnlyRole", {
    description: "Bedrock-only role whose credentials are passed to the agent",
    assumedBy: new iam.ArnPrincipal(executionRole.roleArn),
  });
  bedrockRole.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile",
      ],
      resources: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`,
        ...JP_INFERENCE_REGIONS.map(
          (r) => `arn:aws:bedrock:${r}::foundation-model/${baseModelId}`,
        ),
      ],
    }),
  );
  bedrockRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:ListInferenceProfiles"],
      resources: ["*"],
    }),
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [bedrockRole.roleArn],
    }),
  );

  // ビルドロール。イメージの元になる zip を読み、ビルドのログを書く
  const buildRole = lambdaServiceRole(
    stack,
    "BuildRole",
    "MicroVM image build role",
  );
  buildRole.addToPolicy(writeLogs);

  const source = new s3assets.Asset(stack, "WorkerImageSource", {
    path: workerImageDir,
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: cdk.DockerImage.fromRegistry("unused"),
      local: {
        tryBundle(outputDir) {
          bundleWorkerImage(outputDir);
          return true;
        },
      },
    },
  });
  source.grantRead(buildRole);

  const image = new lambda.CfnMicrovmImage(stack, "WorkerImage", {
    name: IMAGE_NAME,
    description: "Prototype worker for implementation step 1",
    baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
    baseImageVersion: "1",
    buildRoleArn: buildRole.roleArn,
    codeArtifact: { uri: source.s3ObjectUrl },
    cpuConfigurations: [{ architecture: "ARM_64" }],
    resources: [{ minimumMemoryInMiB: 4096 }],
    additionalOsCapabilities: additionalOsCapabilitiesAll ? ["ALL"] : [],
    // ビルド中に dnf と npm で取得するため、インターネットへの送信を許す
    egressNetworkConnectors: [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    ],
    hooks: {
      port: HOOK_PORT,
      microvmHooks: {
        run: "ENABLED",
        runTimeoutInSeconds: 30,
        terminate: "ENABLED",
        terminateTimeoutInSeconds: 30,
      },
      microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 300 },
    },
    environmentVariables: [
      // AWS_REGION はイメージの環境変数として予約されていて渡せないため、別名で渡す
      { key: "WORKER_REGION", value: region },
      { key: "JOBS_TABLE_NAME", value: table.tableName },
      { key: "JOBS_BUCKET_NAME", value: bucket.bucketName },
      { key: "BEDROCK_ROLE_ARN", value: bedrockRole.roleArn },
    ],
    logging: { disabled: false },
  });
  image.node.addDependency(buildRole);

  new cdk.CfnOutput(stack, "ImageArn", { value: image.attrImageArn });
  new cdk.CfnOutput(stack, "ExecutionRoleArn", {
    value: executionRole.roleArn,
  });
  new cdk.CfnOutput(stack, "BucketName", { value: bucket.bucketName });
  new cdk.CfnOutput(stack, "TableName", { value: table.tableName });
  return stack;
}
