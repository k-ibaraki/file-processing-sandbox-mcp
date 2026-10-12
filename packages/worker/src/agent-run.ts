// Agent SDK のメッセージ列から、回答と実測の記録を取り出す。

/** 道具の結果を記録に残すときの上限（文字数） */
const MAX_OUTPUT = 2000;

type Message = Record<string, unknown>;

interface ToolCall {
  tool: string;
  input: unknown;
  isError?: boolean;
  output?: string;
}

function contentBlocks(message: Message): Message[] {
  const inner = message.message as { content?: unknown } | undefined;
  return Array.isArray(inner?.content) ? (inner.content as Message[]) : [];
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Message) =>
        typeof block.text === "string" ? block.text : "",
      )
      .join("");
  }
  return "";
}

export function summarizeRun(messages: readonly unknown[]): {
  answer: string;
  report: Record<string, unknown>;
} {
  const report: Record<string, unknown> = {};
  const calls = new Map<string, ToolCall>();
  let answer: string | undefined;

  for (const raw of messages) {
    const message = raw as Message;
    if (message.type === "system" && message.subtype === "init") {
      report.tools = message.tools;
      report.model = message.model;
      report.permissionMode = message.permissionMode;
      report.claudeCodeVersion = message.claude_code_version;
    } else if (message.type === "assistant") {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_use") {
          calls.set(String(block.id), {
            tool: String(block.name),
            input: block.input,
          });
        }
      }
    } else if (message.type === "user") {
      for (const block of contentBlocks(message)) {
        const call = calls.get(String(block.tool_use_id));
        if (block.type === "tool_result" && call) {
          call.isError = block.is_error === true;
          call.output = toText(block.content).slice(0, MAX_OUTPUT);
        }
      }
    } else if (message.type === "result") {
      if (message.subtype !== "success") {
        const errors = Array.isArray(message.errors)
          ? message.errors.join(" / ")
          : "";
        throw new Error(
          `エージェントが ${message.subtype} で終わりました: ${errors}`,
        );
      }
      answer = String(message.result);
      report.numTurns = message.num_turns;
      report.durationMs = message.duration_ms;
      report.costUsd = message.total_cost_usd;
      report.usage = message.usage;
      report.modelUsage = message.modelUsage;
      report.permissionDenials = (
        (message.permission_denials as Message[] | undefined) ?? []
      ).map((denial) => ({ tool: denial.tool_name, input: denial.tool_input }));
    }
  }

  if (answer === undefined) {
    throw new Error("エージェントの結果がありません");
  }
  report.toolCalls = [...calls.values()];
  return { answer, report };
}
