import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  bundleWorkerImage,
  workerImagePackageJson,
} from "../stacks/worker-image";

describe("workerImagePackageJson", () => {
  test("Agent SDK だけを、ワーカーの package.json と同じ版で入れる", () => {
    const json = JSON.parse(
      workerImagePackageJson({
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.3.296",
          "@aws-sdk/client-s3": "^3.1149.0",
        },
      }),
    );
    expect(json).toEqual({
      name: "worker-image",
      private: true,
      type: "module",
      dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.296" },
    });
  });

  test("Agent SDK の版が固定されていなければ拒否する", () => {
    expect(() =>
      workerImagePackageJson({
        dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.296" },
      }),
    ).toThrow(/固定/);
  });
});

describe("bundleWorkerImage", () => {
  test("Dockerfile・package.json・まとめたワーカーを書き出す", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-image-"));
    bundleWorkerImage(dir);
    expect(readdirSync(dir).sort()).toEqual([
      "Dockerfile",
      "export-credentials.mjs",
      "index.mjs",
      "package.json",
    ]);
    const index = readFileSync(join(dir, "index.mjs"), "utf8");
    // Agent SDK は中に取り込まず、import のまま残す
    expect(index).toMatch(/from\s*"@anthropic-ai\/claude-agent-sdk"/);
  });

  test("まとめたファイルは ES モジュールとして構文の誤りが無い", () => {
    // 取り込んだ依存が自分で createRequire を import していても、先頭に足す行と名前がぶつからないこと
    const dir = mkdtempSync(join(tmpdir(), "worker-image-"));
    bundleWorkerImage(dir);
    for (const file of ["index.mjs", "export-credentials.mjs"]) {
      expect(() =>
        execFileSync(process.execPath, ["--check", join(dir, file)], {
          stdio: "pipe",
        }),
      ).not.toThrow();
    }
  });
});
