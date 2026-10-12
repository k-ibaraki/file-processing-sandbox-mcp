import { describe, expect, test } from "vitest";
import { summarizeRun } from "../src/agent-run";

const init = {
  type: "system",
  subtype: "init",
  tools: ["Read", "Glob", "Grep", "Bash"],
  model: "jp.anthropic.claude-sonnet-4-6",
  permissionMode: "dontAsk",
  claude_code_version: "2.1.300",
};

const assistant = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "調べます" },
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "env | cut -d= -f1" },
      },
    ],
  },
};

const toolResult = {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: false,
        content: [{ type: "text", text: "PATH\nHOME" }],
      },
    ],
  },
};

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "回答です",
  num_turns: 3,
  duration_ms: 12000,
  total_cost_usd: 0.05,
  usage: { input_tokens: 10, cache_read_input_tokens: 2000 },
  modelUsage: { "jp.anthropic.claude-sonnet-4-6": { inputTokens: 10 } },
  permission_denials: [
    { tool_name: "Read", tool_use_id: "t2", tool_input: { file_path: "/etc" } },
  ],
};

describe("summarizeRun", () => {
  test("最後の結果を回答にし、実測の記録をまとめる", () => {
    const { answer, report } = summarizeRun([
      init,
      assistant,
      toolResult,
      success,
    ]);
    expect(answer).toBe("回答です");
    expect(report).toMatchObject({
      tools: ["Read", "Glob", "Grep", "Bash"],
      model: "jp.anthropic.claude-sonnet-4-6",
      permissionMode: "dontAsk",
      claudeCodeVersion: "2.1.300",
      numTurns: 3,
      durationMs: 12000,
      costUsd: 0.05,
      usage: { input_tokens: 10, cache_read_input_tokens: 2000 },
      permissionDenials: [{ tool: "Read", input: { file_path: "/etc" } }],
    });
  });

  test("道具の呼び出しと結果を対にして残す", () => {
    const { report } = summarizeRun([init, assistant, toolResult, success]);
    expect(report.toolCalls).toEqual([
      {
        tool: "Bash",
        input: { command: "env | cut -d= -f1" },
        isError: false,
        output: "PATH\nHOME",
      },
    ]);
  });

  test("長い結果は切り詰める", () => {
    const long = {
      ...toolResult,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "x".repeat(5000),
          },
        ],
      },
    };
    const { report } = summarizeRun([init, assistant, long, success]);
    const calls = report.toolCalls as Array<{ output: string }>;
    expect(calls[0]?.output.length).toBeLessThanOrEqual(2000);
  });

  test("エラーで終わったら理由つきで失敗にする", () => {
    expect(() =>
      summarizeRun([
        init,
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["上限に達した"],
        },
      ]),
    ).toThrow(/error_max_turns.*上限に達した/);
  });

  test("結果が無ければ失敗にする", () => {
    expect(() => summarizeRun([init])).toThrow();
  });
});
