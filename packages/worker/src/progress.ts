// ハートビートと進捗の書き込み。進捗はメモリに貯め、決まった間隔でハートビートと一緒に DynamoDB へ書く。

import { appendProgress, type ProgressEvent } from "@sandbox-mcp/shared";

export class ProgressReporter {
  private events: ProgressEvent[];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** 書き込みを重ねないよう、直前の書き込みの終わりを待ってから次を書く */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (events: ProgressEvent[]) => Promise<void>,
    /** 前の実行で書かれた進捗。連番はこの続きから振る */
    initial: ProgressEvent[],
  ) {
    this.events = initial;
  }

  add(message: string): void {
    this.events = appendProgress(this.events, message, Date.now());
  }

  start(intervalMs: number): void {
    this.flush();
    this.timer = setInterval(() => this.flush(), intervalMs);
  }

  /** 最後の進捗を書いて止める。2 回目以降は何もしない */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.flush();
    await this.writing;
  }

  private flush(): void {
    const events = this.events;
    this.writing = this.writing.then(() =>
      this.write(events).catch((error) =>
        // ハートビートが一度書けなくても、掃除用 Lambda が待つ 3 分のうちに次が書ければよい
        console.log(
          JSON.stringify({ event: "heartbeat-failed", error: String(error) }),
        ),
      ),
    );
  }
}
