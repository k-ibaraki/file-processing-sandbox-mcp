import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { extractDocx, extractPptx, readSheetNames } from "../src/ooxml";

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const P =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

function docx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return zip({
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}

const run = (text: string) =>
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("extractDocx", () => {
  test("段落を行として取り出す", () => {
    const text = extractDocx(
      docx(`<w:p>${run("見積")}${run("書")}</w:p><w:p>${run("二行目")}</w:p>`),
    );
    expect(text).toBe("見積書\n\n二行目\n");
  });

  test("見出しのスタイルは Markdown の見出しにする", () => {
    const styles = `<w:styles ${W}><w:style w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
    const text = extractDocx(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr>${run("概要")}</w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run("詳細")}</w:p>`,
        { "word/styles.xml": styles },
      ),
    );
    expect(text).toBe("# 概要\n\n## 詳細\n");
  });

  test("箇条書きの段落には印を付ける", () => {
    const text = extractDocx(
      docx(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr>${run("項目")}</w:p>`,
      ),
    );
    expect(text).toBe("  - 項目\n");
  });

  test("箇条書きのスタイル（スタイル側に番号付けがあるもの）の段落にも印を付ける", () => {
    const styles = `<w:styles ${W}><w:style w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
    const text = extractDocx(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${run("項目")}</w:p>`,
        {
          "word/styles.xml": styles,
        },
      ),
    );
    expect(text).toBe("- 項目\n");
  });

  test("表は Markdown の表にし、セル内の | と改行を崩さない", () => {
    const cell = (t: string) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;
    const text = extractDocx(
      docx(
        `<w:tbl><w:tr>${cell("品名")}${cell("金額")}</w:tr><w:tr>${cell("a|b")}<w:tc><w:p>${run("1")}</w:p><w:p>${run("2")}</w:p></w:tc></w:tr></w:tbl>`,
      ),
    );
    expect(text).toBe("| 品名 | 金額 |\n| --- | --- |\n| a\\|b | 1<br>2 |\n");
  });

  test("変更履歴は挿入と削除を区別して残す", () => {
    const text = extractDocx(
      docx(
        `<w:p>${run("金額は")}<w:del w:id="1" w:author="佐藤"><w:r><w:delText>100</w:delText></w:r></w:del><w:ins w:id="2" w:author="佐藤">${run("120")}</w:ins>${run("万円")}</w:p>`,
      ),
    );
    expect(text).toBe("金額は[削除（佐藤）: 100][挿入（佐藤）: 120]万円\n");
  });

  test("コメントは本文の位置に印を付け、末尾に内容を並べる", () => {
    const comments = `<w:comments ${W}><w:comment w:id="0" w:author="田中" w:date="2026-01-02T03:04:05Z"><w:p>${run("要確認")}</w:p></w:comment></w:comments>`;
    const text = extractDocx(
      docx(
        `<w:p>${run("納期")}<w:r><w:commentReference w:id="0"/></w:r></w:p>`,
        { "word/comments.xml": comments },
      ),
    );
    expect(text).toBe(
      "納期[コメント0]\n\n## コメント\n\n- [コメント0]（田中、2026-01-02T03:04:05Z）: 要確認\n",
    );
  });

  test("代替表示（mc:Fallback）の重複は読まない", () => {
    const text = extractDocx(
      docx(
        `<w:p><mc:AlternateContent xmlns:mc="m"><mc:Choice>${run("枠内")}</mc:Choice><mc:Fallback>${run("枠内")}</mc:Fallback></mc:AlternateContent></w:p>`,
      ),
    );
    expect(text).toBe("枠内\n");
  });

  test("タブと改行を保つ", () => {
    const text = extractDocx(
      docx(
        `<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>`,
      ),
    );
    expect(text).toBe("A\tB\nC\n");
  });

  test("展開すると大きすぎる部品は、展開する前に拒否する", () => {
    const data = docx(`<w:p>${run("x")}</w:p>`);
    // zip の中央ディレクトリにある「展開後のサイズ」を 512MB に書き換え、圧縮率の高い細工されたファイルを模す
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 4 <= data.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 512 * 1024 * 1024, true);
      }
    }
    expect(() => extractDocx(data)).toThrow("大きすぎます");
  });

  test("部品は 1 つずつなら上限以内でも、展開後の合計が大きすぎれば、展開する前に拒否する", () => {
    const data = docx(`<w:p>${run("x")}</w:p>`, {
      "word/styles.xml": "<w:styles/>",
      "word/comments.xml": "<w:comments/>",
    });
    // 3 つの部品の「展開後のサイズ」をそれぞれ 200MB に書き換える（1 つなら上限以内、合計は 600MB）
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 4 <= data.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 200 * 1024 * 1024, true);
      }
    }
    expect(() => extractDocx(data)).toThrow("合計");
  });

  test("本文が無いファイルは拒否する", () => {
    expect(() => extractDocx(zip({ "x.xml": "<x/>" }))).toThrow(
      "word/document.xml",
    );
  });
});

function pptx(
  slides: { xml: string; notes?: string; hidden?: boolean }[],
): Uint8Array {
  const files: Record<string, string> = {
    "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`)
      .reverse()
      .join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>${slides
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  };
  slides.forEach((slide, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] =
      `<p:sld ${P}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${slide.xml}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] =
        `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${slide.notes}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>9</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  return zip(files);
}

const shape = (...paragraphs: string[]) =>
  `<p:sp><p:txBody>${paragraphs
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;

describe("extractPptx", () => {
  test("スライドを表示順に並べ、テキストとノートを取り出す", () => {
    const slides = extractPptx(
      pptx([
        { xml: shape("表紙", "副題"), notes: "挨拶する" },
        { xml: shape("二枚目") },
      ]),
    );
    // presentation.xml の並び（ここでは逆順）が表示順
    expect(slides).toEqual([
      { number: 1, hidden: false, text: "二枚目", notes: "" },
      { number: 2, hidden: false, text: "表紙\n副題", notes: "挨拶する" },
    ]);
  });

  test("非表示のスライドも番号を飛ばさずに残す", () => {
    const slides = extractPptx(pptx([{ xml: shape("隠し"), hidden: true }]));
    expect(slides[0]?.hidden).toBe(true);
  });

  test("スライド上の表は Markdown の表にする", () => {
    const cell = (t: string) =>
      `<a:tc><a:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody></a:tc>`;
    const slides = extractPptx(
      pptx([
        {
          xml: `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>${cell("項目")}${cell("値")}</a:tr><a:tr>${cell("売上")}${cell("10")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        },
      ]),
    );
    expect(slides[0]?.text).toBe("| 項目 | 値 |\n| --- | --- |\n| 売上 | 10 |");
  });

  test("表の前後は空行で区切り、Markdown の表として読めるようにする", () => {
    const cell = `<a:tc><a:txBody><a:p><a:r><a:t>値</a:t></a:r></a:p></a:txBody></a:tc>`;
    const slides = extractPptx(
      pptx([
        {
          xml: `${shape("題")}<p:graphicFrame><a:tbl><a:tr>${cell}</a:tr></a:tbl></p:graphicFrame>${shape("後")}`,
        },
      ]),
    );
    expect(slides[0]?.text).toBe("題\n\n| 値 |\n| --- |\n\n後");
  });
});

describe("readSheetNames", () => {
  test("ブックのシートを並び順に、非表示かどうかとともに返す", () => {
    const book = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="売上" sheetId="1"/><sheet name="作業用" sheetId="2" state="hidden"/></sheets></workbook>`,
    });
    expect(readSheetNames(book)).toEqual([
      { name: "売上", hidden: false },
      { name: "作業用", hidden: true },
    ]);
  });
});
