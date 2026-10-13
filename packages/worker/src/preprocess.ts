// 前処理。入力ファイルを形式ごとの決まった手順で、エージェントが読みやすいテキスト・CSV・画像にする。
// 結果は extracted ディレクトリの下に、元のファイル名のフォルダごとに置き、全体の目次を index.md に書く。

import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { extractDocx, extractPptx, readSheetNames } from "./ooxml";

/** 外部コマンドを実行して標準出力を返す。終了コードが 0 でなければ例外にする */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

export type FileKind = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "text";

export interface FileSummary {
  name: string;
  kind: FileKind | "unsupported";
  /** 作ったものの説明（extracted からの相対パスを含む） */
  outputs: string[];
  /** 一部だけ失敗したときの説明。続きは処理する */
  warnings: string[];
  /** ファイル全体の前処理に失敗したときの理由 */
  error?: string;
  /** このファイルの前処理にかかった時間（実測の報告用。目次には書かない） */
  durationMs?: number;
}

/** ページ画像と縮小画像の長辺 */
const IMAGE_LONG_SIDE = 1500;

const KINDS: Record<string, { kind: FileKind; legacy?: string }> = {
  ".docx": { kind: "docx" },
  ".docm": { kind: "docx" },
  ".doc": { kind: "docx", legacy: "docx" },
  ".xlsx": { kind: "xlsx" },
  ".xlsm": { kind: "xlsx" },
  ".xls": { kind: "xlsx", legacy: "xlsx" },
  ".pptx": { kind: "pptx" },
  ".pptm": { kind: "pptx" },
  ".ppt": { kind: "pptx", legacy: "pptx" },
  ".pdf": { kind: "pdf" },
  ".jpg": { kind: "image" },
  ".jpeg": { kind: "image" },
  ".png": { kind: "image" },
  ".heic": { kind: "image" },
  ".heif": { kind: "image" },
  ".txt": { kind: "text" },
  ".md": { kind: "text" },
  ".csv": { kind: "text" },
  ".tsv": { kind: "text" },
  ".json": { kind: "text" },
};

export function detectKind(name: string) {
  return KINDS[extname(name).toLowerCase()];
}

/** ファイル名・シート名を、フォルダやファイルの名前に使える形にする */
export function safeName(name: string): string {
  const replaced = name.replace(/[/\\:*?"<>|\p{Cc}]/gu, "_");
  return replaced === "" || /^\.+$/.test(replaced) ? `_${replaced}` : replaced;
}

/** used にある名前と重なるときは、拡張子の前に連番を付けて、使っていない名前にする。選んだ名前は used に足す */
export function uniqueName(used: Set<string>, name: string): string {
  const dot = name.lastIndexOf(".");
  const [base, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}${ext}`;
  used.add(candidate);
  return candidate;
}

/** 連番のファイル名。総数の桁に揃え、最低 3 桁にする */
export function pageName(index: number, total: number, ext: string): string {
  const width = Math.max(3, String(total).length);
  return `${String(index).padStart(width, "0")}.${ext}`;
}

/** pdftotext の出力を、改ページ（\f）でページごとに分ける */
export function splitPages(text: string): string[] {
  const pages = text.split("\f");
  // 最後のページの後ろにも \f が付くので、末尾の空の要素を除く
  if (pages.length > 1 && pages.at(-1) === "") pages.pop();
  return pages;
}

/** CSV のレコード数と、1 行目の列数を数える。引用符の中の改行はレコードの区切りにしない */
export function csvShape(text: string): { rows: number; columns: number } {
  let rows = 0;
  let columns = 0;
  let fields = 1;
  let quoted = false;
  let empty = true;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") fields++;
    else if (!quoted && char === "\n") {
      if (rows === 0) columns = fields;
      rows++;
      fields = 1;
      empty = true;
      continue;
    }
    if (char !== "\r") empty = false;
  }
  if (!empty) {
    if (rows === 0) columns = fields;
    rows++;
  }
  return { rows, columns };
}

/** identify -format "%[EXIF:*]" の出力（exif:名前=値 の行）を「名前: 値」の行にする */
export function formatExif(output: string): string {
  return output
    .split("\n")
    .map((line) => /^exif:([^=]+)=(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]}: ${match[2]}`)
    .join("\n");
}

interface Context {
  run: RunCommand;
  /** 作業用の一時ディレクトリ（ファイルごとに作り、終わったら消す） */
  tmp: string;
  /** このファイルの結果を置くフォルダ */
  out: string;
  /** extracted から見た out の相対パス */
  rel: string;
  summary: FileSummary;
}

/** ファイルを移す。一時ディレクトリと出力先が別のファイルシステムでも動くよう、rename できなければ写して消す */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from);
  }
}

/**
 * LibreOffice のプロファイル（利用者ごとの設定）の場所。MicroVM では初回の起動に時間がかかったため（実測 B1）、
 * イメージの作成時に一度変換を走らせてここに作っておく（Dockerfile と揃える）
 */
export const LIBREOFFICE_PROFILE_DIR = "/opt/libreoffice-profile";
const LIBREOFFICE_PROFILE = `-env:UserInstallation=file://${LIBREOFFICE_PROFILE_DIR}`;

/** 元のファイル名に依らないよう、一時ディレクトリの決まった名前に symlink する（できなければ写す） */
async function stage(input: string, destination: string): Promise<string> {
  await symlink(input, destination).catch(() => copyFile(input, destination));
  return destination;
}

/** LibreOffice で変換し、出力ファイルのパスを返す。元のファイル名に依らないよう、一時ディレクトリに別名で置いてから変換する */
async function libreoffice(
  ctx: Context,
  input: string,
  sourceExt: string,
  filter: string,
  outExt: string,
): Promise<string> {
  const source = await stage(input, join(ctx.tmp, `source${sourceExt}`));
  const outDir = join(ctx.tmp, `lo-${outExt}`);
  await ctx.run("soffice", [
    "--headless",
    "--norestore",
    LIBREOFFICE_PROFILE,
    "--convert-to",
    filter,
    "--outdir",
    outDir,
    source,
  ]);
  return join(outDir, `source.${outExt}`);
}

/** PDF の各ページを画像にして dir に NNN.png で置き、枚数を返す */
async function renderPages(
  ctx: Context,
  pdf: string,
  dir: string,
): Promise<number> {
  const imageDir = join(ctx.tmp, "page-images");
  await mkdir(imageDir, { recursive: true });
  await ctx.run("pdftoppm", [
    "-png",
    "-scale-to",
    String(IMAGE_LONG_SIDE),
    pdf,
    join(imageDir, "p"),
  ]);
  // pdftoppm はページ数に応じて p-1.png・p-01.png などの名前で出すので、番号を読んで付け直す
  const images = (await readdir(imageDir))
    .map((file) => ({ file, page: Number(/^p-(\d+)\.png$/.exec(file)?.[1]) }))
    .filter((image) => Number.isInteger(image.page));
  for (const image of images) {
    await move(
      join(imageDir, image.file),
      join(dir, pageName(image.page, images.length, "png")),
    );
  }
  await rm(imageDir, { recursive: true, force: true });
  return images.length;
}

/** PDF からページごとのテキストと画像を作り、ページ数を返す */
async function pdfPages(
  ctx: Context,
  pdf: string,
  dirName: string,
): Promise<{ pages: number; textPages: number }> {
  const dir = join(ctx.out, dirName);
  await mkdir(dir, { recursive: true });
  const textFile = join(ctx.tmp, "pages.txt");
  await ctx.run("pdftotext", ["-layout", "-enc", "UTF-8", pdf, textFile]);
  const texts = splitPages(await readFile(textFile, "utf8"));
  let textPages = 0;
  for (const [i, text] of texts.entries()) {
    if (text.trim() === "") continue;
    textPages++;
    await writeFile(join(dir, pageName(i + 1, texts.length, "txt")), text);
  }
  const pages = await renderPages(ctx, pdf, dir);
  return { pages: Math.max(pages, texts.length), textPages };
}

async function processPdf(ctx: Context, input: string): Promise<void> {
  const { pages, textPages } = await pdfPages(ctx, input, "pages");
  ctx.summary.outputs.push(
    `${ctx.rel}/pages/NNN.txt: ページごとのテキスト（${pages} ページ中 ${textPages} ページ）`,
    `${ctx.rel}/pages/NNN.png: ページ画像（${pages} ページ）`,
  );
  if (textPages === 0) {
    ctx.summary.warnings.push(
      "テキストが取れません（スキャンした PDF など）。ページ画像を見てください",
    );
  }
}

async function processDocx(ctx: Context, input: string): Promise<void> {
  await writeFile(join(ctx.out, "text.md"), extractDocx(await readFile(input)));
  ctx.summary.outputs.push(
    `${ctx.rel}/text.md: 本文・表・コメント・変更履歴（[挿入]・[削除] の印つき）`,
  );
  try {
    const pdf = await libreoffice(ctx, input, ".docx", "pdf", "pdf");
    const { pages } = await pdfPages(ctx, pdf, "pages");
    ctx.summary.outputs.push(
      `${ctx.rel}/pages/NNN.txt・NNN.png: ページごとのテキストと画像（${pages} ページ。ページの位置を示すときに使う）`,
    );
  } catch (error) {
    ctx.summary.warnings.push(`ページ画像を作れません: ${message(error)}`);
  }
}

async function processPptx(ctx: Context, input: string): Promise<void> {
  const slides = extractPptx(await readFile(input));
  const dir = join(ctx.out, "slides");
  await mkdir(dir, { recursive: true });
  for (const slide of slides) {
    const lines = [
      `# スライド ${slide.number}${slide.hidden ? "（非表示）" : ""}`,
      "",
      slide.text,
    ];
    if (slide.notes) lines.push("", "## ノート", "", slide.notes);
    await writeFile(
      join(dir, pageName(slide.number, slides.length, "md")),
      `${lines.join("\n")}\n`,
    );
  }
  ctx.summary.outputs.push(
    `${ctx.rel}/slides/NNN.md: スライドごとのテキストとノート（${slides.length} 枚）`,
  );
  try {
    // 非表示のスライドも画像にし、テキストと番号を揃える
    const pdf = await libreoffice(
      ctx,
      input,
      ".pptx",
      'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}',
      "pdf",
    );
    const images = await renderPages(ctx, pdf, dir);
    ctx.summary.outputs.push(
      `${ctx.rel}/slides/NNN.png: スライド画像（${images} 枚）`,
    );
    if (images !== slides.length) {
      ctx.summary.warnings.push(
        `スライド画像の枚数（${images}）がスライド数（${slides.length}）と合いません`,
      );
    }
  } catch (error) {
    ctx.summary.warnings.push(`スライド画像を作れません: ${message(error)}`);
  }
}

/** 全シートを CSV にする。表示どおりの値（日付・通貨の書式、数式の計算結果）で、UTF-8 で書く（決定20） */
const CSV_FILTER =
  "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1";

async function processXlsx(ctx: Context, input: string): Promise<void> {
  const sheets = readSheetNames(await readFile(input));
  await libreoffice(ctx, input, ".xlsx", CSV_FILTER, "csv");
  const csvDir = join(ctx.tmp, "lo-csv");
  const dir = join(ctx.out, "sheets");
  await mkdir(dir, { recursive: true });
  // LibreOffice は全シートを書き出すとき「元の名前-シート名.csv」にする。シート名に使えない文字は置き換えられうるので、
  // 書き出されたファイルを一覧し、シート名と一致するものを探す
  const usedTargets = new Set<string>();
  const produced = new Map(
    (await readdir(csvDir))
      .filter((file) => file.startsWith("source-") && file.endsWith(".csv"))
      .map((file) => [file.slice("source-".length, -".csv".length), file]),
  );
  const moveCsv = async (file: string, target: string) => {
    const { rows, columns } = csvShape(
      await readFile(join(csvDir, file), "utf8"),
    );
    await move(join(csvDir, file), join(dir, target));
    return { rows, columns };
  };
  for (const sheet of sheets) {
    const file = produced.get(sheet.name);
    if (file === undefined) {
      ctx.summary.warnings.push(
        `シート「${sheet.name}」の CSV がありません（グラフだけのシートなど）`,
      );
      continue;
    }
    produced.delete(sheet.name);
    const target = uniqueName(usedTargets, `${safeName(sheet.name)}.csv`);
    const { rows, columns } = await moveCsv(file, target);
    ctx.summary.outputs.push(
      `${ctx.rel}/sheets/${target}: シート「${sheet.name}」${sheet.hidden ? "（非表示）" : ""} ${rows} 行 × ${columns} 列`,
    );
  }
  // どのシートとも名前が合わない CSV も捨てずに渡す
  for (const [name, file] of produced) {
    const target = uniqueName(usedTargets, `${safeName(name)}.csv`);
    const { rows, columns } = await moveCsv(file, target);
    ctx.summary.outputs.push(
      `${ctx.rel}/sheets/${target}: シート名を特定できない CSV ${rows} 行 × ${columns} 列`,
    );
  }
}

/** ImageMagick が読んでよい形式。拡張子から決める（中身から決めさせない） */
const IMAGE_CODERS: Record<string, string> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
};

/** ImageMagick の資源の上限。巨大な画像でワーカーのメモリを使い切らないようにする */
const IMAGEMAGICK_LIMITS = [
  "-limit",
  "memory",
  "1GiB",
  "-limit",
  "map",
  "2GiB",
  "-limit",
  "area",
  "512MP",
];

async function processImage(
  ctx: Context,
  input: string,
  ext: string,
): Promise<void> {
  // ImageMagick は形式をファイルの中身で判定し、拡張子と違う形式（SVG など）のデコーダーでも読んでしまう。
  // 信頼できない入力なので、決まった名前に置き、形式の接頭辞（jpeg: や png:）で読む形式を固定する
  let ref: string;
  if (ext === ".heic" || ext === ".heif") {
    // AL2023 の ImageMagick は HEIC の EXIF を読めないため、EXIF を残す JPEG に heif-convert で直してから扱う
    const converted = join(ctx.tmp, "converted.jpg");
    await ctx.run("heif-convert", ["-q", "95", input, converted]);
    ref = `jpeg:${converted}`;
  } else {
    const coder = IMAGE_CODERS[ext];
    if (!coder) throw new Error(`対応していない画像の形式です: ${ext}`);
    ref = `${coder}:${await stage(input, join(ctx.tmp, `source${ext}`))}`;
  }
  const outName = ext === ".jpg" || ext === ".jpeg" ? "image.jpg" : "image.png";
  await ctx.run("convert", [
    ...IMAGEMAGICK_LIMITS,
    `${ref}[0]`,
    "-auto-orient",
    "-resize",
    `${IMAGE_LONG_SIDE}x${IMAGE_LONG_SIDE}>`,
    join(ctx.out, outName),
  ]);
  ctx.summary.outputs.push(
    `${ctx.rel}/${outName}: 長辺 ${IMAGE_LONG_SIDE}px 以下に縮小した画像`,
  );
  // -ping は画像を読み込まずに大きさとメタデータだけを調べる
  const size = (
    await ctx.run("identify", ["-ping", "-format", "%wx%h", `${ref}[0]`])
  ).trim();
  const exif = formatExif(
    await ctx
      .run("identify", ["-ping", "-format", "%[EXIF:*]", `${ref}[0]`])
      .catch(() => ""),
  );
  await writeFile(
    join(ctx.out, "metadata.txt"),
    `元の大きさ: ${size}\n${exif ? `${exif}\n` : ""}`,
  );
  ctx.summary.outputs.push(
    `${ctx.rel}/metadata.txt: 元の大きさと撮影日時などのメタデータ`,
  );
}

async function processText(
  ctx: Context,
  input: string,
  name: string,
): Promise<void> {
  await copyFile(input, join(ctx.out, safeName(name)));
  ctx.summary.outputs.push(
    `${ctx.rel}/${safeName(name)}: 元のテキストそのまま`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processFile(
  run: RunCommand,
  input: string,
  name: string,
  /** extracted の下に作るフォルダ名（安全な名前で、ほかのファイルと重ならない） */
  rel: string,
  extractedDir: string,
  tmpRoot: string,
): Promise<FileSummary> {
  const detected = detectKind(name);
  const summary: FileSummary = {
    name,
    kind: detected?.kind ?? "unsupported",
    outputs: [],
    warnings: [],
  };
  if (!detected) {
    summary.error = "対応していない形式です";
    return summary;
  }
  const ctx: Context = {
    run,
    tmp: join(tmpRoot, rel),
    out: join(extractedDir, rel),
    rel,
    summary,
  };
  await mkdir(ctx.tmp, { recursive: true });
  await mkdir(ctx.out, { recursive: true });
  try {
    let source = input;
    if (detected.legacy) {
      // 旧形式は LibreOffice で新しい形式にしてから、同じ手順で読む
      source = await libreoffice(
        ctx,
        input,
        extname(name).toLowerCase(),
        detected.legacy,
        detected.legacy,
      );
      summary.warnings.push(
        `旧形式のため LibreOffice で ${detected.legacy} に変換して読みました`,
      );
    }
    switch (detected.kind) {
      case "docx":
        await processDocx(ctx, source);
        break;
      case "xlsx":
        await processXlsx(ctx, source);
        break;
      case "pptx":
        await processPptx(ctx, source);
        break;
      case "pdf":
        await processPdf(ctx, source);
        break;
      case "image":
        await processImage(ctx, source, extname(name).toLowerCase());
        break;
      case "text":
        await processText(ctx, source, name);
        break;
    }
  } catch (error) {
    summary.error = message(error);
  } finally {
    await rm(ctx.tmp, { recursive: true, force: true });
  }
  return summary;
}

/** 前処理の目次。エージェントは最初にこれを読む */
export function indexMarkdown(summaries: FileSummary[]): string {
  const sections = summaries.map((s) => {
    const lines = [
      `## ${s.name}（${s.kind === "unsupported" ? "未対応" : s.kind}）`,
      "",
    ];
    if (s.error) lines.push(`- 前処理に失敗しました: ${s.error}`);
    lines.push(...s.outputs.map((o) => `- ${o}`));
    lines.push(...s.warnings.map((w) => `- 注意: ${w}`));
    return lines.join("\n");
  });
  return `# 前処理の結果\n\nファイルは ${summaries.length} 件。パスはこのファイルのあるディレクトリからの相対パス。\n\n${sections.join("\n\n")}\n`;
}

export interface PreprocessOptions {
  run: RunCommand;
  inputDir: string;
  extractedDir: string;
  tmpDir: string;
  onProgress: (message: string) => void;
}

/** 入力ディレクトリのファイルを順に前処理し、目次を書く。1 件が失敗しても残りは続ける */
export async function preprocessAll(
  options: PreprocessOptions,
): Promise<FileSummary[]> {
  const names = (await readdir(options.inputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  await mkdir(options.extractedDir, { recursive: true });
  const summaries: FileSummary[] = [];
  const usedFolders = new Set<string>(["index.md"]);
  for (const [i, name] of names.entries()) {
    options.onProgress(`前処理 ${i + 1}/${names.length}件: ${name}`);
    const started = Date.now();
    const summary = await processFile(
      options.run,
      join(options.inputDir, name),
      name,
      uniqueName(usedFolders, safeName(name)),
      options.extractedDir,
      options.tmpDir,
    );
    summary.durationMs = Date.now() - started;
    summaries.push(summary);
  }
  await writeFile(
    join(options.extractedDir, "index.md"),
    indexMarkdown(summaries),
  );
  return summaries;
}
