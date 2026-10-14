import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  csvShape,
  detectKind,
  formatExif,
  indexMarkdown,
  pageName,
  preprocessAll,
  type RunCommand,
  safeName,
  splitPages,
  uniqueName,
} from "../src/preprocess";

describe("detectKind", () => {
  test("拡張子の大文字小文字を問わず形式を見分け、旧形式には変換先を付ける", () => {
    expect(detectKind("見積.XLSX")).toEqual({ kind: "xlsx" });
    expect(detectKind("古い.doc")).toEqual({ kind: "docx", legacy: "docx" });
    expect(detectKind("写真.HEIC")).toEqual({ kind: "image" });
    expect(detectKind("図面.dwg")).toBeUndefined();
  });
});

describe("safeName", () => {
  test("パスの区切りや制御文字を置き換え、. や .. だけの名前にしない", () => {
    expect(safeName("a/b\\c:d.csv")).toBe("a_b_c_d.csv");
    expect(safeName("..")).toBe("_..");
    expect(safeName("売上")).toBe("売上");
  });
});

describe("uniqueName", () => {
  test("使った名前と重なるときは、拡張子の前に連番を付ける", () => {
    const used = new Set<string>();
    expect(uniqueName(used, "A_B.csv")).toBe("A_B.csv");
    expect(uniqueName(used, "A_B.csv")).toBe("A_B-2.csv");
    expect(uniqueName(used, "A_B.csv")).toBe("A_B-3.csv");
    expect(uniqueName(used, "a_b")).toBe("a_b");
    expect(uniqueName(used, "a_b")).toBe("a_b-2");
  });
});

describe("pageName", () => {
  test("最低 3 桁、総数が多ければその桁に揃える", () => {
    expect(pageName(7, 30, "png")).toBe("007.png");
    expect(pageName(7, 1200, "txt")).toBe("0007.txt");
  });
});

describe("splitPages", () => {
  test("改ページで分け、末尾の空の要素は除く", () => {
    expect(splitPages("一\f二\f")).toEqual(["一", "二"]);
    expect(splitPages("\f")).toEqual([""]);
  });
});

describe("csvShape", () => {
  test("引用符の中の改行とカンマは区切りにしない", () => {
    expect(csvShape('a,b,c\n"x\ny","1,2",3\n')).toEqual({
      rows: 2,
      columns: 3,
    });
  });

  test("最後に改行が無くても数え、空なら 0 行", () => {
    expect(csvShape("a,b\n1,2")).toEqual({ rows: 2, columns: 2 });
    expect(csvShape("")).toEqual({ rows: 0, columns: 0 });
  });
});

describe("formatExif", () => {
  test("exif:名前=値 の行を「名前: 値」にする", () => {
    expect(
      formatExif("exif:DateTime=2026:10:01 15:30:00\nexif:Make=Cam\n"),
    ).toBe("DateTime: 2026:10:01 15:30:00\nMake: Cam");
  });
});

/** 外部コマンドの代わりに、出力ファイルだけを作る偽物。呼ばれたコマンドを記録する */
function fakeRun(
  calls: string[][],
  csvNames: string[],
  /** 失敗させるコマンド（タイムアウトなどを模す） */
  failing: string[] = [],
): RunCommand {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (failing.includes(command)) throw new Error(`${command} が失敗しました`);
    const last = args.at(-1) ?? "";
    switch (command) {
      case "soffice": {
        const outDir = args[args.indexOf("--outdir") + 1] ?? "";
        const filter = args[args.indexOf("--convert-to") + 1] ?? "";
        await mkdir(outDir, { recursive: true });
        if (filter.startsWith("csv")) {
          for (const name of csvNames) {
            await writeFile(
              join(outDir, `source-${name}.csv`),
              "日付,金額\n2026/04/01,1000\n",
            );
          }
        } else {
          const ext = filter.split(":")[0] ?? "";
          await writeFile(join(outDir, `source.${ext}`), "converted");
        }
        return "";
      }
      case "pdftotext":
        await writeFile(last, "一ページ目\f\f三ページ目\f");
        return "";
      case "pdftoppm":
        for (const n of [1, 2, 3]) await writeFile(`${last}-${n}.png`, "png");
        return "";
      case "convert":
      case "heif-convert":
        await writeFile(last, "image");
        return "";
      case "identify":
        return args.includes("%wx%h")
          ? "4000x3000"
          : "exif:DateTime=2026:10:01 15:30:00";
      default:
        throw new Error(`想定外のコマンド: ${command}`);
    }
  };
}

async function setup(
  files: Record<string, Uint8Array | string>,
  /** LibreOffice が書き出す CSV のシート名部分 */
  csvNames: string[] = ["売上"],
  failing: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "preprocess-"));
  const inputDir = join(root, "input");
  await mkdir(inputDir);
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(inputDir, name), data);
  }
  const calls: string[][] = [];
  const progress: string[] = [];
  const extractedDir = join(root, "extracted");
  const summaries = await preprocessAll({
    run: fakeRun(calls, csvNames, failing),
    inputDir,
    extractedDir,
    tmpDir: join(root, "tmp"),
    onProgress: (m) => progress.push(m),
  });
  const index = await readFile(join(extractedDir, "index.md"), "utf8");
  return { root, extractedDir, summaries, calls, progress, index };
}

const xlsx = zipSync({
  "xl/workbook.xml": strToU8(
    '<workbook><sheets><sheet name="売上"/><sheet name="グラフ"/></sheets></workbook>',
  ),
});

describe("preprocessAll", () => {
  test("PDF はページごとのテキスト（空のページは除く）と画像にする", async () => {
    const { extractedDir, summaries } = await setup({ "報告.pdf": "%PDF" });
    expect(
      (await readdir(join(extractedDir, "報告.pdf/pages"))).sort(),
    ).toEqual(["001.png", "001.txt", "002.png", "003.png", "003.txt"]);
    expect(summaries[0]?.outputs[0]).toContain("3 ページ中 2 ページ");
  });

  test("xlsx はシートごとの CSV にし、行数と列数を目次に書く。CSV が無いシートは注意に残す", async () => {
    const { extractedDir, index } = await setup({ "見積.xlsx": xlsx });
    expect(
      await readFile(join(extractedDir, "見積.xlsx/sheets/売上.csv"), "utf8"),
    ).toContain("2026/04/01");
    expect(index).toContain(
      "見積.xlsx/sheets/売上.csv: シート「売上」 2 行 × 2 列",
    );
    expect(index).toContain("注意: シート「グラフ」の CSV がありません");
  });

  test("安全な名前にすると同じになるファイル名やシート名でも、結果を上書きせず別々に残す", async () => {
    const files = await setup({ "a:b.txt": "一つ目", "a_b.txt": "二つ目" });
    expect(
      (await readdir(files.extractedDir))
        .filter((n) => n !== "index.md")
        .sort(),
    ).toEqual(["a_b-2.txt", "a_b.txt"]);
    expect(
      await readFile(join(files.extractedDir, "a_b.txt/a_b.txt"), "utf8"),
    ).toBe("一つ目");

    const book = zipSync({
      "xl/workbook.xml": strToU8(
        '<workbook><sheets><sheet name="A:B"/><sheet name="A?B"/></sheets></workbook>',
      ),
    });
    const { extractedDir } = await setup({ "見積.xlsx": book }, ["A:B", "A?B"]);
    expect(
      (await readdir(join(extractedDir, "見積.xlsx/sheets"))).sort(),
    ).toEqual(["A_B-2.csv", "A_B.csv"]);
  });

  test("index.md という名前の入力があっても、目次のファイルを上書きしない", async () => {
    const { extractedDir, index } = await setup({ "index.md": "入力のメモ" });
    expect(index).toContain("# 前処理の結果");
    expect(
      await readFile(join(extractedDir, "index-2.md/index.md"), "utf8"),
    ).toBe("入力のメモ");
  });

  test("旧形式は LibreOffice で新しい形式にしてから読む", async () => {
    const { calls, summaries } = await setup({ "古い.xls": "binary" });
    const first = calls[0] ?? [];
    expect(first[0]).toBe("soffice");
    expect(first).toContain("xlsx");
    // 偽物の変換結果は xlsx ではないので、その後の読み取りで失敗として記録される
    expect(summaries[0]?.error).toBeDefined();
    expect(summaries[0]?.warnings[0]).toContain("xlsx に変換");
  });

  test("xlsx のシート名と LibreOffice が付けた CSV の名前が合わなくても、CSV を捨てずに渡す", async () => {
    // シート名に使えない文字を LibreOffice が置き換えた場合など
    const book = zipSync({
      "xl/workbook.xml": strToU8(
        '<workbook><sheets><sheet name="a/b"/></sheets></workbook>',
      ),
    });
    const { extractedDir, index } = await setup({ "見積.xlsx": book }, ["a_b"]);
    expect(
      await readFile(join(extractedDir, "見積.xlsx/sheets/a_b.csv"), "utf8"),
    ).toContain("2026/04/01");
    expect(index).toContain("注意: シート「a/b」の CSV がありません");
    expect(index).toContain(
      "見積.xlsx/sheets/a_b.csv: シート名を特定できない CSV",
    );
  });

  test("HEIC は EXIF を残すため JPEG にしてから縮小し、メタデータを書く", async () => {
    const { calls, extractedDir } = await setup({ "写真.heic": "heic" });
    expect(calls.map((c) => c[0])).toEqual([
      "heif-convert",
      "convert",
      "identify",
      "identify",
    ]);
    expect(calls[1]).toContain("1500x1500>");
    expect(await readdir(join(extractedDir, "写真.heic"))).toEqual(
      expect.arrayContaining(["image.png", "metadata.txt"]),
    );
    expect(
      await readFile(join(extractedDir, "写真.heic/metadata.txt"), "utf8"),
    ).toBe("元の大きさ: 4000x3000\nDateTime: 2026:10:01 15:30:00\n");
  });

  test("画像は拡張子で形式を固定し、元のファイル名ではなく決まった名前で ImageMagick に渡す", async () => {
    // 中身が SVG などの偽装ファイルを、ImageMagick が中身で判定して別のデコーダーで読まないようにする
    const jobs = [
      ["偽装.PNG", "png:"],
      ["写真.jpeg", "jpeg:"],
      ["写真.heic", "jpeg:"],
    ] as const;
    for (const [name, coder] of jobs) {
      const { calls } = await setup({ [name]: "x" });
      const magick = calls.filter(
        (c) => c[0] === "convert" || c[0] === "identify",
      );
      expect(magick).toHaveLength(3);
      for (const call of magick) {
        const input = call.find((a) => a.startsWith(coder));
        expect(input, `${name}: ${call.join(" ")}`).toBeDefined();
        expect(call.join(" ")).not.toContain("/input/");
      }
    }
  });

  test("ImageMagick には資源の上限を付け、identify は画像を読み込まずに調べる", async () => {
    const { calls } = await setup({ "写真.jpg": "x" });
    const convert = calls.find((c) => c[0] === "convert") ?? [];
    expect(convert).toEqual(
      expect.arrayContaining(["-limit", "memory", "area"]),
    );
    for (const identify of calls.filter((c) => c[0] === "identify")) {
      expect(identify).toContain("-ping");
    }
  });

  test("未対応の形式と失敗したファイルは目次に理由を残し、ほかのファイルは続ける", async () => {
    const { summaries, index, progress } = await setup({
      "a.dwg": "x",
      "b.docx": "zip ではない",
      "c.txt": "メモ",
    });
    expect(summaries.map((s) => [s.name, s.error === undefined])).toEqual([
      ["a.dwg", false],
      ["b.docx", false],
      ["c.txt", true],
    ]);
    expect(index).toContain("## a.dwg（未対応）");
    expect(index).toContain("前処理に失敗しました");
    expect(progress).toEqual([
      "前処理 1/3件: a.dwg",
      "前処理 2/3件: b.docx",
      "前処理 3/3件: c.txt",
    ]);
  });

  test("docx・pptx の画像を作れなかったときは、ファイルは失敗にせず、一部を作れなかった印を付ける", async () => {
    // 印があれば結果を保存せず、再実行で作り直す（決定28）。LibreOffice のタイムアウトのような一時的な失敗を使い回さないため
    const docx = zipSync({
      "word/document.xml": strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>本文</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      ),
    });
    const { summaries } = await setup(
      { "a.docx": docx, "b.pptx": pptx, "c.txt": "メモ" },
      [],
      ["soffice"],
    );
    expect(
      summaries.map((s) => [s.name, s.error, s.incomplete ?? false]),
    ).toEqual([
      ["a.docx", undefined, true],
      ["b.pptx", undefined, true],
      ["c.txt", undefined, false],
    ]);
  });

  test("ファイルごとにかかった時間を記録する（目次には書かない）", async () => {
    const { summaries, index } = await setup({
      "報告.pdf": "%PDF",
      "a.dwg": "x",
    });
    for (const summary of summaries) {
      expect(summary.durationMs).toEqual(expect.any(Number));
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    }
    // 時間を除いた要約から作った目次と同じになる（目次に時間が混ざらない）
    expect(index).toBe(
      indexMarkdown(summaries.map(({ durationMs: _, ...rest }) => rest)),
    );
  });

  test("一時ディレクトリは処理の後に消す", async () => {
    const { root } = await setup({ "報告.pdf": "%PDF" });
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });
});
