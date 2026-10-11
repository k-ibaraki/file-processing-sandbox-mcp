# 実装ログ

作業のたびに日付見出しで、やったこと・判断・つまずきを残す。設計判断そのものは `DESIGN.md` の設計決定録に書く。

## 2026-10-11 リポジトリの土台づくり

### やったこと

- 設計書を `docs/DESIGN.md` に取り込み、設計決定録（決定1〜9）を足した
- pnpm workspace（`packages/shared`・`gateway`・`dispatcher`・`worker`、`infra/`）を作った。各パッケージは役割を書いた
  空の `src/index.ts` だけで、実装はまだ無い
- `infra/` は資源を持たない空のスタックと、合成できることだけを確かめるテストを置いた。`cdk.json` の feature flag は
  `aws-cdk` 2.1145.0 の `cdk init --generate-only` から写し、それでも足りなかった
  `@aws-cdk/aws-cloudfront:defaultViewerProtocolPolicyRedirectToHttps` を推奨値（true）で足した
- CLAUDE.md・README・CI（GitHub Actions）を用意した

### 判断・つまずき

- pnpm を 12 にしようとしたが、手元の mise 2026.1.2 が pnpm 11 以降の配布物（`pnpm-darwin-arm64.tar.gz`）を
  `pnpm-macos-arm64` の名前で探して失敗した。mise 本体の更新は手元の環境を変えるので今回は見送り、
  既存リポジトリと同じ pnpm 10 にした（決定3）
- TypeScript 6 以降は `types` の既定が空になったため、`tsconfig.base.json` で `"types": ["node"]` を明示している
- `noUncheckedIndexedAccess` は、最初は確認を取らずに入れていた。ユーザーに理由と得失を説明して確認を取り、残すことにした（決定10）
- Biome に `.gitignore` を読ませる設定も、確認を取らずに入れていた。ユーザーに確認し、billing-mcp と同じく読ませない設定に戻した。
  除外は `biome.json` の `files.includes` に書いた（決定5）
- セルフレビューで見つけた 3 件を直した。1 つ目は、コミット前チェックに synth が入っておらず CI と揃っていなかったこと
  （CLAUDE.md に足した。決定9）。2 つ目は、取り込んだ設計書で `/terminate` の説明がコード表示に崩れていたこと。
  3 つ目は、ルートの `vitest.config.ts` が型検査の対象外だったこと（ルートに `tsconfig.json` を置き、`pnpm typecheck` で先に検査する）
- セルフレビューの 2 巡目で、README の `pnpm typecheck` の説明が、ルートの設定ファイルも検査するようになった後の範囲を表していなかったので直した

## 2026-10-12 構想の差し替えと、ステップ 1（MicroVM の試作）

### やったこと

- 実装ステップ 1 の検証計画を立てる途中で、旧版の設計（送信用プロキシ・nftables・ユーザー分離でエージェントを外から囲う）が
  「シンプルな技術選定」という前提から外れていると分かった。ユーザーが構想書を改め、本文をそれに差し替えた（決定11）
- 差し替えに合わせて、`packages/dispatcher` を `packages/cleanup`（掃除用 Lambda）に置き換え、CLAUDE.md・README・
  各パッケージの説明コメントを新しい構想に揃えた（決定2 を更新）

### 判断・つまずき

- 取り込み元の構想書の冒頭にあった作成者名は、公開リポジトリなので取り込まなかった
- 旧版の検討で調べた MicroVM の仕様のうち、新しい構想でも使うもの（認証情報は IMDSv2 で渡る、アイドル判定はエンドポイントを
  通る通信で測る、`--run-hook-payload` は CLI の制約では 4096 文字）は、ステップ 1 の実機確認で裏を取ってから本文に反映する
