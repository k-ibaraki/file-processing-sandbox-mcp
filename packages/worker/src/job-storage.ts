// ジョブのファイル（S3）の取得と保存。入力・前処理の結果・回答・報告。

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { jobKeys } from "@sandbox-mcp/shared";

/** S3 との転送を同時に走らせる数 */
const TRANSFER_CONCURRENCY = 8;
/**
 * これより大きいファイルは、メモリに載せずにストリームで送る（同時に 8 件読んでも 128MB に収まる）。
 * 小さいファイルをメモリに読んで送るのは、ストリームの本文は SDK が送り直さないため
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** ストリームで送るファイルを送る回数の上限（最初の 1 回を含む。送り直しは 2 回まで） */
const STREAM_ATTEMPTS = 3;

export async function inParallel<T>(
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

/** S3 のキーの残りを、dir の下のパスにする。dir の外を指すキーは拒否する */
export function localPath(dir: string, rest: string): string {
  const path = resolve(dir, `.${sep}${rest}`);
  if (!path.startsWith(`${resolve(dir)}${sep}`)) {
    throw new Error(`作業ディレクトリの外を指すキーです: ${rest}`);
  }
  return path;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** ストリームで送り直す前に待つ時間の単位。n 回目の送り直しの前に n 倍待つ */
const RETRY_DELAY_MS = 1000;

export interface JobStorageOptions {
  /** 待つ関数。テストで実時間を待たずに、待つ長さを確かめるために差し替える */
  sleep?: (ms: number) => Promise<void>;
}

export function createJobStorage(
  s3: Pick<S3Client, "send">,
  bucket: string,
  { sleep = (ms) => setTimeout(ms) }: JobStorageOptions = {},
) {
  /** prefix の下のキーを、最後のページまで集める（1 回の一覧は 1,000 件まで） */
  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key && !object.Key.endsWith("/")) keys.push(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async function downloadTo(key: string, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!Body) throw new Error(`${key} を取得できません`);
    // 1 ファイル最大 1GB なので、メモリに載せずにディスクへ流す
    await pipeline(Body as Readable, createWriteStream(path));
  }

  async function put(key: string, body: string, contentType?: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  return {
    async hasExtracted(jobId: string): Promise<boolean> {
      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: jobKeys(jobId).extractedDone,
          }),
        );
        return true;
      } catch (e) {
        if (e instanceof NotFound) return false;
        throw e;
      }
    },

    async downloadExtracted(jobId: string, dir: string): Promise<void> {
      const keys = jobKeys(jobId);
      const objects = (await listKeys(keys.extracted)).filter(
        (key) => key !== keys.extractedDone,
      );
      await inParallel(objects, (key) =>
        downloadTo(key, localPath(dir, key.slice(keys.extracted.length))),
      );
    },

    /** 入力はフォルダを持たないので、ファイル名だけを使う */
    async downloadInputs(jobId: string, dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
      const objects = await listKeys(jobKeys(jobId).input);
      await inParallel(objects, (key) =>
        downloadTo(key, localPath(dir, basename(key))),
      );
    },

    async uploadExtracted(jobId: string, dir: string): Promise<void> {
      const keys = jobKeys(jobId);
      const files = await listFiles(dir);
      await inParallel(files, async (file) => {
        const key = `${keys.extracted}${relative(dir, file).split(sep).join("/")}`;
        const { size } = await stat(file);
        if (size <= MAX_BUFFERED_BYTES) {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: await readFile(file),
            }),
          );
          return;
        }
        // downloadTo と同じく、数百 MB の CSV などをメモリに載せない。SDK は送り直さないので、ストリームを作り直して送り直す
        for (let attempt = 1; ; attempt++) {
          const body = createReadStream(file);
          try {
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentLength: size,
              }),
            );
            return;
          } catch (e) {
            // 本文を送る前に失敗すると（SDK は大きな本文に Expect: 100-continue を付ける）、ストリームは開いたまま残る
            body.destroy();
            if (attempt >= STREAM_ATTEMPTS) throw e;
            // S3 が混雑して返す 503 は、すぐ送り直すと同じ応答が返りやすい
            await sleep(RETRY_DELAY_MS * attempt);
          }
        }
      });
      // すべて置けてから印を置く。途中で止まった結果を再実行で使わない
      await put(
        keys.extractedDone,
        JSON.stringify({ files: files.length, at: Date.now() }),
        "application/json",
      );
    },

    async putAnswer(jobId: string, answer: string): Promise<void> {
      await put(jobKeys(jobId).answer, answer, "text/markdown; charset=utf-8");
    },

    async putReport(
      jobId: string,
      report: Record<string, unknown>,
    ): Promise<void> {
      await put(
        `${jobKeys(jobId).logs}report-${Date.now()}.json`,
        JSON.stringify(report, null, 2),
        "application/json",
      );
    },
  };
}
