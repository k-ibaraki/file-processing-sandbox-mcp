# CLAUDE.md

## プロジェクト概要

Office・PDF・画像の複数ファイルを S3 に集め、Lambda MicroVM 内の Claude Code（Bedrock）に読ませて回答を作らせる
リモート MCP サーバー。設計は `docs/DESIGN.md` が正。いまは土台だけで、実装は設計書の「実装ステップ」の順に進める。

## 必ず守ること（作業記録）

- 設計を変えたら `docs/DESIGN.md` の本文を直し、判断の経緯を末尾の設計決定録に番号つきで追記・更新する
  （行は消さず、変更の経緯は理由欄に残す）
- 作業のたびに `docs/implementation-log.md` へ日付見出しで記録する（やったこと・判断・つまずき）
- DESIGN.md の「未確認事項」に触れる実装は、先に検証して結果を DESIGN.md に反映してから進める
- 決定番号（決定N）は DESIGN.md・implementation-log・CLAUDE.md・コードのコメントの中でだけ使う。README には書かない
  （読み手は README だけを読むので、理由が要るなら番号ではなく本文に書く）。README を変えたらコミット前に
  `grep -nE '決定[0-9]' README.md` で番号が無いことを確かめる

## 公開リポジトリとしての注意

- このリポジトリは PUBLIC。AWS アカウント ID・メールアドレス・個人名・エンドポイント URL・Cognito のプール ID など、
  環境や個人を特定できる値をコミットしない。環境ごとの値は `infra/parameter.ts`（gitignore 済み）に置く

## 言語

- ドキュメント・コードコメント・コミットメッセージは日本語

## 開発の進め方

- TDD（レッド→グリーン）で進める
- 依存を足すときは最新の安定版を確かめてから入れ、`pnpm install` 後に `pnpm-lock.yaml` の差分が足したものだけかを見る

## 構成と規約

pnpm workspace のモノレポ（決定2）。lockfile はルートの 1 つだけ。

| 場所 | 役割 |
| --- | --- |
| `packages/shared` | gateway・dispatcher・worker が共有する型と定数（ジョブの状態、DynamoDB 項目、S3 のキー） |
| `packages/gateway` | 前段 Lambda（MCP ゲートウェイ）。認証・ジョブ管理・署名付き URL だけで、重い処理はしない |
| `packages/dispatcher` | ディスパッチャー Lambda。MicroVM の起動・終了の権限はここだけが持つ |
| `packages/worker` | MicroVM 内のワーカー。ライフサイクルフックと、Claude Agent SDK によるジョブ実行 |
| `infra` | CDK |

- TypeScript 7.0。共通設定は `tsconfig.base.json`（`module: preserve` / `noEmit`。決定4）。tsc は型検査だけに使い、
  実行コードは esbuild でまとめるか tsx で動かす。TS 6 以降は `types` の既定が空なので、型パッケージを足したら
  `types` にも足す
- workspace 内の依存は `"@sandbox-mcp/shared": "workspace:*"` で書き、`exports` は `src/index.ts` を直接指す
- Lint・フォーマットは Biome（ルートの `biome.json`）。テストは Vitest で、CDK の Template テストも Vitest で書く（決定6）。
  jest は使わない
- MCP は `@modelcontextprotocol/server`（SDK v2）を使う。v1 系の `@modelcontextprotocol/sdk` は使わない（決定8）
- ワーカーのエージェントは Claude Agent SDK（TypeScript 版）。Bedrock には環境変数（`CLAUDE_CODE_USE_BEDROCK=1` ほか）で繋ぐ

### CDK（`infra/`）

- スタックはクラス継承ではなく関数（`createSandboxMcpStack()`）で定義する
- デプロイパラメータは型付きの `infra/parameter.ts` に集める（CDK context は使わない）。パラメータを足すときは
  `SandboxMcpParameters` 型・`parameter.sample.ts`・README の「デプロイパラメータ」の表を揃えて更新する

### セキュリティ設計（変更時も維持する）

- 入力ファイルは信頼できないものとして扱う。MicroVM 内の S3・DynamoDB へのアクセスはワーカー本体だけが行い、
  Claude は非特権ユーザーで Bedrock 呼び出し用の認証情報だけを持たせる
- MicroVM の操作権限はディスパッチャー Lambda だけに与える。gateway とワーカーには与えない

## コマンド（リポジトリのルートで実行）

- `mise install` / `pnpm install` — 初回セットアップ。続けて `cp infra/parameter.sample.ts infra/parameter.ts`
- `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm --filter @sandbox-mcp/infra synth`（CDK の合成） —
  **コミット前に必ず全て通すこと**（CI と同じ内容）
- `pnpm format` — Biome による自動修正
- `pnpm --filter @sandbox-mcp/infra cdk diff` / `cdk deploy` — **AWS 上に資源を作り課金が発生する。実行前に必ず確認を取ること**

## 手元のツール

- pnpm は 10 に固定している。手元の mise（2026.1.2）では pnpm 11 以降を入れられないため（決定3）。
  mise を更新したら `mise.toml` の pnpm を上げてよい
