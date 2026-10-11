// runJob が使う実際の部品（DynamoDB・S3・MicroVM の終了・Agent SDK）。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
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
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildAgentOptions } from "./agent-options";
import { summarizeRun } from "./agent-run";
import type { JobDeps } from "./job";
import { collectProbe } from "./probe";

export interface WorkerConfig {
  region: string;
  tableName: string;
  bucketName: string;
  bedrockRoleArn: string;
  workDir: string;
  maxTurns: number;
  credentialExportCommand: string;
  /** awsCredentialExport の呼び出し記録（試作の確認用） */
  exportLogPath: string;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} がありません`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    region: readEnv(env, "WORKER_REGION"),
    tableName: readEnv(env, "JOBS_TABLE_NAME"),
    bucketName: readEnv(env, "JOBS_BUCKET_NAME"),
    bedrockRoleArn: readEnv(env, "BEDROCK_ROLE_ARN"),
    workDir: "/work",
    maxTurns: 40,
    credentialExportCommand: "node /opt/worker/export-credentials.mjs",
    exportLogPath: "/var/tmp/worker/export-credentials.log",
  };
}

const jobPrefix = (jobId: string) => `jobs/${jobId}/`;

export function createDeps(config: WorkerConfig): JobDeps {
  const ddb = new DynamoDBClient({ region: config.region });
  const s3 = new S3Client({ region: config.region });
  const microvms = new LambdaMicrovmsClient({ region: config.region });
  const key = { job_id: { S: "" } };

  return {
    async getInstruction(jobId) {
      const { Item } = await ddb.send(
        new GetItemCommand({
          TableName: config.tableName,
          Key: { ...key, job_id: { S: jobId } },
        }),
      );
      const instruction = Item?.instruction?.S;
      if (!instruction) throw new Error(`ジョブ ${jobId} に指示がありません`);
      return instruction;
    },

    async setStatus(jobId, status, error) {
      await ddb.send(
        new UpdateItemCommand({
          TableName: config.tableName,
          Key: { ...key, job_id: { S: jobId } },
          UpdateExpression: error
            ? "SET #s = :s, #e = :e, heartbeat_at = :t"
            : "SET #s = :s, heartbeat_at = :t",
          ExpressionAttributeNames: error
            ? { "#s": "status", "#e": "error" }
            : { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": { S: status },
            ":t": { N: String(Date.now()) },
            ...(error ? { ":e": { S: error } } : {}),
          },
        }),
      );
    },

    async downloadInputs(jobId) {
      const dir = join(config.workDir, "input");
      await mkdir(dir, { recursive: true });
      const prefix = `${jobPrefix(jobId)}input/`;
      const { Contents = [] } = await s3.send(
        new ListObjectsV2Command({ Bucket: config.bucketName, Prefix: prefix }),
      );
      for (const object of Contents) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        const { Body } = await s3.send(
          new GetObjectCommand({ Bucket: config.bucketName, Key: object.Key }),
        );
        if (!Body) continue;
        await writeFile(
          join(dir, basename(object.Key)),
          await Body.transformToByteArray(),
        );
      }
    },

    async runAgent(instruction, request) {
      const options = buildAgentOptions({
        modelId: request.modelId,
        region: config.region,
        workDir: config.workDir,
        maxTurns: config.maxTurns,
        credentialExportCommand: config.credentialExportCommand,
        bedrockRoleArn: config.bedrockRoleArn,
        credentialSeconds: request.probe.credentialSeconds ?? 3600,
        path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        home: process.env.HOME ?? "/root",
        weakerNestedSandbox: request.probe.weakerNestedSandbox ?? false,
      });
      const stderr: string[] = [];
      const messages: unknown[] = [];
      for await (const message of query({
        prompt: instruction,
        options: { ...options, stderr: (data) => stderr.push(data) },
      })) {
        messages.push(message);
      }
      const { answer, report } = summarizeRun(messages);
      const exportLog = await readFile(config.exportLogPath, "utf8").catch(
        () => "",
      );
      return {
        answer,
        report: {
          ...report,
          credentialExports: exportLog.split("\n").filter(Boolean),
          stderr: stderr.join("").slice(-4000),
        },
      };
    },

    async putAnswer(jobId, answer) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: `${jobPrefix(jobId)}answer.md`,
          Body: answer,
          ContentType: "text/markdown; charset=utf-8",
        }),
      );
    },

    async putReport(jobId, report) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: `${jobPrefix(jobId)}logs/report-${Date.now()}.json`,
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

    probe: () => collectProbe(config.region),
  };
}
