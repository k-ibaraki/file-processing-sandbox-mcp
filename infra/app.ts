#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { parameters } from "./parameter";
import { createPrototypeStack } from "./stacks/prototype-stack";
import { createSandboxMcpStack } from "./stacks/sandbox-mcp-stack";

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
createSandboxMcpStack(app, "FileProcessingSandboxMcpStack", {
  env,
  parameters,
});

// 実装ステップ 1（MicroVM の試作）だけに使うスタック。検証が済んだら消す
createPrototypeStack(app, "FileProcessingSandboxMcpPrototypeStack", {
  env,
  modelId: parameters.modelId,
  additionalOsCapabilitiesAll: false,
});
