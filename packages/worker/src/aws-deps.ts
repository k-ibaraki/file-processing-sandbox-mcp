// runJob が使う実際の部品（DynamoDB・S3・MicroVM の終了・前処理の道具・Agent SDK）。

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  paginateListObjectsV2,
  S3Client,
} from "@aws-sdk/client-s3";
import { jobKeys, type ProgressEvent } from "@sandbox-mcp/shared";
import { buildAgentOptions } from "./agent-options";
import { progressFromMessage, summarizeRun } from "./agent-run";
import type { JobDeps } from "./job";
import { preprocessAll } from "./preprocess";
import { createRunCommand } from "./run-command";

export interface WorkerConfig {
  region: string;
  tableName: string;
  bucketName: string;
  bedrockRoleArn: string;
  /** エージェントの作業ディレクトリ。前処理の結果は extracted に置く */
  workDir: string;
  /** 元のファイルを置く場所。エージェントの作業ディレクトリの外にし、前処理の後に消す（決定23） */
  inputDir: string;
  /** 前処理の一時ファイルの置き場所 */
  tmpDir: string;
  /** エージェントが Bash で使う Python（pandas・DuckDB 入り）の bin。PATH の先頭に置く */
  pythonBinDir: string;
  maxTurns: number;
  credentialExportCommand: string;
  /** Bedrock 専用ロールの一時認証情報の有効秒数。ロールの切り替えでは最長 1 時間 */
  credentialSeconds: number;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} がありません`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    // AWS_REGION はイメージの環境変数として予約されていて渡せないため、別名で受け取る
    region: readEnv(env, "WORKER_REGION"),
    tableName: readEnv(env, "JOBS_TABLE_NAME"),
    bucketName: readEnv(env, "JOBS_BUCKET_NAME"),
    bedrockRoleArn: readEnv(env, "BEDROCK_ROLE_ARN"),
    workDir: "/work",
    inputDir: "/data/input",
    tmpDir: "/data/tmp",
    pythonBinDir: "/opt/py/bin",
    maxTurns: 40,
    credentialExportCommand: "node /opt/worker/export-credentials.mjs",
    credentialSeconds: 3600,
  };
}

/** S3 との転送を同時に走らせる数 */
const TRANSFER_CONCURRENCY = 8;

async function inParallel<T>(
  items: T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(TRANSFER_CONCURRENCY, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await work(item);
      }
    },
  );
  await Promise.all(workers);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** S3 のキーの残りを、dir の下のパスにする。dir の外を指すキーは拒否する */
function localPath(dir: string, rest: string): string {
  const path = resolve(dir, rest);
  if (!path.startsWith(`${resolve(dir)}${sep}`)) {
    throw new Error(`作業ディレクトリの外を指すキーです: ${rest}`);
  }
  return path;
}

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

export function createDeps(config: WorkerConfig): JobDeps {
  const ddb = new DynamoDBClient({ region: config.region });
  const s3 = new S3Client({ region: config.region });
  const microvms = new LambdaMicrovmsClient({ region: config.region });
  const extractedDir = join(config.workDir, "extracted");
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
      await ddb.send(
        new UpdateItemCommand({
          TableName: config.tableName,
          Key: key(jobId),
          UpdateExpression: update.expression,
          ConditionExpression: "#s = :running",
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

  async function download(prefix: string, dir: string, skip?: string) {
    const keys: string[] = [];
    // 1 回の一覧は 1,000 件までなので、最後のページまで回す
    for await (const page of paginateListObjectsV2(
      { client: s3 },
      { Bucket: config.bucketName, Prefix: prefix },
    )) {
      for (const object of page.Contents ?? []) {
        if (object.Key && !object.Key.endsWith("/") && object.Key !== skip) {
          keys.push(object.Key);
        }
      }
    }
    await inParallel(keys, async (objectKey) => {
      const path = localPath(dir, objectKey.slice(prefix.length));
      await mkdir(dirname(path), { recursive: true });
      const { Body } = await s3.send(
        new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
      );
      if (!Body) throw new Error(`${objectKey} を取得できません`);
      // 1 ファイル最大 1GB なので、メモリに載せずにディスクへ流す
      await pipeline(Body as Readable, createWriteStream(path));
    });
  }

  return {
    async getJob(jobId) {
      const { Item } = await ddb.send(
        new GetItemCommand({
          TableName: config.tableName,
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

    async setStatus(jobId, status, error) {
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

    async writeHeartbeat(jobId, progress) {
      await updateWhileRunning(jobId, "heartbeat-skipped", {
        expression: "SET heartbeat_at = :t, progress = :p",
        values: {
          ":t": { N: String(Date.now()) },
          ":p": fromProgress(progress),
        },
      });
    },

    async hasExtracted(jobId) {
      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: config.bucketName,
            Key: jobKeys(jobId).extractedDone,
          }),
        );
        return true;
      } catch (e) {
        if (e instanceof NotFound) return false;
        throw e;
      }
    },

    async downloadExtracted(jobId) {
      const keys = jobKeys(jobId);
      await download(keys.extracted, extractedDir, keys.extractedDone);
    },

    async downloadInputs(jobId) {
      // 入力はフォルダを持たないので、ファイル名だけを使う
      const prefix = jobKeys(jobId).input;
      await mkdir(config.inputDir, { recursive: true });
      const keys: string[] = [];
      for await (const page of paginateListObjectsV2(
        { client: s3 },
        { Bucket: config.bucketName, Prefix: prefix },
      )) {
        for (const object of page.Contents ?? []) {
          if (object.Key && !object.Key.endsWith("/")) keys.push(object.Key);
        }
      }
      await inParallel(keys, async (objectKey) => {
        const { Body } = await s3.send(
          new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
        );
        if (!Body) throw new Error(`${objectKey} を取得できません`);
        await pipeline(
          Body as Readable,
          createWriteStream(localPath(config.inputDir, basename(objectKey))),
        );
      });
    },

    async preprocess(onProgress) {
      return preprocessAll({
        run: createRunCommand(),
        inputDir: config.inputDir,
        extractedDir,
        tmpDir: config.tmpDir,
        onProgress,
      });
    },

    async uploadExtracted(jobId) {
      const keys = jobKeys(jobId);
      const files = await listFiles(extractedDir);
      await inParallel(files, async (file) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: config.bucketName,
            Key: `${keys.extracted}${relative(extractedDir, file).split(sep).join("/")}`,
            Body: await readFile(file),
          }),
        );
      });
      // すべて置けてから印を置く。途中で止まった結果を再実行で使わない
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: keys.extractedDone,
          Body: JSON.stringify({ files: files.length, at: Date.now() }),
          ContentType: "application/json",
        }),
      );
    },

    async clearInputs() {
      await rm(config.inputDir, { recursive: true, force: true });
    },

    async runAgent(instruction, request, onProgress) {
      const options = buildAgentOptions({
        modelId: request.modelId,
        region: config.region,
        workDir: config.workDir,
        maxTurns: config.maxTurns,
        credentialExportCommand: config.credentialExportCommand,
        bedrockRoleArn: config.bedrockRoleArn,
        credentialSeconds: config.credentialSeconds,
        path: `${config.pythonBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        home: process.env.HOME ?? "/root",
      });
      const stderr: string[] = [];
      const messages: unknown[] = [];
      let summary: ReturnType<typeof summarizeRun>;
      try {
        for await (const message of query({
          prompt: instruction,
          options: { ...options, stderr: (data) => stderr.push(data) },
        })) {
          messages.push(message);
          for (const text of progressFromMessage(message, extractedDir)) {
            onProgress(text);
          }
        }
        summary = summarizeRun(messages);
      } catch (error) {
        // 原因を追えるよう、Claude Code の標準エラーの末尾を理由に添える
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n[stderr] ${stderr.join("").slice(-3000)}`,
        );
      }
      return summary;
    },

    async putAnswer(jobId, answer) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: jobKeys(jobId).answer,
          Body: answer,
          ContentType: "text/markdown; charset=utf-8",
        }),
      );
    },

    async putReport(jobId, report) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: `${jobKeys(jobId).logs}report-${Date.now()}.json`,
          Body: JSON.stringify(report, null, 2),
          ContentType: "application/json",
        }),
      );
    },

    async terminate(microvmId) {
      await microvms.send(
        new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
      );
    },
  };
}
