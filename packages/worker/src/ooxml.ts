// Office Open XML（docx・pptx・xlsx）を zip と XML のまま読み、テキストを取り出す。
// LibreOffice で PDF にしてから取り出すと、コメント・変更履歴（挿入と削除の区別）・スライドのノートが失われる。
// それらを残すために、PDF を経由せず直接読む（決定19）。

import { XMLParser } from "fast-xml-parser";
import { type UnzipOptions, type Unzipped, unzipSync } from "fflate";

/** 1 つの部品を展開するときの上限。圧縮率の高い細工されたファイルでメモリを使い切らないようにする */
const MAX_PART_BYTES = 256 * 1024 * 1024;
/** 読む部品を展開した合計の上限。部品ごとの上限を満たす部品を大量に並べたファイルで、メモリを使い切らないようにする */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** name が "#text" のときの本文 */
  text: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

type RawNode = Record<string, unknown>;

function toNodes(raw: RawNode[]): XmlNode[] {
  return raw.map((item) => {
    const attrs = (item[":@"] ?? {}) as Record<string, string>;
    const name = Object.keys(item).find((key) => key !== ":@") ?? "";
    const value = item[name];
    if (name === "#text") {
      return { name, attrs, children: [], text: String(value) };
    }
    return {
      name,
      attrs,
      children: toNodes((value ?? []) as RawNode[]),
      text: "",
    };
  });
}

function parseXml(xml: string): XmlNode[] {
  return toNodes(parser.parse(xml) as RawNode[]);
}

/** 子孫から名前の合うものを文書の順に集める。見つけたものの中までは探さない */
function findAll(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes) {
    if (node.name === name) found.push(node);
    else found.push(...findAll(node.children, name));
  }
  return found;
}

function first(nodes: XmlNode[], name: string): XmlNode | undefined {
  return findAll(nodes, name)[0];
}

type Parts = Record<string, string>;

/** fflate の英語のエラー（invalid zip data など）を、利用者に伝わる理由にする。上限を越えたときの自前のエラーはそのまま投げる */
function unzip(data: Uint8Array, opts: UnzipOptions): Unzipped {
  try {
    return unzipSync(data, opts);
  } catch (error) {
    if (
      error instanceof Error &&
      typeof (error as { code?: unknown }).code === "number"
    ) {
      throw new Error(
        `zip として読めません。ファイルが壊れているか、拡張子と中身の形式が違う可能性があります（${error.message}）`,
      );
    }
    throw error;
  }
}

function readParts(data: Uint8Array, wanted: (name: string) => boolean): Parts {
  let total = 0;
  const files = unzip(data, {
    filter: (file) => {
      if (!wanted(file.name)) return false;
      // 展開するときに確保しうる大きさの上限。fflate は無圧縮の部品を、展開後のサイズの申告を見ずに、申告された圧縮後のサイズの分
      // （入力の末尾までに切り詰める）だけ取り出す
      const bytes = file.compression === 0 ? file.size : file.originalSize;
      if (bytes > MAX_PART_BYTES) {
        throw new Error(`${file.name} が大きすぎます（${bytes} バイト）`);
      }
      total += bytes;
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`展開後の合計が大きすぎます（${total} バイト以上）`);
      }
      return true;
    },
  });
  const decoder = new TextDecoder();
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, decoder.decode(bytes)]),
  );
}

function requirePart(parts: Parts, name: string): string {
  const part = parts[name];
  if (part === undefined) throw new Error(`${name} がありません`);
  return part;
}

/** Markdown の表のセルに入れられる形にする */
function cellText(lines: string[]): string {
  return lines
    .map((line) => line.replaceAll("|", "\\|").replaceAll("\n", "<br>"))
    .join("<br>");
}

function markdownTable(rows: string[][]): string {
  const lines = rows.map((cells) => `| ${cells.join(" | ")} |`);
  const width = rows[0]?.length ?? 0;
  if (width > 0)
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
  return lines.join("\n");
}

// ---- docx ----

interface DocxContext {
  /** スタイル ID から見出しの段（1〜9） */
  headingLevels: Map<string, number>;
  /** 番号付け（箇条書き）を持つスタイルの ID */
  listStyles: Set<string>;
}

function docxContext(stylesXml: string | undefined): DocxContext {
  const context: DocxContext = {
    headingLevels: new Map(),
    listStyles: new Set(),
  };
  if (!stylesXml) return context;
  for (const style of findAll(parseXml(stylesXml), "w:style")) {
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    const name = first(style.children, "w:name")?.attrs["w:val"] ?? "";
    const match = /^heading (\d)$/i.exec(name);
    if (match?.[1]) context.headingLevels.set(id, Number(match[1]));
    const properties = first(style.children, "w:pPr")?.children ?? [];
    if (first(properties, "w:numPr")) context.listStyles.add(id);
  }
  return context;
}

/** 段落の中身（ラン・変更履歴・コメントの印）を順にテキストにする */
function inlineText(nodes: XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.name) {
      case "#text":
        break;
      case "w:t":
      case "w:delText":
        text += node.children.map((child) => child.text).join("");
        break;
      case "w:tab":
        text += "\t";
        break;
      case "w:br":
      case "w:cr":
        text += "\n";
        break;
      case "w:ins":
      case "w:del":
      case "w:moveFrom":
      case "w:moveTo": {
        const label = {
          "w:ins": "挿入",
          "w:del": "削除",
          "w:moveFrom": "移動元",
          "w:moveTo": "移動先",
        }[node.name];
        const author = node.attrs["w:author"];
        const inner = inlineText(node.children);
        if (inner)
          text += `[${label}${author ? `（${author}）` : ""}: ${inner}]`;
        break;
      }
      case "w:commentReference":
        text += `[コメント${node.attrs["w:id"]}]`;
        break;
      // 段落の書式、フィールドの命令、代替表示の重複は読まない
      case "w:pPr":
      case "w:rPr":
      case "w:instrText":
      case "w:delInstrText":
      case "mc:Fallback":
        break;
      default:
        text += inlineText(node.children);
    }
  }
  return text;
}

function paragraphText(paragraph: XmlNode, context: DocxContext): string {
  const text = inlineText(paragraph.children);
  const properties = first(paragraph.children, "w:pPr")?.children ?? [];
  const styleId = first(properties, "w:pStyle")?.attrs["w:val"];
  const level = styleId ? context.headingLevels.get(styleId) : undefined;
  if (level && text) return `${"#".repeat(level)} ${text}`;
  const numbering = first(properties, "w:numPr");
  if ((numbering || (styleId && context.listStyles.has(styleId))) && text) {
    const depth = Number(
      first(numbering?.children ?? [], "w:ilvl")?.attrs["w:val"] ?? 0,
    );
    return `${"  ".repeat(depth)}- ${text}`;
  }
  return text;
}

function tableText(table: XmlNode, context: DocxContext): string {
  const rows = table.children
    .filter((row) => row.name === "w:tr")
    .map((row) =>
      row.children
        .filter((cell) => cell.name === "w:tc")
        .map((cell) =>
          cellText(
            blocks(cell.children, context).filter((block) => block !== ""),
          ),
        ),
    );
  return markdownTable(rows);
}

/** 本文の段落と表を順に並べる。内容制御（w:sdt）などの入れ物は中を読む */
function blocks(nodes: XmlNode[], context: DocxContext): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.name === "w:p") result.push(paragraphText(node, context));
    else if (node.name === "w:tbl") result.push(tableText(node, context));
    else if (node.name !== "w:sectPr" && node.name !== "#text") {
      result.push(...blocks(node.children, context));
    }
  }
  return result;
}

function commentsText(commentsXml: string | undefined): string {
  if (!commentsXml) return "";
  const items = findAll(parseXml(commentsXml), "w:comment").map((comment) => {
    const meta = [comment.attrs["w:author"], comment.attrs["w:date"]]
      .filter(Boolean)
      .join("、");
    const body = findAll(comment.children, "w:p")
      .map((p) => inlineText(p.children))
      .join(" ");
    return `- [コメント${comment.attrs["w:id"]}]${meta ? `（${meta}）` : ""}: ${body}`;
  });
  return items.length > 0 ? `## コメント\n\n${items.join("\n")}\n` : "";
}

/** docx の本文・表・変更履歴・コメントを Markdown のテキストにする */
export function extractDocx(data: Uint8Array): string {
  const parts = readParts(data, (name) =>
    ["word/document.xml", "word/styles.xml", "word/comments.xml"].includes(
      name,
    ),
  );
  const document = parseXml(requirePart(parts, "word/document.xml"));
  const body = first(document, "w:body")?.children ?? [];
  const context = docxContext(parts["word/styles.xml"]);
  const text = blocks(body, context)
    .filter((block) => block !== "")
    .join("\n\n");
  const comments = commentsText(parts["word/comments.xml"]);
  return [text ? `${text}\n` : "", comments].filter(Boolean).join("\n");
}

// ---- pptx ----

export interface SlideText {
  /** 表示順の番号（1 から） */
  number: number;
  hidden: boolean;
  text: string;
  notes: string;
}

/** a:p（段落）と a:tbl（表）を順にテキストにする */
function drawingBlocks(nodes: XmlNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.name === "a:p") {
      const line = inlineDrawingText(node.children);
      if (line) result.push(line);
    } else if (node.name === "a:tbl") {
      const rows = findAll(node.children, "a:tr").map((row) =>
        findAll(row.children, "a:tc").map((cell) =>
          cellText(drawingBlocks(cell.children)),
        ),
      );
      // 前後を空行で区切り、Markdown の表として読めるようにする
      result.push(`\n${markdownTable(rows)}\n`);
    } else {
      result.push(...drawingBlocks(node.children));
    }
  }
  return result;
}

function inlineDrawingText(nodes: XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.name === "a:t") text += node.children.map((c) => c.text).join("");
    else if (node.name === "a:br") text += "\n";
    else if (node.name !== "#text") text += inlineDrawingText(node.children);
  }
  return text;
}

/** 関係（rels）の ID から、部品のパス（zip 内）への対応 */
function relationships(relsXml: string | undefined, baseDir: string) {
  const map = new Map<string, { type: string; path: string }>();
  if (!relsXml) return map;
  for (const rel of findAll(parseXml(relsXml), "Relationship")) {
    const { Id, Type, Target } = rel.attrs;
    if (Id && Target) {
      map.set(Id, { type: Type ?? "", path: resolvePartPath(baseDir, Target) });
    }
  }
  return map;
}

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

function relsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
}

function dirOf(partPath: string): string {
  return partPath.slice(0, partPath.lastIndexOf("/"));
}

function notesText(notesXml: string | undefined): string {
  if (!notesXml) return "";
  // ノートの本文はプレースホルダー body の図形に入る。スライドの縮小図や番号は読まない
  return findAll(parseXml(notesXml), "p:sp")
    .filter((sp) => first(sp.children, "p:ph")?.attrs.type === "body")
    .flatMap((sp) => drawingBlocks(sp.children))
    .join("\n");
}

/** pptx のスライドを表示順に、テキストとノートを取り出す */
export function extractPptx(data: Uint8Array): SlideText[] {
  const parts = readParts(
    data,
    (name) =>
      name === "ppt/presentation.xml" ||
      name === "ppt/_rels/presentation.xml.rels" ||
      /^ppt\/(slides|notesSlides)\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(name),
  );
  const presentation = parseXml(requirePart(parts, "ppt/presentation.xml"));
  const rels = relationships(parts["ppt/_rels/presentation.xml.rels"], "ppt");
  const slideIds = findAll(presentation, "p:sldId");

  return slideIds.map((slideId, index) => {
    const slidePath = rels.get(slideId.attrs["r:id"] ?? "")?.path ?? "";
    const slide = parseXml(requirePart(parts, slidePath));
    const root = first(slide, "p:sld");
    const slideRels = relationships(
      parts[relsPathOf(slidePath)],
      dirOf(slidePath),
    );
    const notesPath = [...slideRels.values()].find((rel) =>
      rel.type.endsWith("/notesSlide"),
    )?.path;
    return {
      number: index + 1,
      hidden: root?.attrs.show === "0",
      text: drawingBlocks(first(slide, "p:cSld")?.children ?? [])
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      notes: notesText(notesPath ? parts[notesPath] : undefined),
    };
  });
}

// ---- xlsx ----

export interface SheetName {
  name: string;
  hidden: boolean;
}

/** xlsx のシートを並び順に返す。中身の CSV は LibreOffice で作る（決定20） */
export function readSheetNames(data: Uint8Array): SheetName[] {
  const parts = readParts(data, (name) => name === "xl/workbook.xml");
  return findAll(parseXml(requirePart(parts, "xl/workbook.xml")), "sheet").map(
    (sheet) => ({
      name: sheet.attrs.name ?? "",
      hidden:
        sheet.attrs.state === "hidden" || sheet.attrs.state === "veryHidden",
    }),
  );
}
