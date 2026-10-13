import { describe, expect, test } from "vitest";
import { appendProgress, jobKeys, MAX_PROGRESS_EVENTS } from "../src/index";

describe("jobKeys", () => {
  test("ジョブごとの S3 のキーは jobs/<job_id>/ の下に並ぶ", () => {
    expect(jobKeys("01JOB")).toEqual({
      prefix: "jobs/01JOB/",
      input: "jobs/01JOB/input/",
      extracted: "jobs/01JOB/extracted/",
      extractedDone: "jobs/01JOB/extracted/_done.json",
      answer: "jobs/01JOB/answer.md",
      logs: "jobs/01JOB/logs/",
    });
  });
});

describe("appendProgress", () => {
  test("連番を 1 から振り、前の続きの番号を付ける", () => {
    const first = appendProgress([], "入力を取得中", 1000);
    expect(first).toEqual([{ seq: 1, at: 1000, message: "入力を取得中" }]);
    const second = appendProgress(first, "前処理 1/2件", 2000);
    expect(second.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("直近の 50 件だけを残し、連番は途切れずに続く", () => {
    let events: ReturnType<typeof appendProgress> = [];
    for (let i = 0; i < MAX_PROGRESS_EVENTS + 5; i++) {
      events = appendProgress(events, `e${i}`, i);
    }
    expect(events).toHaveLength(MAX_PROGRESS_EVENTS);
    expect(events[0]?.seq).toBe(6);
    expect(events.at(-1)?.seq).toBe(MAX_PROGRESS_EVENTS + 5);
  });

  test("元の配列は書き換えない", () => {
    const events = appendProgress([], "a", 1);
    appendProgress(events, "b", 2);
    expect(events).toHaveLength(1);
  });
});
