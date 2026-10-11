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
