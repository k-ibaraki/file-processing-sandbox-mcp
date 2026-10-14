import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, test } from "vitest";
import {
  createJobStorage,
  inParallel,
  localPath,
  MAX_BUFFERED_BYTES,
} from "../src/job-storage";

/** メモリ上の S3 の偽物。一覧は 2 件ずつのページで返す */
function fakeS3(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const puts: string[] = [];
  /** PutObject の本文の渡し方（ストリームか、長さをいくつと伝えたか） */
  const bodies = new Map<string, { stream: boolean; length?: number }>();
  const send = async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const { Prefix = "", ContinuationToken } = command.input;
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(Prefix))
        .sort();
      const start = ContinuationToken ? Number(ContinuationToken) : 0;
      const page = keys.slice(start, start + 2);
      const next = start + 2 < keys.length ? String(start + 2) : undefined;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: next !== undefined,
        NextContinuationToken: next,
      };
    }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key ?? "");
      if (body === undefined) throw new Error("NoSuchKey");
      return { Body: Readable.from([Buffer.from(body)]) };
    }
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key ?? "")) {
        throw new NotFound({ message: "", $metadata: {} });
      }
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      puts.push(key);
      const body = command.input.Body;
      const isStream = body instanceof Readable;
      bodies.set(key, {
        stream: isStream,
        length: command.input.ContentLength,
      });
      if (isStream) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks).toString("utf8"));
      } else {
        objects.set(key, String(body));
      }
      return {};
    }
    throw new Error(`想定外のコマンド: ${String(command)}`);
  };
  return {
    objects,
    puts,
    bodies,
    s3: { send } as unknown as Pick<S3Client, "send">,
  };
}

const tmp = () => mkdtemp(join(tmpdir(), "storage-"));

describe("localPath", () => {
  test("ディレクトリの下のパスにし、外を指すものは拒否する", () => {
    expect(localPath("/data/input", "a/b.pdf")).toBe("/data/input/a/b.pdf");
    expect(() => localPath("/data/input", "../x")).toThrow("外を指す");
    expect(() => localPath("/data/input", "a/../../x")).toThrow("外を指す");
    expect(() => localPath("/data/input", "/etc/passwd")).not.toThrow();
    expect(localPath("/data/input", "/etc/passwd")).toBe(
      "/data/input/etc/passwd",
    );
  });
});

describe("inParallel", () => {
  test("同時に走らせる数を超えず、全部を処理する", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await inParallel(
      Array.from({ length: 20 }, (_, i) => i),
      async (i) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        done.push(i);
      },
    );
    expect(done).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  test("1 件が失敗したら全体も失敗する", async () => {
    await expect(
      inParallel([1, 2, 3], async (i) => {
        if (i === 2) throw new Error("失敗");
      }),
    ).rejects.toThrow("失敗");
  });
});

describe("hasExtracted", () => {
  test("印があれば true、無ければ false（S3 の 404 を失敗にしない）", async () => {
    const { s3 } = fakeS3({ "jobs/J1/extracted/_done.json": "{}" });
    const storage = createJobStorage(s3, "bucket");
    expect(await storage.hasExtracted("J1")).toBe(true);
    expect(await storage.hasExtracted("J2")).toBe(false);
  });

  test("404 以外のエラーは投げ直す", async () => {
    const s3 = {
      send: async () => {
        throw new Error("AccessDenied");
      },
    } as unknown as Pick<S3Client, "send">;
    await expect(
      createJobStorage(s3, "bucket").hasExtracted("J1"),
    ).rejects.toThrow("AccessDenied");
  });
});

describe("downloadInputs", () => {
  test("一覧のページをまたいで全件を、ファイル名だけで取得する", async () => {
    const files = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((n) => [`jobs/J1/input/${n}.txt`, n]),
    );
    const { s3 } = fakeS3({ ...files, "jobs/J2/input/other.txt": "x" });
    const dir = await tmp();
    await createJobStorage(s3, "bucket").downloadInputs("J1", dir);
    expect((await readdir(dir)).sort()).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
    ]);
    expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("c");
  });
});

describe("downloadExtracted / uploadExtracted", () => {
  test("前処理の結果をフォルダごと取得し、印のファイルは取得しない", async () => {
    const { s3 } = fakeS3({
      "jobs/J1/extracted/index.md": "目次",
      "jobs/J1/extracted/見積.xlsx/sheets/明細.csv": "a,b",
      "jobs/J1/extracted/_done.json": "{}",
    });
    const dir = await tmp();
    await createJobStorage(s3, "bucket").downloadExtracted("J1", dir);
    expect(await readFile(join(dir, "見積.xlsx/sheets/明細.csv"), "utf8")).toBe(
      "a,b",
    );
    expect(await readdir(dir)).not.toContain("_done.json");
  });

  test("作業ディレクトリの外を指すキーは拒否する", async () => {
    const { s3 } = fakeS3({ "jobs/J1/extracted/../../escape.txt": "x" });
    await expect(
      createJobStorage(s3, "bucket").downloadExtracted("J1", await tmp()),
    ).rejects.toThrow("外を指す");
  });

  test("結果を相対パスのキーで置き、印を最後に置く", async () => {
    const { s3, puts, objects } = fakeS3();
    const dir = await tmp();
    await mkdir(join(dir, "報告.pdf/pages"), { recursive: true });
    await writeFile(join(dir, "index.md"), "目次");
    await writeFile(join(dir, "報告.pdf/pages/001.txt"), "一ページ目");
    await createJobStorage(s3, "bucket").uploadExtracted("J1", dir);
    expect(puts.at(-1)).toBe("jobs/J1/extracted/_done.json");
    expect(puts.slice(0, -1).sort()).toEqual([
      "jobs/J1/extracted/index.md",
      "jobs/J1/extracted/報告.pdf/pages/001.txt",
    ]);
    expect(
      JSON.parse(objects.get("jobs/J1/extracted/_done.json") ?? "{}"),
    ).toMatchObject({
      files: 2,
    });
  });

  test("小さいファイルはメモリに読んで送る（失敗しても SDK が送り直せる）", async () => {
    const { s3, bodies } = fakeS3();
    const dir = await tmp();
    await writeFile(join(dir, "001.txt"), "一ページ目");
    await createJobStorage(s3, "bucket").uploadExtracted("J1", dir);
    expect(bodies.get("jobs/J1/extracted/001.txt")?.stream).toBe(false);
  });

  test("大きいファイルはメモリに載せずにストリームで送り、大きさを ContentLength で伝える", async () => {
    // 数百 MB の CSV を 8 並列で読み込んで、メモリを使い切らないため
    const { s3, bodies, objects } = fakeS3();
    const dir = await tmp();
    const size = MAX_BUFFERED_BYTES + 1;
    await writeFile(join(dir, "明細.csv"), Buffer.alloc(size, "a"));
    await createJobStorage(s3, "bucket").uploadExtracted("J1", dir);
    expect(bodies.get("jobs/J1/extracted/明細.csv")).toEqual({
      stream: true,
      length: size,
    });
    expect(objects.get("jobs/J1/extracted/明細.csv")).toHaveLength(size);
  });

  test("ストリームで送るファイルは SDK が送り直さないので、失敗したらストリームを作り直して送り直す", async () => {
    const fake = fakeS3();
    let failures = 2;
    const s3 = {
      send: async (command: unknown) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.Key === "jobs/J1/extracted/明細.csv" &&
          failures-- > 0
        ) {
          throw new Error("SlowDown");
        }
        return fake.s3.send(command as never);
      },
    } as unknown as Pick<S3Client, "send">;
    const dir = await tmp();
    await writeFile(
      join(dir, "明細.csv"),
      Buffer.alloc(MAX_BUFFERED_BYTES + 1),
    );
    await createJobStorage(s3, "bucket").uploadExtracted("J1", dir);
    expect(fake.objects.get("jobs/J1/extracted/明細.csv")).toHaveLength(
      MAX_BUFFERED_BYTES + 1,
    );
  });

  test("ストリームで送るファイルが決まった回数失敗したら、印を置かずに失敗する", async () => {
    const fake = fakeS3();
    const s3 = {
      send: async (command: unknown) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.Key === "jobs/J1/extracted/明細.csv"
        ) {
          throw new Error("SlowDown");
        }
        return fake.s3.send(command as never);
      },
    } as unknown as Pick<S3Client, "send">;
    const dir = await tmp();
    await writeFile(
      join(dir, "明細.csv"),
      Buffer.alloc(MAX_BUFFERED_BYTES + 1),
    );
    await expect(
      createJobStorage(s3, "bucket").uploadExtracted("J1", dir),
    ).rejects.toThrow("SlowDown");
    expect(fake.puts).not.toContain("jobs/J1/extracted/_done.json");
  });
});

describe("回答と報告", () => {
  test("回答は answer.md、報告は logs/ の下に置く", async () => {
    const { s3, puts } = fakeS3();
    const storage = createJobStorage(s3, "bucket");
    await storage.putAnswer("J1", "回答");
    await storage.putReport("J1", { a: 1 });
    expect(puts[0]).toBe("jobs/J1/answer.md");
    expect(puts[1]).toMatch(/^jobs\/J1\/logs\/report-\d+\.json$/);
  });
});
