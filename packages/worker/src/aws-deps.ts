// runJob が使う実際の部品（DynamoDB・S3・MicroVM の終了・前処理の道具・Agent SDK）。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { S3Client } from "@aws-sdk/client-s3";
import { buildAgentOptions } from "./agent-options";
import { progressFromMessage, summarizeRun } from "./agent-run";
import type { JobDeps } from "./job";
import { createJobStorage } from "./job-storage";
import { createJobTable } from "./job-table";
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

export function createDeps(config: WorkerConfig): JobDeps {
  const table = createJobTable(
    new DynamoDBClient({ region: config.region }),
    config.tableName,
  );
  const storage = createJobStorage(
    new S3Client({ region: config.region }),
    config.bucketName,
  );
  const microvms = new LambdaMicrovmsClient({ region: config.region });
  const extractedDir = join(config.workDir, "extracted");

  return {
    getJob: table.getJob,
    setStatus: table.setStatus,
    writeHeartbeat: table.writeHeartbeat,
    hasExtracted: storage.hasExtracted,
    downloadExtracted: (jobId) =>
      storage.downloadExtracted(jobId, extractedDir),
    downloadInputs: (jobId) => storage.downloadInputs(jobId, config.inputDir),
    uploadExtracted: (jobId) => storage.uploadExtracted(jobId, extractedDir),
    putAnswer: storage.putAnswer,
    putReport: storage.putReport,

    async preprocess(onProgress) {
      return preprocessAll({
        run: createRunCommand(),
        inputDir: config.inputDir,
        extractedDir,
        tmpDir: config.tmpDir,
        onProgress,
      });
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

    async terminate(microvmId) {
      await microvms.send(
        new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
      );
    },
  };
}
