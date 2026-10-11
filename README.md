# file-processing-sandbox-mcp

Office・PDF・画像の複数ファイルを S3 に集め、Lambda MicroVM の中で動く Claude Code（Amazon Bedrock）に読ませて、
指示に沿った回答を作らせるリモート MCP サーバー。ジョブごとに使い捨ての MicroVM を起動するので、使わない間の固定費はほぼかからない。

> いまはリポジトリの土台（ツールチェーン・CI・空の雛形）だけで、機能はまだ実装していない。

## 構成

| 場所 | 役割 |
| --- | --- |
| `packages/shared` | gateway・dispatcher・worker が共有する型と定数 |
| `packages/gateway` | 前段 Lambda（MCP ゲートウェイ）。認証・ジョブ管理・署名付き URL の発行 |
| `packages/dispatcher` | ディスパッチャー Lambda。MicroVM の起動と終了 |
| `packages/worker` | MicroVM 内のワーカー。Claude Agent SDK でジョブを実行する |
| `infra` | AWS CDK（TypeScript） |

## セットアップ

```sh
mise install                                        # Node.js / pnpm を導入
pnpm install
cp infra/parameter.sample.ts infra/parameter.ts     # デプロイパラメータ（gitignore 済み）
```

## コマンド（リポジトリのルートで実行）

```sh
pnpm typecheck                              # 型チェック（ルートの設定ファイルと全パッケージ）
pnpm lint                                   # Biome による lint とフォーマット確認
pnpm format                                 # Biome による自動修正
pnpm test                                   # Vitest（全パッケージと CDK の Template テスト）
pnpm --filter @sandbox-mcp/infra synth      # CDK の合成
```

## デプロイパラメータ

| 名前 | 内容 | サンプルの値 |
| --- | --- | --- |
| `modelId` | MicroVM 内の Claude が使う Bedrock のモデル ID（推論プロファイル ID） | `jp.anthropic.claude-sonnet-4-6` |

## もっと詳しく

- 設計と、判断の経緯（設計決定録）: [docs/DESIGN.md](docs/DESIGN.md)
- 作業の記録: [docs/implementation-log.md](docs/implementation-log.md)

## ライセンス

[MIT](LICENSE)
