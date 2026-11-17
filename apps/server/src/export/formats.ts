import { type Artifact, artifactTable, exportArtifact } from "@open-meetings/core";
import { zip } from "./zip";

export type ExportedFile = { filename: string; mime: string; body: string | Buffer };

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const slug = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "artifact";

type Run = { text: string; bold?: boolean };

/** Splits `**bold**` and turns `[text](url)` into "text (url)". */
function inline(text: string): Run[] {
  const plain = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/`([^`]+)`/g, "$1");
  const runs: Run[] = [];
  const parts = plain.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**"))
      runs.push({ text: part.slice(2, -2), bold: true });
    else runs.push({ text: part.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2") });
  }
  return runs;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet" | "number" | "paragraph"; text: string };

/** The Markdown the agent writes: headings, lists and paragraphs. Tables come out as text. */
function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^(-{3,}|\*{3,})$/.test(trimmed)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (heading?.[1] && heading[2] !== undefined)
      out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
    else if (bullet?.[1] !== undefined) out.push({ kind: "bullet", text: bullet[1] });
    else if (numbered?.[1] !== undefined) out.push({ kind: "number", text: numbered[1] });
    else out.push({ kind: "paragraph", text: trimmed });
  }
  return out;
}

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = (
  target: string,
  type: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${type}" Target="${target}"/>
</Relationships>`;

const OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

/** A Word document from Markdown. Headings and bold come through; styling is Word's default. */
export function markdownToDocx(markdown: string): Buffer {
  const sizes = [0, 36, 30, 26, 24, 22, 22];
  let number = 0;
  const paragraphs = blocks(markdown).map((block) => {
    if (block.kind !== "number") number = 0;
    const prefix = block.kind === "bullet" ? "• " : block.kind === "number" ? `${++number}. ` : "";
    const runs = inline(block.text);
    const heading = block.kind === "heading";
    const body = [{ text: prefix }, ...runs]
      .filter((run) => run.text)
      .map((run) => {
        const props = [
          heading || (run as Run).bold ? "<w:b/>" : "",
          heading ? `<w:sz w:val="${sizes[block.kind === "heading" ? block.level : 0]}"/>` : "",
        ].join("");
        return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
      })
      .join("");
    const spacing = heading ? '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>' : "";
    const indent =
      block.kind === "bullet" || block.kind === "number"
        ? '<w:pPr><w:ind w:left="360"/></w:pPr>'
        : "";
    return `<w:p>${spacing || indent}${body}</w:p>`;
  });
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr/></w:body></w:document>`;
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES_DOCX },
    { name: "_rels/.rels", data: ROOT_RELS("word/document.xml", OFFICE_DOCUMENT) },
    { name: "word/document.xml", data: document },
  ]);
}

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** An Excel workbook with one sheet. Numbers stay numbers; everything else is text. */
export function tableToXlsx(rows: unknown[][], sheetName = "Sheet1"): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === null || value === undefined || value === "") return "";
          if (typeof value === "number" && Number.isFinite(value))
            return `<c r="${ref}"><v>${value}</v></c>`;
          if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  return zip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    { name: "_rels/.rels", data: ROOT_RELS("xl/workbook.xml", OFFICE_DOCUMENT) },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: ROOT_RELS(
        "worksheets/sheet1.xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

/** A board as an Excalidraw scene (one column of cards per board column), for excalidraw.com. */
export function boardToExcalidraw(columns: { title: string; cards: string[] }[]): string {
  let seed = 1;
  const base = (type: string, x: number, y: number, width: number, height: number) => ({
    id: `om-${seed}`,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: seed++,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  });
  const text = (value: string, x: number, y: number, size: number) => ({
    ...base("text", x, y, 220, size * 1.25 * Math.max(1, Math.ceil(value.length / 28))),
    text: value,
    originalText: value,
    fontSize: size,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  });
  const elements: unknown[] = [];
  columns.forEach((column, i) => {
    const x = i * 280;
    elements.push(text(column.title, x, 0, 24));
    column.cards.forEach((card, j) => {
      const y = 50 + j * 110;
      elements.push({ ...base("rectangle", x, y, 250, 90), backgroundColor: "#fff3bf" });
      elements.push(text(card, x + 12, y + 12, 16));
    });
  });
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "open-meetings",
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    },
    null,
    2,
  );
}

/** A printable HTML page: the panel opens it and the browser saves it as PDF. */
export function markdownToHtml(title: string, markdown: string): string {
  let list: "ul" | "ol" | undefined;
  const html: string[] = [];
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = undefined;
  };
  const runs = (text: string) =>
    inline(text)
      .map((run) => (run.bold ? `<strong>${xml(run.text)}</strong>` : xml(run.text)))
      .join("");
  for (const block of blocks(markdown)) {
    const wanted = block.kind === "bullet" ? "ul" : block.kind === "number" ? "ol" : undefined;
    if (wanted !== list) closeList();
    if (wanted && !list) {
      html.push(`<${wanted}>`);
      list = wanted;
    }
    if (block.kind === "heading")
      html.push(`<h${block.level}>${runs(block.text)}</h${block.level}>`);
    else if (wanted) html.push(`<li>${runs(block.text)}</li>`);
    else html.push(`<p>${runs(block.text)}</p>`);
  }
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${xml(title)}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1rem;color:#111}h1{font-size:1.7rem}h2{font-size:1.25rem;margin-top:1.8rem}@media print{body{margin:0}}</style>
</head><body>${html.join("\n")}<script>window.addEventListener("load",()=>{if(location.hash==="#print")window.print()})</script></body></html>`;
}

/** Every export the panel offers, by artifact type and format. */
export function exportAs(artifact: Artifact, format?: string): ExportedFile {
  const name = slug(artifact.title);
  const { content } = artifact;
  if (content.type === "doc") {
    if (format === "docx") {
      return {
        filename: `${name}.docx`,
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        body: markdownToDocx(content.markdown),
      };
    }
    if (format === "html" || format === "pdf") {
      return {
        filename: `${name}.html`,
        mime: "text/html; charset=utf-8",
        body: markdownToHtml(artifact.title, content.markdown),
      };
    }
  }
  if (format === "xlsx" && content.type !== "doc") {
    const table = artifactTable(content);
    return {
      filename: `${name}.xlsx`,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: tableToXlsx(table, artifact.title),
    };
  }
  if (format === "excalidraw" && content.type === "board") {
    return {
      filename: `${name}.excalidraw`,
      mime: "application/json",
      body: boardToExcalidraw(content.columns),
    };
  }
  const plain = exportArtifact(artifact);
  return {
    filename: `${name}.${plain.filename.split(".").pop()}`,
    mime: `${plain.mime}; charset=utf-8`,
    body: plain.body,
  };
}
