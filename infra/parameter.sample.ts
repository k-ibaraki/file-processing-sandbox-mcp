import type { SandboxMcpParameters } from "./stacks/sandbox-mcp-stack";

/**
 * デプロイパラメータのサンプル。
 * このファイルを parameter.ts にコピーして、環境に合わせて編集する。
 *
 *   cp parameter.sample.ts parameter.ts
 *
 * parameter.ts は .gitignore 済みなので、個人環境の値がコミットされることはない。
 */
export const parameters: SandboxMcpParameters = {
  modelId: "jp.anthropic.claude-sonnet-4-6",
};
