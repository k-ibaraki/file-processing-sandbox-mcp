import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib/core";
import { describe, expect, test } from "vitest";
import { parameters } from "../parameter.sample";
import {
  createSandboxMcpStack,
  type SandboxMcpParameters,
} from "../stacks/sandbox-mcp-stack";

function synth(overrides: Partial<SandboxMcpParameters> = {}): Template {
  const app = new cdk.App();
  const stack = createSandboxMcpStack(app, "TestStack", {
    parameters: { ...parameters, ...overrides },
  });
  return Template.fromStack(stack);
}

describe("SandboxMcpStack", () => {
  test("サンプルのパラメータで合成できる", () => {
    expect(synth().toJSON()).toBeDefined();
  });
});
