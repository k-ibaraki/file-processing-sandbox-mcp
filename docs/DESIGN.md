# Office/PDF/画像 ファイル読解・回答MCP 設計書

2026-10-09 起草。2026-10-11 にリポジトリへ取り込み、以後はこのファイルを正とする。設計を変えたら本文を直し、
判断の経緯は末尾の「設計決定録」に番号つきで残す。

## 概要と目的

Office・PDF・画像の複数ファイルをS3に集め、Lambda MicroVM内のClaude Code（Bedrock）に読ませ、入力された指示に沿った回答を作らせるリモートMCPサーバーを作る。固定費をほぼゼロにし、使った分だけ払う構成とする。

**想定する使い方**

1. 呼び出し側（MCPクライアント）が、他のMCPでファイルを探す
2. このMCPでジョブを作り、ファイルをジョブのS3フォルダへ取り込む
3. 指示（質問や、作ってほしい回答の内容）を出すと、MicroVM内のClaudeがファイルを読んで回答を作り、S3に残す
4. 呼び出し側が結果を受け取る

**前提**

- リージョンは東京（ap-northeast-1）。MicroVMはArm（Graviton）のみ
- モデルはAmazon Bedrock経由のClaude（日本国内推論）
- NATゲートウェイは使わない。MicroVMはVPCに入れず、標準のインターネット送信でS3とBedrockに接続する
- 対象ファイルはOffice（docx/xlsx/pptxと旧形式）、PDF、画像。1ジョブに複数ファイル。1ファイル1GBまで、1ジョブ合計5GBまで

**非目標**

- 対話的なシェル環境やIDEの提供
- 常時起動のサーバー
- 複数組織にまたがるマルチテナント運用（初期は個人〜小規模チーム）

## 全体アーキテクチャ

常時動くのは前段Lambdaだけで、重い処理はジョブごとに起動するMicroVMが担う。VPCとNATは使わない。

> 構成図（9つの構成要素）は未作成。取り込み元の図はリポジトリへ移せなかったため、作り直して `docs/` に置く。

前段LambdaはMicroVMを起動するだけで、MicroVMへHTTPでは接続しない。ジョブの受け渡しはS3（ファイル）とDynamoDB（状態）を介して行う。

## 処理フロー

ジョブは非同期で、`run_job` はすぐに返り、呼び出し側は `get_job` で完了を待つ。MCPのツール呼び出しにはタイムアウトがあるため、回答の完成を同期的に待たない。

1. `create_job` でジョブを作る。手元のファイルは返ってきたURLへアップロード、URLはジョブに登録、小さいテキストはその場で保存
2. `run_job` で指示を渡し、状態を `QUEUED` にしてMicroVMを起動（同時実行の上限を超えていればエラー）
3. MicroVMの `/run` フックがジョブIDを受け取り、作業を開始（`RUNNING`）
   - URLの入力をダウンロードしてS3に保存
   - 入力フォルダをローカルに同期
   - Claude Codeをヘッドレスで実行し、成果物を `output/` に書き出す
4. 回答と成果物をS3に同期し、状態を `SUCCEEDED` か `FAILED` にして自分で終了
5. 呼び出し側は `get_job` で状態を確認する。完了していれば回答本文（成果物があればダウンロードURLも）が返る

**状態一覧**

| 状態 | 意味 | 次の状態 |
| --- | --- | --- |
| CREATED | ジョブ作成済み、入力待ち | QUEUED, DELETED |
| QUEUED | 実行指示を受付、MicroVM起動中 | RUNNING, FAILED, DELETED |
| RUNNING | MicroVMで処理中 | SUCCEEDED, FAILED, DELETED |
| SUCCEEDED | 回答あり | QUEUED（再実行）, DELETED |
| FAILED | エラー。理由を `error` に記録 | QUEUED（再実行）, DELETED |
| DELETED | `delete_job` で停止・削除済み | — |

**タイムアウト**：MicroVMの最大稼働時間（上限8時間）を超えたジョブは強制終了される。初期値は2時間とし、超過時はディスパッチャーLambdaの定期実行がDynamoDBのハートビートの途絶で `FAILED` にする。

**進捗の返し方**：ワーカーはAgent SDKのメッセージを短い進捗イベントに要約してDynamoDBに書き、呼び出し側は `get_job` で前回以降のイベントを受け取る。呼び出し側のClaudeは受け取るたびに利用者へ進捗を伝え、完了まで `get_job` を呼び続ける。

- イベントの例：「入力を取得（3/10件）」「見積書.xlsx を読み込み中」「スキャンPDFを読み取り中（12/40ページ）」「回答を作成中」
- 各イベントは段階（取り込み・変換・読解・回答作成）、処理済みファイル数、経過時間を持つ
- `get_job` は変化があるまで最大30秒待つロングポーリングにして、呼び出し回数とトークン消費を抑える

**タイムアウトからの復旧**：ジョブは呼び出し側の接続と切り離されているので、呼び出し側がタイムアウトしても、会話が終わっても、MicroVMは処理を続ける。復旧は `get_job` を呼び直すだけでよい。

| 状況 | 復旧方法 |
| --- | --- |
| 進捗確認の途中で呼び出し側がタイムアウト | 同じ `job_id` で `get_job`。`cursor` があれば続きから、なければ直近20件の進捗を受け取る |
| 会話が切れて `job_id` が分からない | `job_id` を省略して `get_job` を呼び、自分のジョブ一覧からタイトルと作成日時で選ぶ |
| ジョブ自体が失敗した（時間切れなど） | 入力はS3に残っているので、同じ `job_id` で `run_job` を呼び直す |

- 復旧できるのは作成から1日以内（S3のライフサイクルとDynamoDBのTTLの期限）
- 同じ利用者なら別の会話や別の端末からも復旧できる（`owner` で照合）
- 一覧で見分けられるよう、`create_job` では `title` を付けることを推奨する

* 再実行は `output/` を上書きし、`get_job` は最新の回答を返す
* 作成から20時間を過ぎたジョブの `run_job` は拒否する（削除期限の直前に実行を始めない）

## MCPツール定義

ツールは4個に絞る（ツール定義が呼び出し側のコンテキストを消費するため、説明文も短くする）。ファイルの中身はMCPの会話を通さず、S3の署名付きURLかURL取り込みで受け渡す。

| ツール | 主な入力 | 返り値 | 備考 |
| --- | --- | --- | --- |
| `create_job` | `title`（任意）, `files[]`（アップロードするファイルの名前・サイズ）, `urls[]`, `inline_files[]`（名前と中身） | `job_id`、ファイルごとのアップロードURL | 3種類の入力はどれも任意で併用可。1ファイル1GB・合計5GBを超える申告は拒否する。URLのダウンロードはMicroVMが実行。`inline_files` は数MBまで |
| `run_job` | `job_id`, `instruction` | 状態 | ジョブを受け付け、最初の進捗が出るまで最大30秒待って返す。完了・失敗したジョブも再実行でき、同じ入力に別の指示も出せる。同時実行の上限を超えていればエラー（呼び出し側が後で再試行） |
| `get_job` | `job_id`（省略で一覧）、cursor（前回の続き、任意。省略時は直近20件） | 状態、経過時間、前回以降の進捗イベント、エラー。完了時は回答本文と、成果物があればダウンロードURLも | 変化があるまで最大30秒待って返す。一覧は自分のジョブのみ。URLの有効期限は1時間 |
| `delete_job` | `job_id` | 状態 | 状態を DELETED にし、実行中ならディスパッチャーがMicroVMを終了して枠を空ける。以後MCPからは見えなくなり、ファイルは1日後のライフサイクルで消える |

**指示と回答**：呼び出し側の指示はそのままMicroVM内のClaudeに渡す。主な出力は `output/answer.md`（回答本文）で、`get_job` が本文をそのまま返す。回答には根拠にしたファイル名と、ページ・シート・スライドの位置を添える。表や資料の作成など指示がファイルを求めるときだけ、xlsx・docx・pptx・PDFなどを追加で作る。回答が長すぎる場合、`get_job` は冒頭部分と全文のダウンロードURLを返す。

**他のMCPとの連携**：Google DriveやBoxなどのMCPがダウンロードURLを返せる場合は `create_job` の `urls` に渡す。中身しか返さない場合だけ `inline_files` に渡す。

## 前段Lambda（MCPゲートウェイ）

固定URLのMCPエンドポイントとして、認証・ジョブ管理・MicroVM起動だけを担う。重い処理は一切しない。

- **公開方法**：Lambda Function URL（`InvokeMode: RESPONSE_STREAM`）。MCPはStreamable HTTPで実装
- **ランタイム**：Node.js（TypeScript）、MCP TypeScript SDK v2（`createMcpHandler`）。arm64、メモリ512MB、タイムアウト60秒（`get_job` の最大30秒待ちに余裕を持たせる）
- **認証**：MCPの認可仕様（2026-07-28版）に従い、前段LambdaをOAuthのリソースサーバーとして実装する。保護リソースのメタデータで認可サーバー（Cognito）を示し、受け取ったアクセストークン（JWT）を署名・発行者・対象・スコープで検証する。利用者IDはトークンの主体。クライアントがどの方式でトークンを得るかは認可サーバー側の設定の話で、このMCPサーバーの設計では扱わない。ユーザープールはデプロイ時のパラメータで、既存プール（プールID・ドメイン）を指定するか、未指定なら新規作成する
- **MicroVMの起動**：前段Lambdaは `run_job` でジョブを `QUEUED` にするだけで、MicroVMは直接操作しない。起動・終了はすべてディスパッチャーLambdaが行う
- **状態の管理**：DynamoDBのジョブ表を読み書き。MicroVMからの完了報告もこの表に書かれる
- **署名付きURL**：S3の署名付きPUT/GETを発行する。PUTはファイルサイズを署名に含め、申告と違うサイズのアップロードを拒否させる。1ファイル1GB以下なので、マルチパートアップロードは使わない

**MicroVMへのHTTP接続は使わない**：ジョブの受け渡しはS3とDynamoDBで行うため、MicroVMの受信エンドポイントとJWEトークンは不要。

**ディスパッチャーLambda**：待機中ジョブの起動と、止まったジョブの掃除を担う小さなLambdaを別に置く。

- DynamoDB Streamsでジョブの状態変化を受け、`QUEUED` になったジョブのMicroVMを起動する。ジョブが SUCCEEDED・FAILED・DELETED になったら、そのMicroVMを終了させる。delete\_job で DELETED になった実行中ジョブも同様（MicroVMの操作権限はディスパッチャーだけが持つ）
- 5分ごとの定期実行（EventBridge Scheduler）で、ハートビートが3分以上途絶えた `RUNNING` のジョブを `FAILED` にし、MicroVMが残っていれば終了させる
- 定期実行のたびに、取りこぼした `QUEUED` のジョブがないかも確認する

* 起動時は `--run-hook-payload` でジョブIDを渡し、最大稼働時間をジョブのタイムアウト（初期値2時間）にする。MicroVMのアイドル判定は受信通信で測られるため、受信のないワーカーが処理中にサスペンドされないよう、アイドル待機時間も最大稼働時間と同じにする
* DynamoDB Streamsはイベントフィルタで状態の変化だけを受け取り、30秒ごとのハートビート更新では起動しない

**MCPの仕様バージョン**：最新の2026-07-28版に準拠する。この版でMCPはステートレスになり、Lambdaとの相性が良い。

- セッション（`Mcp-Session-Id`）と初期化ハンドシェイクは使わない。各リクエストの `_meta` にあるプロトコルバージョンとクライアント能力を見て処理し、`server/discover` を実装する
- 呼び出しをまたぐ状態は、サーバーが発行した `job_id` をツール引数で受け渡す（仕様が推奨する形そのもの）
- 長時間処理は `run_job` と `get_job` のポーリングで扱う。公式拡張のtasks（`io.modelcontextprotocol/tasks`）は、呼び出し側が対応したら追加を検討する（初期は対象外）
- `tools/list` はツールを決まった順で返し、`ttlMs` と `cacheScope` を付ける。リクエストヘッダー `Mcp-Method` / `Mcp-Name` を検証する
- 非推奨になったLogging・Sampling・Rootsは使わない。ログはOpenTelemetryとCloudWatchに出す
- クライアントの対応には時間差があるため、SDKが対応していれば一つ前の2025-11-25版での接続も受け付ける

出典：[MCP 2026-07-28 変更点](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

## MicroVM（回答ワーカー）

1ジョブ＝1 MicroVMの使い捨て。起動時にジョブIDを受け取り、終わったら自分で終了する。

**イメージ**（ベースはLambda提供のAmazon Linux 2023、arm64）

- Claude Code（Bedrock向け設定：`CLAUDE_CODE_USE_BEDROCK=1`、リージョン、モデルID）
- AnthropicのAgent Skills（docx・xlsx・pptx・pdf）を `~/.claude/skills` に配置
- Python（Claudeがファイル処理に使う道具。自前のコードでは使わない）：pdfplumber、PyMuPDF、python-docx、openpyxl、python-pptx、pandas、DuckDB、Pillow
- コマンド：LibreOffice（headless）、poppler-utils、libvips、libheif、exiftool
- 日本語フォント：Noto Sans/Serif CJK
- ワーカー本体：TypeScript（Node.js）製。ライフサイクルフック用サーバーと、Claude Agent SDK（TypeScript版）でClaude Codeを動かすジョブ実行部

**ライフサイクルフック**

| フック | 処理 |
| --- | --- |
| `/ready` | ビルド時。ワーカーの起動完了を返す |
| `/run` | ジョブIDを受け取り、作業を別プロセスで開始してすぐ返す |
| `/terminate` | `未完了なら FAILED を記録する。制限時間が短いので成果物の退避はしない（タイムアウト時の途中結果は残らない）` |

**ジョブ実行の手順**

1. DynamoDBからジョブ情報（指示、入力一覧）を取得し `RUNNING` に更新
2. URL入力をダウンロードしてS3の `input/` に保存。その後 `input/` をローカルの `/work/input` に同期
3. `query()` を、作業ディレクトリ `/work`、許可ツールと最大ターン数を限定して、Claude Agent SDKで実行。システムプロンプトで「`input/` は読み取り専用、成果物は `output/`、最後に `output/answer.md` を書く」と指示
4. 実行中は30秒ごとにハートビートと進捗メモをDynamoDBへ書く
5. `output/` をS3へ同期し、状態を更新。`terminate-microvm` は呼ばない。終了は状態の変化を受けたディスパッチャーが行う

**エージェント**：Claude Agent SDK（TypeScript版）を採用する。Claude Codeと同じエージェントループと道具（ファイル読み書き、検索、シェル実行、PDF・画像の読み取り、スキル、サブエージェント）を、無人で1回の指示を最後まで走らせる形で使う。

- 権限確認は誰にも聞けないため、許可ツール・書き込み先・最大ターン数を設定で固定する
- システムプロンプトと読み込むスキルはコード側で明示的に指定する
- Bedrockへは環境変数（`CLAUDE_CODE_USE_BEDROCK=1` ほか）で接続する
- モデルは日本国内推論（`jp.`）で使えるClaudeを使い、初期値はClaude Sonnet 4.6（`jp.anthropic.claude-sonnet-4-6`）。モデルIDはディスパッチャーLambdaの設定に持ち、起動時に `--run-hook-payload` でワーカーへ渡すので、MicroVMイメージを作り直さずに変更できる。Opusは基本使わない。ファイルが多いときはサブエージェントで分担する
- 進捗メッセージはストリームで受け取り、DynamoDBのハートビートに使う

**サイズ**：基準を4GB / 2 vCPUとする。MicroVMのディスク上限はサイズで決まり、標準の2GB基準では8GBしかない。イメージ（LibreOfficeなどで数GB）に入力5GBと作業領域を足すと収まらないため、ディスク16GBの4GB基準を選ぶ。処理が重いときは16GB / 8 vCPUまで自動で伸びる。

| 基準 | ピーク | ディスク上限 |
| --- | --- | --- |
| 2GB / 1 vCPU（標準） | 8GB / 4 vCPU | 8GB |
| **4GB / 2 vCPU（採用）** | 16GB / 8 vCPU | 16GB |
| 8GB / 4 vCPU | 32GB / 16 vCPU | 32GB |

出典：[MicroVM images（MicroVM sizing）](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)

**同時実行**：ジョブごとに別のMicroVMを起動するので、複数のジョブを同時に走らせられる。ジョブ間でファイルも状態も共有しない。費用の暴走を防ぐため、利用者ごとの同時実行数に上限（初期値3）を設け、超えた `run_job` はエラーを返す。待ち行列は持たず、呼び出し側は実行中のジョブの完了か `delete_job` で枠を空けてから再試行する。アカウント全体の同時起動数のクォータは事前に確認する。

## ストレージとデータ設計

ファイルはS3の1バケット、ジョブの状態はDynamoDBの1テーブルに置く。どちらもオンデマンド課金で固定費はない。

**S3レイアウト**

```
s3://<bucket>/jobs/<job_id>/
  input/      呼び出し側が置いた元ファイル
  output/     成果物（answer.md ほか）
  logs/       Claude Codeの実行ログ
  cache/      抽出キャッシュ
```

- SSE-S3で暗号化、パブリックアクセスはすべてブロック
- ライフサイクルルールで `jobs/` 配下を作成から1日後に削除

**抽出キャッシュ**：変換・テキスト抽出・ページ画像化の結果を `jobs/<job_id>/cache/` に保存し、再実行や追加の質問ではそのまま使い回す（ジョブの入力は作成後に変わらない）。2回目以降は前処理を飛ばせるので、時間とトークン代が下がる。キャッシュもライフサイクルで1日後に消える。

**削除**：S3のライフサイクルルール（作成から1日）だけで消す。DynamoDBのジョブ項目もTTLで1日後に消える。入力も成果物も最大1日残るので、成果物はその間に受け取る。

**DynamoDB：Jobsテーブル**（パーティションキー `job_id`）

| 属性 | 型 | 内容 |
| --- | --- | --- |
| `job_id` | 文字列 | ULID |
| `owner` | 文字列 | 認証で得た利用者ID |
| `created_at` | 数値 | 作成時刻 |
| `status` | 文字列 | 処理フローの状態 |
| `title` | 文字列 | 一覧で見分けるための名前 |
| `instruction` | 文字列 | 指示 |
| `inputs` | リスト | ファイル名、種類（upload/url）、URL、サイズ |
| `microvm_id` | 文字列 | 起動したMicroVM |
| `progress` | リスト | 進捗イベント（直近50件、連番つき） |
| `heartbeat_at` | 数値 | 最終ハートビート時刻 |
| `error` | 文字列 | 失敗理由 |
| `ttl` | 数値 | 作成から1日後に自動削除 |

インデックスは `owner`（パーティションキー）と `created_at`（ソートキー）のGSIを1つ。ジョブ一覧と、利用者ごとの同時実行数の確認に使う。

## ファイル形式別の処理方針

大量の文字や表はスクリプトで抽出し、レイアウトや図が意味を持つ部分だけClaudeに画像として見せる。大きなファイルをClaudeの文脈にそのまま入れることはしない。

| 形式 | 抽出の基本 | Claudeに見せるもの | 注意 |
| --- | --- | --- | --- |
| docx | python-docxで本文・表 | 抽出テキスト、必要なら PDF化したページ画像 | 変更履歴やコメントも抽出対象 |
| xlsx | openpyxl・pandasでシート読込 | 集計結果、シート構成 | 巨大シートはDuckDBで集計 |
| pptx | python-pptxでテキスト・ノート | スライドを画像化したもの | 図が主役のスライドは画像で判断 |
| doc / xls / ppt | LibreOfficeで新形式へ変換 | 変換後と同じ | 変換に失敗したファイルは記録して続行 |
| PDF（テキスト） | pdfplumber・PyMuPDFで本文・表 | 抽出テキスト、表、要所のページ画像 | 段組みや表の崩れに注意 |
| PDF（スキャン） | popplerでページ画像化 | ページ画像 | OCRは使わずClaudeが画像を直接読む。ページが多いときはサブエージェントで分担 |
| 画像（jpg/png/heic） | Pillow・libvipsで長辺1,500px程度に縮小、exiftoolでメタデータ | 縮小画像、細部は切り出し | HEICはlibheifで変換 |

**大量ファイル**：数十〜数百件はClaude Codeがファイルごとに抽出・要約してJSONに貯め、最後に指示に沿って回答をまとめる。

**サイズ上限**：1ファイル1GB、1ジョブ合計5GBまで。アップロード分は `create_job` の申告と署名付きURLで制限し、URL取り込み分はMicroVMがダウンロード中にサイズを数え、超えたらジョブを `FAILED` にする。

## セキュリティ

入力ファイルは信頼できないものとして扱う。文書に埋め込まれた指示でClaudeが想定外の操作をしても、被害がそのジョブの中で止まるように権限を絞る。

- **隔離**：1ジョブ1 MicroVM（Firecracker）。ジョブ間でディスクもメモリも共有しない
- **IAM（MicroVM）**：実行ロールはS3の `jobs/` 配下、ジョブ表、指定モデルのBedrock呼び出しに限る。実行ロールはジョブ間で共通になる見込みのため、S3・DynamoDBへのアクセスはワーカー本体（特権ユーザー）だけが行い、Claudeは非特権ユーザーで動かしてBedrock呼び出しに限った認証情報だけを渡す
- **IAM（前段Lambda）**：S3の署名付きURL発行とDynamoDBのみ。MicroVMの操作権限はディスパッチャーLambdaだけが持つ
- **認証**：Cognitoで発行したアクセストークンを前段Lambdaが毎回検証。`owner` が一致しないジョブには一切アクセスさせない
- **Claude Codeの権限**：作業ディレクトリ外への書き込み禁止、`input/` は読み取り専用。外部送信はURL取り込みの段階だけで済ませ、回答作成中のネットワーク利用は最小にする
- **送信先の制限**：URL取り込みが終わった時点で、MicroVM内に送信用プロキシ（Bedrock・S3・DynamoDBのホスト名だけ許可）を置き、nftablesでプロキシ以外からの送信を止める（イメージ作成時にOS権限 ALL を付与）。文書に仕込まれた指示でデータを外へ送られるのを防ぐ。URL取り込みは許可ドメインのリストで制限し、Claudeが任意のURLへ送信できない設定にする
- **データ保持**：S3とDynamoDBは作成から1日で自動削除。署名付きURLの有効期限は1時間
- **ログ**：Claude Codeの実行ログを `logs/` に残し、後から何をしたか追えるようにする

## コスト見積もり

月100件（小70・中25・大5）なら月額は約135ドル（1ドル150円で約2万円）。9割以上がBedrockのトークン代で、MicroVMなどのAWSインフラは月9ドル程度に収まる。使わない月の固定費は1ドル未満。

**前提**

- モデルはClaude Sonnet 4.6の日本国内推論。100万トークンあたり入力3.3ドル、出力16.5ドル、キャッシュ読み込み0.33ドル、書き込み4.125ドル（グローバル推論より1割高い）
- MicroVMは4GB / 2 vCPU基準。処理時間の20%は上限の16GB / 8 vCPUまでバーストすると仮定
- MicroVMは東京の単価（米国東部の約1.16倍）
- トークン量はClaude Codeが複数ターンで読み進める前提の概算。入力の8割をキャッシュ読み込みと仮定

**1ジョブあたり**

| 規模 | 想定 | 処理時間 | トークン（入力 / 出力） | Bedrock | MicroVM | 合計 |
| --- | --- | --- | --- | --- | --- | --- |
| 小 | PDF・Office 3件、計30ページ程度 | 5分 | 30万 / 8千 | 約0.46ドル | 約0.03ドル | 約0.5ドル |
| 中 | 10件、計200ページ程度、画像あり | 15分 | 150万 / 3万 | 約2.1ドル | 約0.1ドル | 約2.2ドル |
| 大 | 50件、スキャンPDFや大きなExcelを含む | 45分 | 600万 / 10万 | 約8.2ドル | 約0.3ドル | 約8.5ドル |

**月額（100件：小70・中25・大5）**

| 項目 | 月額 |
| --- | --- |
| Bedrock（Sonnet 4.6・日本国内推論） | 約126ドル |
| MicroVM（計算＋起動時のスナップショット読み込み） | 約8ドル |
| MicroVMイメージの保存（4GB想定） | 約0.3ドル |
| Cognito（少人数なら無料枠内） | ほぼ0ドル |
| 前段Lambda・DynamoDB・S3 | ほぼ0ドル（無料枠内か数セント） |
| **合計** | **約135ドル** |

**変動要因**

- モデルを変えれば、Bedrock分はその単価に比例して変わる。ファイル単位の読み取りだけ安いモデルのサブエージェントに任せれば下げられる
- スキャンPDFや画像はページ・枚数分の画像トークンがかかるため、事前の縮小が効く
- 成果物のダウンロードにはS3の外向き転送料がかかる。大きなファイルを頻繁に落とす場合だけ効いてくる

出典：[AWS Lambda料金（MicroVMs）](https://aws.amazon.com/lambda/pricing/) · [Claude Sonnet 4.6の料金（日本国内推論を含む）](https://cloudprice.net/models/litellm/claude-sonnet-4-6) · [日本国内クロスリージョン推論の紹介](https://aws.amazon.com/jp/blogs/news/amazon-bedrock-now-supports-japan-cross-region-inference)

## 未確認事項・リスク・実装ステップ

実装前の確認事項は、MicroVM内の送信制限（nftables）の実機確認を除いて解決済み。

**未確認事項**

- [x] `/run` フックへのパラメータの渡し方 → `run-microvm` の `--run-hook-payload`（最大16KB）で渡せ、`microvmId` も一緒に届く。ジョブIDをこれで渡す（[出典](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)）
- [x] MicroVMのディスク容量の上限（合計5GBの入力と作業領域が収まるか）
- [x] 東京リージョンの単価とクォータ → vCPU秒0.0000322421ドル（米国東部の約1.16倍）。メモリ上限は1,024GB（4GB基準で256台）、起動APIは毎秒5件。今回の規模では問題なし（[出典](https://ecorpit.com/aws-lambda-microvms-10-regions-400gb-quota-cost-gap-2026/)）
- [x] MicroVMの自己終了 → 終了権限はイメージ単位でしか絞れず、許可すると他のジョブのMicroVMも止められてしまう。自己終了はやめ、完了を検知したディスパッチャーが終了させる（[出典](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)）
- [x] LibreOfficeのaarch64版 → AL2023は公式サポート対象で、aarch64のRPMが配布されている。イメージ作成時にダウンロードして入れる（[出典](https://docs.aws.amazon.com/linux/al2023/ug/al2023-libreoffice.html)）
- [x] Bedrockのモデル → Sonnet 5.5・Opus 5.5は東京からの日本国内推論が未提供。日本国内推論ではSonnet 4.6（`jp.anthropic.claude-sonnet-4-6`）などが使えるため、これを初期値にする（[出典](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html)）

* [ ] MicroVM内のnftablesによる送信制限 → OS権限 `ALL` でネットワーク名前空間などの操作が可能と明記されており、使える見込み。AWSのIPは変わるので、ホスト名で絞れる送信用プロキシ（Bedrock・S3・DynamoDBのみ許可）を中に置き、nftablesでプロキシ以外からの送信を止める方式を第一候補にする。実機で確認する

- [ ] MicroVM内で実行ロールの認証情報がどう渡されるか（環境変数かメタデータ風のエンドポイントか）。ワーカーとClaudeのユーザー分離で、Claude側にBedrock専用の認証情報だけを渡す方法が決まる

* [x] MCPのTypeScript SDK → v2が2026-07-28版対応の安定版。`createMcpHandler` が新版とステートレスな旧版（2025年版）の両方を受け付ける（[出典](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)）

**リスク**

- MicroVMは2026年6月公開の新サービスで、仕様変更やリージョン差がありうる
- 文書内の指示によるプロンプトインジェクション。権限の絞り込みとログで影響を限定する
- Bedrockのトークン代が想定を超える。ジョブごとの上限（最大ターン数・時間）を設ける

* 日本国内推論で使えるのは一世代前のモデル（Sonnet 4.6など）が中心。5.5世代の日本国内推論が提供されたら切り替える。同時実行時は日本国内推論のトークン流量上限に当たりうるため、リトライとクォータ引き上げ申請を行う
* MicroVMの実行ロールでジョブごとの権限分離ができない。ワーカー本体とClaudeのユーザー分離、送信用プロキシで補う

**実装ステップ**

1. MicroVMの仕様確認（上記の未確認事項）
2. MicroVMイメージ：Dockerfileとワーカー、単体で1ジョブを実行できる状態まで
3. 前段Lambda：4個のツールとCognitoによるOAuth認証、ディスパッチャーLambda、Function URL
4. CDKでS3・DynamoDB・IAM・Lambda・MicroVMイメージをまとめてデプロイ
5. Claude Codeから接続して、Office・PDF・画像の混在ジョブで通し試験
6. 自作エージェントに組み込んで通し試験

## 設計決定録

設計判断を番号つきで残す。決定を変えるときも行は消さず、決定・理由を書き換えて経緯を理由欄に残す。

| # | 論点 | 決定 | 理由 |
| --- | --- | --- | --- |
| 1 | 設計書の置き場所 | この `docs/DESIGN.md` を正とする。作業の記録は `docs/implementation-log.md` に日付ごとに残す | 設計と実装の食い違いをリポジトリの中だけで追えるようにする。起草時の構成図は移せなかったため未作成として扱う |
| 2 | リポジトリ構成 | pnpm workspace のモノレポ。`packages/shared`（共有の型と定数）・`packages/gateway`（前段 Lambda）・`packages/dispatcher`（ディスパッチャー Lambda）・`packages/worker`（MicroVM ワーカー）・`infra/`（CDK）。lockfile は 1 つ | ジョブの状態や DynamoDB 項目の型を gateway・dispatcher・worker の三者で共有するため。部品ごとに lockfile を分けると、共有型のコピーや相対パスでの import が要る |
| 3 | ツールの版 | mise で Node 24・pnpm 10 を固定する | Node は Lambda のランタイム（`nodejs24.x`）と揃える。pnpm は 12 が最新だが、手元の mise（2026.1.2）が pnpm 11 以降の配布物の名前に対応しておらず入れられない。mise を更新したら 11 以降へ上げる |
| 4 | TypeScript の設定 | TypeScript 7.0。`module: preserve`（`moduleResolution: bundler`）、`noEmit`、`verbatimModuleSyntax`。共通設定は `tsconfig.base.json`、各パッケージが継承する。workspace のパッケージは `exports` で `src/index.ts` を直接指す | 実行されるコードはどれも esbuild でまとめる（Lambda は NodejsFunction、ワーカーはイメージ作成時）か tsx で動かす（CDK）ため、tsc の出力は使わず型検査だけに使う。共有パッケージのビルド工程を省ける |
| 5 | Lint・フォーマット | Biome 2.5。設定はルートの `biome.json` 1 つ | billing-mcp と同じ道具。workspace 全体を 1 回で検査できる |
| 6 | テスト | Vitest 5 に統一し、CDK の Template テストも Vitest で書く。ルートの `vitest.config.ts` の `projects` で全パッケージを 1 回で回す | これまでのリポジトリでは CDK が jest + @swc/jest、サーバーが Vitest と分かれていた。Template アサーションはテストランナーに依存しないため、道具を 1 つに減らせる |
| 7 | CDK の書き方 | ops-agent-sample-on-aws と同じ。スタックは関数（`createSandboxMcpStack()`）で定義し、デプロイパラメータは型付きの `infra/parameter.ts`（gitignore。`parameter.sample.ts` をコミット）に集める。`cdk.json` は tsx で動かす | 既存リポジトリと書き方を揃えて読みやすくする。CDK context はパラメータに使わない |
| 8 | MCP SDK | 実装の段階で `@modelcontextprotocol/server`（SDK v2、2.3 系）を入れる。v1 系の `@modelcontextprotocol/sdk` は使わない | 2026-07-28 版の仕様とステートレスな `createMcpHandler` は v2 にしかない。billing-mcp が v1 に留まったのは MCP Apps（ext-apps）の都合で、このサーバーは MCP Apps を使わない |
| 9 | CI | GitHub Actions。mise-action で版を揃え、install（frozen）→ 型チェック → lint → テスト → synth を回す | コミット前の手元チェックと同じ内容にする |
