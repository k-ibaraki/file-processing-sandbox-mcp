#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { parameters } from "./parameter";
import { createSandboxMcpStack } from "./stacks/sandbox-mcp-stack";

const app = new cdk.App();
createSandboxMcpStack(app, "FileProcessingSandboxMcpStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  parameters,
});
