// ジョブ表（DynamoDB）の読み書き。状態とハートビートは RUNNING のときだけ書く。

import {
  type AttributeValue,
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { ProgressEvent } from "@sandbox-mcp/shared";
import type { FinishedStatus, JobRecord } from "./job";

function toProgress(value: AttributeValue | undefined): ProgressEvent[] {
  return (value?.L ?? []).map((item) => ({
    seq: Number(item.M?.seq?.N ?? 0),
    at: Number(item.M?.at?.N ?? 0),
    message: item.M?.message?.S ?? "",
  }));
}

function fromProgress(events: ProgressEvent[]): AttributeValue {
  return {
    L: events.map((e) => ({
      M: {
        seq: { N: String(e.seq) },
        at: { N: String(e.at) },
        message: { S: e.message },
      },
    })),
  };
}

export function createJobTable(
  client: Pick<DynamoDBClient, "send">,
  tableName: string,
) {
  const key = (jobId: string) => ({ job_id: { S: jobId } });

  /** RUNNING のときだけ更新する。終わったジョブや削除されたジョブを上書きしない */
  async function updateWhileRunning(
    jobId: string,
    event: string,
    update: {
      expression: string;
      names?: Record<string, string>;
      values: Record<string, AttributeValue>;
    },
  ): Promise<void> {
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: key(jobId),
          UpdateExpression: update.expression,
          ConditionExpression: "#s = :running",
          // status は DynamoDB の予約語なので別名にする
          ExpressionAttributeNames: { "#s": "status", ...update.names },
          ExpressionAttributeValues: {
            ...update.values,
            ":running": { S: "RUNNING" },
          },
        }),
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        console.log(JSON.stringify({ event, jobId }));
        return;
      }
      throw e;
    }
  }

  return {
    async getJob(jobId: string): Promise<JobRecord> {
      const { Item } = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: key(jobId),
          ConsistentRead: true,
        }),
      );
      return {
        status: Item?.status?.S,
        instruction: Item?.instruction?.S,
        progress: toProgress(Item?.progress),
      };
    },

    async setStatus(
      jobId: string,
      status: FinishedStatus,
      error?: string,
    ): Promise<void> {
      await updateWhileRunning(jobId, "status-skipped", {
        expression: error
          ? "SET #s = :s, #e = :e, heartbeat_at = :t"
          : "SET #s = :s, heartbeat_at = :t",
        names: error ? { "#e": "error" } : {},
        values: {
          ":s": { S: status },
          ":t": { N: String(Date.now()) },
          ...(error ? { ":e": { S: error } } : {}),
        },
      });
    },

    async writeHeartbeat(
      jobId: string,
      progress: ProgressEvent[],
    ): Promise<void> {
      await updateWhileRunning(jobId, "heartbeat-skipped", {
        expression: "SET heartbeat_at = :t, progress = :p",
        values: {
          ":t": { N: String(Date.now()) },
          ":p": fromProgress(progress),
        },
      });
    },
  };
}
