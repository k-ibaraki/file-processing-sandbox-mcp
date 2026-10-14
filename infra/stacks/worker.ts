// MicroVM のワーカー。イメージ、実行ロール、エージェントに渡す Bedrock 専用ロール、イメージのビルドロール。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as cdk from "aws-cdk-lib/core";
import { bundleWorkerImage } from "./worker-image";

export interface WorkerProps {
  bucket: s3.IBucket;
  table: dynamodb.ITableV2;
  /** エージェントが使う Bedrock のモデル ID（日本国内推論の推論プロファイル ID） */
  modelId: string;
}

const IMAGE_NAME = "file-processing-sandbox-worker";
const HOOK_PORT = 9000;
/** 日本国内推論で推論が処理されるリージョン（東京・大阪） */
const JP_INFERENCE_REGIONS = ["ap-northeast-1", "ap-northeast-3"];

const workerImageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/worker/image",
);

function lambdaServiceRole(scope: cdk.Stack, id: string, description: string) {
  return new iam.Role(scope, id, {
    description,
    assumedBy: new iam.ServicePrincipal(
      "lambda.amazonaws.com",
    ).withSessionTags(),
  });
}

export function createWorker(stack: cdk.Stack, props: WorkerProps) {
  const { bucket, table, modelId } = props;
  const { region, account } = stack;

  const imageArn = `arn:aws:lambda:${region}:${account}:microvm-image:${IMAGE_NAME}`;
  const writeLogs = new iam.PolicyStatement({
    actions: [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
    resources: [
      `arn:aws:logs:${region}:${account}:log-group:/aws/lambda-microvms/*`,
    ],
  });

  // 実行ロール。使うのはワーカーのコードだけで、エージェントには渡らない
  const executionRole = lambdaServiceRole(
    stack,
    "WorkerExecutionRole",
    "MicroVM execution role (used only by the worker code)",
  );
  // ワーカーが使う操作だけを許す。前処理の外部ツールが乗っ取られても、ファイルや項目を削除したり、表を Scan したりはできない。
  // ただし、ジョブごとには絞れていない（全ジョブ共通の実行ロールのため。決定29）。S3 の一覧から全ジョブの ID が分かり、
  // 他のジョブのファイルと項目を読めるうえ、PutObject・UpdateItem で上書きもできる
  // 表は GSI を含めず表だけ。S3 の一覧には条件を付けない。S3 は無いキーの HeadObject に、ListBucket の権限が
  // あるときだけ 404 を返す（hasExtracted が使う）。prefix の条件付きでも 404 になるかは確かめておらず、
  // キーはすべて jobs/ の下なので、条件を付けても絞れない
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [bucket.arnForObjects("jobs/*")],
    }),
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [bucket.bucketArn],
    }),
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [table.tableArn],
    }),
  );
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
    "WorkerBuildRole",
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
    description:
      "Worker that preprocesses files and runs a restricted Claude Code",
    baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
    baseImageVersion: "1",
    buildRoleArn: buildRole.roleArn,
    codeArtifact: { uri: source.s3ObjectUrl },
    cpuConfigurations: [{ architecture: "ARM_64" }],
    // ディスクの上限は基準サイズで決まる。4GB 基準で 16GB
    resources: [{ minimumMemoryInMiB: 4096 }],
    // Bash サンドボックスは weaker で動かし、OS 権限は付けない（決定13）
    additionalOsCapabilities: [],
    // ビルド中に dnf・npm・pip と LibreOffice の配布元から取得するため、インターネットへの送信を許す
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

  return { image, executionRole };
}
