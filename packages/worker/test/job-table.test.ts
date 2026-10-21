import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, test, vi } from "vitest";
import { createJobTable } from "../src/job-table";

type Client = Pick<DynamoDBClient, "send">;

function client(send: (command: unknown) => unknown) {
  const fn = vi.fn(async (command: unknown) => send(command));
  return { fn, client: { send: fn } as unknown as Client };
}

/** 最初に送られた UpdateItemCommand の入力 */
function sentUpdate(fn: { mock: { calls: unknown[][] } }) {
  const command = fn.mock.calls[0]?.[0];
  if (!(command instanceof UpdateItemCommand)) {
    throw new Error("UpdateItemCommand が送られていません");
  }
  return command.input;
}

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: "x", $metadata: {} });

describe("getJob", () => {
  test("状態・指示・進捗を読み、無い項目は空にする", async () => {
    const { fn, client: c } = client(() => ({
      Item: {
        status: { S: "RUNNING" },
        instruction: { S: "質問" },
        progress: {
          L: [
            {
              M: {
                seq: { N: "3" },
                at: { N: "1000" },
                message: { S: "前処理 1/2件" },
              },
            },
          ],
        },
      },
    }));
    const job = await createJobTable(c, "jobs").getJob("01JOB");
    expect(job).toEqual({
      status: "RUNNING",
      instruction: "質問",
      progress: [{ seq: 3, at: 1000, message: "前処理 1/2件" }],
    });
    const command = fn.mock.calls[0]?.[0] as GetItemCommand;
    expect(command).toBeInstanceOf(GetItemCommand);
    expect(command.input).toMatchObject({
      TableName: "jobs",
      Key: { job_id: { S: "01JOB" } },
      ConsistentRead: true,
    });
  });

  test("項目が無いジョブは、状態も指示も無く進捗は空", async () => {
    const { client: c } = client(() => ({}));
    expect(await createJobTable(c, "jobs").getJob("01JOB")).toEqual({
      status: undefined,
      instruction: undefined,
      progress: [],
    });
  });
});

describe("writeHeartbeat", () => {
  test("RUNNING のときだけ、ハートビートの時刻と進捗を書く", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const { fn, client: c } = client(() => ({}));
    await createJobTable(c, "jobs").writeHeartbeat("01JOB", [
      { seq: 1, at: 10, message: "入力ファイルを取得中" },
    ]);
    const command = fn.mock.calls[0]?.[0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toMatchObject({
      TableName: "jobs",
      Key: { job_id: { S: "01JOB" } },
      UpdateExpression: "SET heartbeat_at = :t, progress = :p",
      ConditionExpression: "#s = :running",
      // status は DynamoDB の予約語なので別名にする
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":t": { N: "5000" },
        ":p": {
          L: [
            {
              M: {
                seq: { N: "1" },
                at: { N: "10" },
                message: { S: "入力ファイルを取得中" },
              },
            },
          ],
        },
        ":running": { S: "RUNNING" },
      },
    });
    vi.restoreAllMocks();
  });

  test("RUNNING でなくなったジョブ（削除など）への書き込みは、失敗にせず捨てる", async () => {
    const { client: c } = client(() => {
      throw conditionFailed();
    });
    await expect(
      createJobTable(c, "jobs").writeHeartbeat("01JOB", []),
    ).resolves.toBeUndefined();
  });

  test("条件の失敗以外のエラーは投げ直す", async () => {
    const { client: c } = client(() => {
      throw new Error("DynamoDB に届かない");
    });
    await expect(
      createJobTable(c, "jobs").writeHeartbeat("01JOB", []),
    ).rejects.toThrow("DynamoDB に届かない");
  });
});

describe("setStatus", () => {
  test("失敗の理由は error 属性に、予約語を避けて書く", async () => {
    const { fn, client: c } = client(() => ({}));
    await createJobTable(c, "jobs").setStatus("01JOB", "FAILED", "壊れた");
    const input = sentUpdate(fn);
    expect(input.UpdateExpression).toBe(
      "SET #s = :s, #e = :e, heartbeat_at = :t",
    );
    expect(input.ExpressionAttributeNames).toEqual({
      "#s": "status",
      "#e": "error",
    });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":s": { S: "FAILED" },
      ":e": { S: "壊れた" },
      ":running": { S: "RUNNING" },
    });
  });

  test("成功のときは error を書かない。RUNNING でなければ捨てる", async () => {
    const { fn, client: c } = client(() => {
      throw conditionFailed();
    });
    await createJobTable(c, "jobs").setStatus("01JOB", "SUCCEEDED");
    const input = sentUpdate(fn);
    expect(input.UpdateExpression).toBe("SET #s = :s, heartbeat_at = :t");
    expect(input.ExpressionAttributeNames).toEqual({ "#s": "status" });
  });
});
