// Request bodies for POST /<PHONE_NUMBER_ID>/messages, built from the field names in Meta's docs (docs/SOURCES.md).

import type { Bilingual } from "./phone.ts";

export type MediaRef = { id: string } | { link: string };

export interface DocumentMedia {
  media: MediaRef;
  /** "with extension"; the WhatsApp client picks the icon from it */
  filename: string;
}

/** Recipient: a phone number ("to") or, for a user who hides their number, a business-scoped user id ("recipient"). */
export type Recipient = { to: string } | { recipient: string };

function recipientFields(r: Recipient): Record<string, string> {
  return "to" in r ? { to: r.to } : { recipient: r.recipient };
}

export function buildDocumentMessage(p: Recipient & DocumentMedia & { caption?: string | undefined; ref?: string | undefined }): Record<string, unknown> {
  const document: Record<string, unknown> = { ...p.media, filename: p.filename };
  if (p.caption !== undefined && p.caption !== "") document["caption"] = p.caption;
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientFields(p),
    type: "document",
    document,
  };
  if (p.ref) body["biz_opaque_callback_data"] = p.ref;
  return body;
}

export function buildTextMessage(p: Recipient & { body: string; ref?: string | undefined }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientFields(p),
    type: "text",
    text: { preview_url: false, body: p.body },
  };
  if (p.ref) body["biz_opaque_callback_data"] = p.ref;
  return body;
}

export interface TemplateMessageInput {
  to: string;
  name: string;
  /** e.g. "es", "es_AR", "es_MX" */
  languageCode: string;
  /** positional body variables, in order */
  bodyParams?: string[] | undefined;
  /** named body variables (template created with parameter_format "named") */
  namedBodyParams?: Array<{ name: string; value: string }> | undefined;
  headerDocument?: DocumentMedia | undefined;
  ref?: string | undefined;
}

export function buildTemplateMessage(p: TemplateMessageInput): Record<string, unknown> {
  const components: unknown[] = [];
  if (p.headerDocument) {
    components.push({
      type: "header",
      parameters: [{ type: "document", document: { ...p.headerDocument.media, filename: p.headerDocument.filename } }],
    });
  }
  const params: unknown[] = [];
  for (const v of p.bodyParams ?? []) params.push({ type: "text", text: v });
  for (const n of p.namedBodyParams ?? []) params.push({ type: "text", parameter_name: n.name, text: n.value });
  if (params.length > 0) components.push({ type: "body", parameters: params });

  const template: Record<string, unknown> = { name: p.name, language: { code: p.languageCode } };
  if (components.length > 0) template["components"] = components;
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: p.to,
    type: "template",
    template,
  };
  if (p.ref) body["biz_opaque_callback_data"] = p.ref;
  return body;
}

// ---- documents Meta accepts (docs: "Supported document types") --------------------------------------------------
export const DOCUMENT_TYPES: Record<string, string> = {
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 1024;

export type DocumentProblemCode = "empty_file" | "too_large" | "bad_extension" | "no_filename" | "not_a_pdf" | "bad_link" | "caption_too_long";

export interface DocumentProblem {
  ok: false;
  code: DocumentProblemCode;
  message: Bilingual;
}

const PROBLEMS: Record<DocumentProblemCode, Bilingual> = {
  empty_file: { es: "El archivo está vacío.", en: "The file is empty." },
  too_large: { es: "El archivo supera el máximo de 100 MB que admite WhatsApp.", en: "The file is larger than the 100 MB WhatsApp allows." },
  bad_extension: {
    es: "WhatsApp solo garantiza estos tipos de documento: PDF, Word, Excel, PowerPoint y texto.",
    en: "WhatsApp only guarantees these document types: PDF, Word, Excel, PowerPoint and text.",
  },
  no_filename: { es: "Falta el nombre del archivo, con su extensión (por ejemplo presupuesto-123.pdf).", en: "The file name, with its extension, is missing (for example quote-123.pdf)." },
  not_a_pdf: { es: "El archivo se llama .pdf pero su contenido no es un PDF.", en: "The file is named .pdf but its content is not a PDF." },
  bad_link: { es: "El enlace del documento no es una dirección http(s) válida.", en: "The document link is not a valid http(s) address." },
  caption_too_long: { es: "El texto que acompaña al documento supera los 1024 caracteres.", en: "The caption is longer than 1024 characters." },
};

export function documentProblem(code: DocumentProblemCode): DocumentProblem {
  return { ok: false, code, message: PROBLEMS[code] };
}

/** Strip any path and control characters from a file name. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

export type DocumentSource =
  | { kind: "bytes"; bytes: Uint8Array; filename: string }
  | { kind: "link"; url: string; filename: string };

export type CheckedDocument =
  | { ok: true; filename: string; mime: string; source: DocumentSource }
  | DocumentProblem;

export function checkDocument(source: DocumentSource): CheckedDocument {
  const filename = cleanFilename(source.filename);
  if (filename === "" || !filename.includes(".")) return documentProblem("no_filename");
  const mime = DOCUMENT_TYPES[extensionOf(filename)];
  if (mime === undefined) return documentProblem("bad_extension");
  if (source.kind === "bytes") {
    if (source.bytes.byteLength === 0) return documentProblem("empty_file");
    if (source.bytes.byteLength > MAX_DOCUMENT_BYTES) return documentProblem("too_large");
    if (mime === "application/pdf") {
      const head = Buffer.from(source.bytes.subarray(0, 5)).toString("latin1");
      if (head !== "%PDF-") return documentProblem("not_a_pdf");
    }
  } else {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return documentProblem("bad_link");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return documentProblem("bad_link");
  }
  return { ok: true, filename, mime, source };
}
