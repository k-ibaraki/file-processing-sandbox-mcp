import type { ProgressEvent } from "@sandbox-mcp/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProgressReporter } from "../src/progress";

describe("ProgressReporter", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000 }));
  afterEach(() => vi.useRealTimers());

  test("開始時にすぐ書き、以後は間隔ごとに、進捗が無くてもハートビートとして書く", async () => {
    const writes: ProgressEvent[][] = [];
    const reporter = new ProgressReporter(async (events) => {
      writes.push(events);
    }, []);
    reporter.add("入力を取得中");
    reporter.start(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual([{ seq: 1, at: 1_000, message: "入力を取得中" }]);
    await reporter.stop();
  });

  test("前の実行の進捗の続きから連番を振る", async () => {
    const write = vi.fn(async () => {});
    const reporter = new ProgressReporter(write, [
      { seq: 7, at: 0, message: "前回" },
    ]);
    reporter.add("今回");
    reporter.start(30_000);
    await reporter.stop();
    expect(write).toHaveBeenLastCalledWith([
      { seq: 7, at: 0, message: "前回" },
      { seq: 8, at: 1_000, message: "今回" },
    ]);
  });

  test("止めるときに最後の進捗を書き、以後は書かない", async () => {
    const write = vi.fn(async () => {});
    const reporter = new ProgressReporter(write, []);
    reporter.start(30_000);
    reporter.add("回答を保存しました");
    await reporter.stop();
    const count = write.mock.calls.length;
    expect(write).toHaveBeenLastCalledWith([
      expect.objectContaining({ message: "回答を保存しました" }),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await reporter.stop();
    expect(write).toHaveBeenCalledTimes(count);
  });

  test("止めた後に足した進捗も、次に止めるときに書く", async () => {
    const write = vi.fn(async () => {});
    const reporter = new ProgressReporter(write, []);
    reporter.start(30_000);
    reporter.add("回答を保存しました");
    await reporter.stop();
    reporter.add("失敗しました");
    await reporter.stop();
    expect(write).toHaveBeenLastCalledWith([
      expect.objectContaining({ message: "回答を保存しました" }),
      expect.objectContaining({ message: "失敗しました" }),
    ]);
    const count = write.mock.calls.length;
    await reporter.stop();
    expect(write).toHaveBeenCalledTimes(count);
  });

  test("書き込みに失敗してもジョブは止めない", async () => {
    const write = vi.fn(async () => {
      throw new Error("DynamoDB に届かない");
    });
    const reporter = new ProgressReporter(write, []);
    reporter.start(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(reporter.stop()).resolves.toBeUndefined();
  });
});
