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
- `packages/worker` に試作のワーカーを書いた。ライフサイクルフック、制限付き Claude Code（Agent SDK）の設定、
  Bedrock 専用ロールの一時認証情報を awsCredentialExport で渡すコマンド、回答と実測の記録の保存、自己終了。
  イメージは esbuild でまとめ、Agent SDK だけをイメージ内で npm install する（決定12）
- 検証専用の CDK スタック（S3・DynamoDB・IAM ロール 3 つ・MicroVM イメージ）を東京にデプロイし、MicroVM を 14 回起動して
  実機確認をした。検証だけに使った観測コード・試験オプション・スタックは、確認後に消した。作った AWS 資源（スタック一式、
  サービスが作ったロググループ 2 つ、CDK bootstrap バケットに置いたアセットとテンプレート 9 件）は、一覧をユーザーに示して
  承認を得てから消し、残っていないことを確かめた
- 結果に合わせて DESIGN.md の本文を直し、決定13〜17 を足した

### 実機確認の結果

ジョブ名は検証のときの呼び名。入力は架空の短いテキスト 1 件で、文末にプロンプトインジェクションの文言を仕込んだ。
モデルは `jp.anthropic.claude-sonnet-4-6`、受信は `NO_INGRESS`、送信は `INTERNET_EGRESS`、MicroVM は 4GB 基準。

| ジョブ | 条件 | 結果 |
| --- | --- | --- |
| A2 | 既定の権限・観測あり | `/run` とペイロードが届く。認証情報は IMDSv2（`AWS-HMAC`、残り 55 分）、環境変数・ファイルには無い。bubblewrap は `Can't mount proc on /proc` で失敗。道具は Glob・Grep が無く、想定外の 17 個が並んだ。プロンプトキャッシュは読み込み 35,147・書き込み 5,228 トークン。仕込んだ指示には従わず、回答で報告した |
| A3〜A6 | weaker・`/proc` の禁止を外す・auto-allow の明示を組み合わせた | Bash がすべて `dontAsk` で拒否された（原因は下の「つまずき」） |
| A7 | 既定の権限・単純なコマンド | Bash は自動で許可され、サンドボックス内で `Can't mount proc` により失敗（サンドボックスの外では実行されない） |
| A8 | weaker | Bash が動いた。IMDS への接続は失敗、外部の URL はサンドボックスのプロキシが拒否、`/work` は読み取り専用、AWS の認証情報の環境変数は見えない。`/proc` は読めた |
| A9 | OS 権限 `ALL` のイメージ（weaker なし） | bubblewrap が新しい `/proc` をマウントでき、Bash が動いた。ほかは A8 と同じ |
| D1・D2 | weaker と `ALL` で `/proc` の見え方を比較 | weaker はコンテナの PID とワーカーのコマンド行（`node /opt/worker/index.mjs`）が見える。`ALL` は専用の PID 名前空間で、ほかのプロセスは見えない。どちらも `/proc/1/environ` は読めない |
| B | weaker・Bedrock 専用ロールの有効期限 15 分・9 分の sleep を 2 回 | awsCredentialExport は開始時に 1 回、期限切れの後に取り直された。約 18 分のジョブが止まらずに終わった |
| C1 | `maxIdleDurationSeconds: 60` | 処理中（5 分の sleep）に `SUSPENDED` になった。サスペンドのまま終了され、`/terminate` は呼ばれず、ジョブは `RUNNING` のまま残った |
| C2 | アイドルポリシー無し | 5 分の処理中にサスペンドされなかった |

ほかに分かったこと。

- MicroVM イメージのビルドは 1 回あたり約 2.5 分。イメージの環境変数に `AWS_REGION` は使えない（予約語）が、実行時には自動で入る
- 実行ロールのセッション名は `Lambda-microvmsExecutor-<microvmId>` の形
- Claude Code は起動時に Opus など他のモデルの利用可否を確かめに行くが、Bedrock 専用ロールの IAM ですべて拒否された
- Bedrock を使う場合、Claude Code の利用状況の送信・エラー報告は既定で無効（[Data usage](https://code.claude.com/docs/en/data-usage.md)）

### 判断・つまずき（ステップ 1）

- 判断が要った 4 点（サンドボックスは weaker と OS 権限 `ALL` のどちらか、道具の指定方法、`/proc` の読み取り禁止、アイドルポリシー）は、
  実測の比較を示してユーザーに決めてもらった（決定13〜16）。構想書に無い設定 2 つは、試作の前にユーザーに確認して足した（決定17）
- 最初のデプロイは、イメージの環境変数 `AWS_REGION` が予約語で拒否されてロールバックした。`WORKER_REGION` で渡すように直した
- 最初のジョブは `FAILED` になったが、ワーカーが自己終了したときに `/terminate` フックが理由を上書きし、本当の原因が残らなかった。
  完了・失敗の記録を `RUNNING` のときだけにし、失敗の理由を S3 の報告にも残すように直した。標準エラーは CloudWatch Logs に
  届かなかったので、ログは標準出力に出すようにした。同じ指示で流し直すと成功したので、最初の失敗の原因は分かっていない
- A3〜A6 で Bash が拒否されたのを、はじめはサンドボックスが無効になっていると見立てて、weaker・`/proc`・auto-allow の組み合わせを
  試した。手元の Docker（seccomp を外した arm64 のコンテナ）で再現させて切り分けたところ、原因は検証の指示に付けた
  `; echo "exit=$?"` だった。`;` と `$?` を含むコマンドは、サンドボックス内でも通常の権限判定に回り、`dontAsk` で拒否される。
  指示を単純なコマンドに直して A7 以降を流した。システムプロンプトにも、コマンドを 1 つずつ実行するよう書いた
- アカウント ID・ロールの ARN などの実測値は、記録から伏せた
- PR 前のセルフレビューで 4 件を直した。1 つ目は、想定外の道具の数を 15 個と書いていたが、実測の一覧では 17 個だったこと。
  2 つ目は、ワーカーが開始時に状態を無条件で `RUNNING` にしており、起動直後に削除されたジョブを上書きしうることと、
  `RUNNING` にする前に失敗すると `FAILED` が残らないこと（状態を `RUNNING` にするのは前段 Lambda とし、ワーカーは確かめるだけにした）。
  3 つ目は、決定14 で変えた道具の指定方法が決定11 に追記されていなかったこと。4 つ目は、入力の一覧取得が 1,000 件で切れること

### 判断・つまずき（構想の差し替え）

- 取り込み元の構想書の冒頭にあった作成者名は、公開リポジトリなので取り込まなかった
- 旧版の検討で調べた MicroVM の仕様のうち、新しい構想でも使うもの（認証情報は IMDSv2 で渡る、アイドル判定はエンドポイントを
  通る通信で測る、`--run-hook-payload` は CLI の制約では 4096 文字）は、ステップ 1 の実機確認で裏を取ってから本文に反映した

## 2026-10-13 ステップ 2（ワーカー）

### やったこと

- 着手の前にステップ 2 の範囲と前処理の道具をユーザーと詰めた（決定18〜24）。URL の取り込みはステップ 3 に回し、
  実測は本番のスタックを先に育てて行う
- `packages/shared` にジョブ項目・進捗イベント・S3 のキーの型と定数を置いた
- 前処理を書いた。docx・pptx は OOXML を TypeScript で直接読み（`ooxml.ts`）、xlsx の CSV と PDF 化は LibreOffice、
  PDF のテキストと画像は poppler、画像は ImageMagick と heif-convert（`preprocess.ts`）。結果は
  `/work/extracted/<元のファイル名>/` に置き、目次を `index.md` に書く
- ジョブの流れに、前処理・結果の S3 への保存と再実行での取得・元のファイルの削除・ハートビートと進捗（30 秒ごと）・
  時間の実測を足した。進捗はエージェントの道具の呼び出しから機械的に作る
- システムプロンプトを、前処理の結果の目次から読む形に書き直した
- MicroVM イメージに前処理の道具と Python の道具を足した。本番のスタックにジョブのバケット（1 日で消える）と表
  （ttl・利用者ごとの GSI）、ワーカーの IAM と MicroVM イメージを足した

### 判断・つまずき

- 構想書のイメージの道具のうち、LibreOffice・libvips・exiftool・pandas・DuckDB は AL2023 のリポジトリに無かった
  （手元の Docker で `dnf repoquery` して確認）。LibreOffice は配布元の RPM、Python の道具は venv と pip で入れ、
  libvips と exiftool は ImageMagick で代えた
- LibreOffice の RPM を `dnf install` で入れようとしたが、基盤イメージの dnf は microdnf でファイルの RPM を入れられなかった。
  `rpm -i` に変え、足りないライブラリを `ldd` で洗い出して dnf で入れた
- コンテナに UTF-8 のロケールが無く、LibreOffice が日本語のシート名を `???` にして、シートごとの CSV を見つけられなかった。
  前処理のコマンドは `LANG=C.UTF-8` で動かす
- 一時ディレクトリと出力先が別のファイルシステムだと `rename` が EXDEV で失敗した（手元の Docker でボリュームに出したとき）。
  写して消す形に戻れるようにした。xlsx で「CSV がありません」と出ていたのは、この失敗を握りつぶした警告だった
- AL2023 の ImageMagick は HEIC を読めるが EXIF を読めなかった。heif-convert で JPEG にすると EXIF が残った
- Word の「箇条書き」スタイルは段落ではなくスタイルの側に番号付けを持つので、スタイルの定義も見るようにした
- 新しく入れた依存が自分で `createRequire` を import しており、esbuild でまとめたワーカーが「Identifier 'createRequire'
  has already been declared」で起動しなくなった。まとめた結果を手元の Docker で動かして見つけた。先頭に足す行を別名の
  import にし、まとめた結果を `node --check` で確かめるテストを足した
- 確認用のサンプルは、架空の内容で手元に作った（リポジトリには入れない）。文書の中にプロンプトインジェクションの文言を仕込んだ

### セルフレビューで直したこと（デプロイ前）

- ImageMagick が拡張子ではなく中身で形式を決める問題。`.png` の名前の SVG が `SVG` として読まれるのを手元の AL2023 で確かめ、
  入力を決まった名前に置いて `jpeg:`・`png:` で形式を固定し、資源の上限と `-ping` を付けた（決定25）。EXIF が `-ping` でも取れることも確かめた
- `aws-deps.ts` にテストが無かったので、DynamoDB の読み書きを `job-table.ts`、S3 を `job-storage.ts` に切り出してテストを書いた。
  `localPath` の検査を一時的に外すとテストが落ちることを確かめた。一覧は SDK のページ送りを使わず、継続トークンで回す形にした
  （偽のクライアントで試せるため。SDK のページ送りは偽のクライアントを `Invalid client` で拒否することを確かめた）。DynamoDB の予約語に `progress`・`heartbeat_at` が無いことを公式の一覧で確かめた
- xlsx のシート名と LibreOffice が付ける CSV のファイル名が合わない場合に、CSV を捨てないようにした。書き出されたファイルを一覧し、
  合わないものは「シート名を特定できない CSV」として目次に載せる
- 前処理のコマンドの環境変数を、`PATH`・`HOME`・`TMPDIR` とロケールだけに絞った
- 実測まで見送ったこと：数 GB の CSV が出たときのメモリ（`uploadExtracted` は丸ごと読む）、1 コマンド 10 分の制限が数千ページの PDF に足りるか
