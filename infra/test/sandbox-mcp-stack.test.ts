import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib/core";
import { beforeAll, describe, expect, test } from "vitest";
import { parameters } from "../parameter.sample";
import { createSandboxMcpStack } from "../stacks/sandbox-mcp-stack";

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = createSandboxMcpStack(app, "TestStack", {
    env: { account: "000000000000", region: "ap-northeast-1" },
    parameters,
  });
  template = Template.fromStack(stack);
});

interface Statement {
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

function policyStatements(roleDescription: RegExp): Statement[] {
  const [roleId] = Object.keys(
    template.findResources("AWS::IAM::Role", {
      Properties: {
        Description: Match.stringLikeRegexp(roleDescription.source),
      },
    }),
  );
  const policies = template.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: roleId }] },
  });
  return Object.values(policies).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Statement[],
  );
}

function policyActions(roleDescription: RegExp): string[] {
  return policyStatements(roleDescription).flatMap((s) => [s.Action].flat());
}

describe("ジョブのバケットと表", () => {
  test("バケットは公開を止めて SSE-S3 で暗号化し、jobs/ の下を 1 日で消す", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Prefix: "jobs/",
            ExpirationInDays: 1,
            Status: "Enabled",
          }),
        ],
      },
    });
  });

  test("スタックを消すとき、ジョブのファイルが残っていてもバケットごと消せる", () => {
    // ファイルは 1 日で消える設計だが、その間に cdk destroy すると空でないバケットの削除で失敗するため
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    template.hasResourceProperties("Custom::S3AutoDeleteObjects", {});
  });

  test("ジョブ表はオンデマンドで、ttl で消え、利用者ごとの一覧用の GSI を持つ", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "job_id", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "owner-created_at",
          KeySchema: [
            { AttributeName: "owner", KeyType: "HASH" },
            { AttributeName: "created_at", KeyType: "RANGE" },
          ],
        }),
      ],
    });
  });
});

describe("MicroVM のワーカー", () => {
  test("イメージは arm64・4GB 基準で、フックを 9000 番で受け、OS 権限は既定のまま", () => {
    template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      BaseImageArn: "arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1",
      CpuConfigurations: [{ Architecture: "ARM_64" }],
      Resources: [{ MinimumMemoryInMiB: 4096 }],
      AdditionalOsCapabilities: [],
      Hooks: {
        Port: 9000,
        MicrovmHooks: Match.objectLike({
          Run: "ENABLED",
          Terminate: "ENABLED",
        }),
        MicrovmImageHooks: Match.objectLike({ Ready: "ENABLED" }),
      },
      EnvironmentVariables: Match.arrayWith([
        { Key: "WORKER_REGION", Value: "ap-northeast-1" },
        Match.objectLike({ Key: "JOBS_TABLE_NAME" }),
        Match.objectLike({ Key: "JOBS_BUCKET_NAME" }),
        Match.objectLike({ Key: "BEDROCK_ROLE_ARN" }),
      ]),
    });
  });

  test("予約された環境変数（AWS_REGION）はイメージに渡さない", () => {
    const images = template.findResources("AWS::Lambda::MicrovmImage");
    const keys = Object.values(images).flatMap((image) =>
      image.Properties.EnvironmentVariables.map((v: { Key: string }) => v.Key),
    );
    expect(keys).not.toContain("AWS_REGION");
  });

  test("Bedrock 専用ロールは実行ロールだけが引き受けられ、指定モデルの呼び出しだけを許す", () => {
    const roles = template.findResources("AWS::IAM::Role", {
      Properties: { Description: Match.stringLikeRegexp("Bedrock-only") },
    });
    expect(Object.keys(roles)).toHaveLength(1);
    const statements =
      Object.values(roles)[0]?.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Principal.AWS).toBeDefined();
    expect(new Set(policyActions(/Bedrock-only/))).toEqual(
      new Set([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile",
        "bedrock:ListInferenceProfiles",
      ]),
    );
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Resource: Match.arrayWith([
              "arn:aws:bedrock:ap-northeast-1:000000000000:inference-profile/jp.anthropic.claude-sonnet-4-6",
            ]),
          }),
        ]),
      },
    });
  });

  test("実行ロールは Lambda が引き受け、Bedrock 専用ロールへの切り替えと MicroVM の終了ができる", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      Description: Match.stringLikeRegexp("execution role"),
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: ["sts:AssumeRole", "sts:TagSession"],
            Principal: { Service: "lambda.amazonaws.com" },
          }),
        ],
      },
    });
    expect(policyActions(/execution role/)).toEqual(
      expect.arrayContaining([
        "sts:AssumeRole",
        "lambda:TerminateMicrovm",
        "dynamodb:UpdateItem",
        "s3:PutObject",
      ]),
    );
  });

  test("実行ロールの S3 と DynamoDB の権限は、ワーカーが使う操作だけにする", () => {
    // 前処理の外部ツールが乗っ取られても、他のジョブのファイルや項目を消せないようにするため（決定27）
    const statements = policyStatements(/execution role/);
    const actionsOf = (service: string) =>
      new Set(
        statements
          .flatMap((s) => [s.Action].flat())
          .filter((a) => a.startsWith(`${service}:`)),
      );
    expect(actionsOf("s3")).toEqual(
      new Set(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]),
    );
    expect(actionsOf("dynamodb")).toEqual(
      new Set(["dynamodb:GetItem", "dynamodb:UpdateItem"]),
    );
  });

  test("実行ロールの S3 の読み書きは jobs/ の下に限り、DynamoDB は表だけで GSI には届かない", () => {
    const statements = policyStatements(/execution role/);
    // 一覧に条件を付けない。S3 は無いキーの HeadObject に、ListBucket の権限があるときだけ 404 を返し、
    // 条件付きでも 404 になるかは確かめていない（決定29）
    const list = statements.find((s) =>
      [s.Action].flat().includes("s3:ListBucket"),
    );
    expect(list?.Condition).toBeUndefined();
    const objects = statements.find((s) =>
      [s.Action].flat().includes("s3:GetObject"),
    );
    expect(JSON.stringify(objects?.Resource)).toContain("/jobs/*");
    const table = statements.find((s) =>
      [s.Action].flat().includes("dynamodb:GetItem"),
    );
    expect(JSON.stringify(table?.Resource)).not.toContain("/index/");
  });
});
