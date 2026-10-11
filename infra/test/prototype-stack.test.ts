import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib/core";
import { describe, expect, test } from "vitest";
import {
  createPrototypeStack,
  type PrototypeStackProps,
} from "../stacks/prototype-stack";

function synth(overrides: Partial<PrototypeStackProps> = {}): Template {
  const app = new cdk.App();
  const stack = createPrototypeStack(app, "TestPrototypeStack", {
    env: { account: "000000000000", region: "ap-northeast-1" },
    modelId: "jp.anthropic.claude-sonnet-4-6",
    additionalOsCapabilitiesAll: false,
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe("PrototypeStack", () => {
  test("MicroVM イメージは arm64・4GB 基準で、フックを 9000 番で受ける", () => {
    synth().hasResourceProperties("AWS::Lambda::MicrovmImage", {
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
        { Key: "AWS_REGION", Value: "ap-northeast-1" },
        Match.objectLike({ Key: "JOBS_TABLE_NAME" }),
        Match.objectLike({ Key: "JOBS_BUCKET_NAME" }),
        Match.objectLike({ Key: "BEDROCK_ROLE_ARN" }),
      ]),
    });
  });

  test("OS 権限 ALL を付けた版も作れる", () => {
    synth({ additionalOsCapabilitiesAll: true }).hasResourceProperties(
      "AWS::Lambda::MicrovmImage",
      { AdditionalOsCapabilities: ["ALL"] },
    );
  });

  test("Bedrock 専用ロールは実行ロールだけが引き受けられ、モデルの呼び出しだけを許す", () => {
    const template = synth();
    const roles = template.findResources("AWS::IAM::Role", {
      Properties: { Description: Match.stringLikeRegexp("Bedrock-only") },
    });
    expect(Object.keys(roles)).toHaveLength(1);
    const [logicalId, role] = Object.entries(roles)[0] ?? [];
    const statements = role?.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Principal.AWS).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { Roles: [{ Ref: logicalId }] },
    });
    const actions = Object.values(policies).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (s: { Action: string | string[] }) => [s.Action].flat(),
      ),
    );
    expect(new Set(actions)).toEqual(
      new Set([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile",
        "bedrock:ListInferenceProfiles",
      ]),
    );
  });

  test("実行ロールは Lambda が引き受け、Bedrock 専用ロールへの切り替えと自分の終了ができる", () => {
    const template = synth();
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
    const [roleId] = Object.keys(
      template.findResources("AWS::IAM::Role", {
        Properties: { Description: Match.stringLikeRegexp("execution role") },
      }),
    );
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { Roles: [{ Ref: roleId }] },
    });
    const actions = Object.values(policies).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (s: { Action: string | string[] }) => [s.Action].flat(),
      ),
    );
    expect(actions).toEqual(
      expect.arrayContaining(["sts:AssumeRole", "lambda:TerminateMicrovm"]),
    );
  });

  test("ジョブのバケットは公開を止め、検証後に消せるようにする", () => {
    const template = synth();
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    template.hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Delete",
    });
  });
});
