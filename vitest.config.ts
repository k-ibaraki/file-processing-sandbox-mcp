import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 各パッケージと infra/ をそれぞれ別のプロジェクトとして実行する
    projects: ["packages/*", "infra"],
    passWithNoTests: true,
  },
});
