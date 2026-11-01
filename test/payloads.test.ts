import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPES,
  MAX_CAPTION_CHARS,
  buildDocumentMessage,
  buildTemplateMessage,
  buildTextMessage,
  checkDocument,
  cleanFilename,
  documentProblem,
  extensionOf,
} from "../src/payloads.ts";
import { makePdf } from "../src/pdf.ts";

const pdf = makePdf("Presupuesto P-1", ["Línea uno", "Total: 10"]);

describe("buildDocumentMessage", () => {
  it("uses the documented field names with an uploaded media id", () => {
    expect(buildDocumentMessage({ to: "+5491155500101", media: { id: "123" }, filename: "presupuesto-1.pdf", caption: "Presupuesto N.º 1", ref: "ws_abc" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5491155500101",
      type: "document",
      document: { id: "123", filename: "presupuesto-1.pdf", caption: "Presupuesto N.º 1" },
      biz_opaque_callback_data: "ws_abc",
    });
  });

  it("can link to a hosted file instead", () => {
    const m = buildDocumentMessage({ to: "+34612345678", media: { link: "https://example.com/a.pdf" }, filename: "a.pdf" });
    expect(m["document"]).toEqual({ link: "https://example.com/a.pdf", filename: "a.pdf" });
  });

  it("leaves out an empty caption and a missing reference", () => {
    const m = buildDocumentMessage({ to: "+34612345678", media: { id: "1" }, filename: "a.pdf", caption: "" });
    expect(m["document"]).toEqual({ id: "1", filename: "a.pdf" });
    expect("biz_opaque_callback_data" in m).toBe(false);
  });

  it("addresses a business-scoped user id with `recipient` and no `to`", () => {
    const m = buildDocumentMessage({ recipient: "US.13491208655302741918", media: { id: "1" }, filename: "a.pdf" });
    expect(m["recipient"]).toBe("US.13491208655302741918");
    expect("to" in m).toBe(false);
  });
});

describe("buildTextMessage", () => {
  it("builds a text message with link previews off", () => {
    expect(buildTextMessage({ to: "+5491155500101", body: "Hola", ref: "ws_1" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5491155500101",
      type: "text",
      text: { preview_url: false, body: "Hola" },
      biz_opaque_callback_data: "ws_1",
    });
  });

  it("supports `recipient`", () => {
    const m = buildTextMessage({ recipient: "AR.123", body: "x" });
    expect(m["recipient"]).toBe("AR.123");
    expect("to" in m).toBe(false);
    expect("biz_opaque_callback_data" in m).toBe(false);
  });
});

describe("buildTemplateMessage", () => {
  it("builds a document header and positional body parameters", () => {
    const m = buildTemplateMessage({
      to: "+5491155500101",
      name: "presupuesto_adjunto",
      languageCode: "es",
      bodyParams: ["María", "P-2026-0042", "Taller Ejemplo"],
      headerDocument: { media: { id: "999" }, filename: "presupuesto-P-2026-0042.pdf" },
      ref: "ws_x",
    });
    expect(m).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5491155500101",
      type: "template",
      template: {
        name: "presupuesto_adjunto",
        language: { code: "es" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id: "999", filename: "presupuesto-P-2026-0042.pdf" } }] },
          {
            type: "body",
            parameters: [
              { type: "text", text: "María" },
              { type: "text", text: "P-2026-0042" },
              { type: "text", text: "Taller Ejemplo" },
            ],
          },
        ],
      },
      biz_opaque_callback_data: "ws_x",
    });
  });

  it("supports named body parameters", () => {
    const m = buildTemplateMessage({ to: "+1", name: "n", languageCode: "en", namedBodyParams: [{ name: "customer", value: "Maria" }] });
    const body = (m["template"] as { components: Array<{ parameters: unknown[] }> }).components[0]!;
    expect(body.parameters).toEqual([{ type: "text", parameter_name: "customer", text: "Maria" }]);
  });

  it("omits components when there are no parameters", () => {
    const m = buildTemplateMessage({ to: "+1", name: "hello", languageCode: "es_AR" });
    expect(m["template"]).toEqual({ name: "hello", language: { code: "es_AR" } });
    expect("biz_opaque_callback_data" in m).toBe(false);
  });

  it("can link the header document", () => {
    const m = buildTemplateMessage({ to: "+1", name: "n", languageCode: "es", headerDocument: { media: { link: "https://example.com/a.pdf" }, filename: "a.pdf" } });
    const header = (m["template"] as { components: Array<{ parameters: Array<{ document: unknown }> }> }).components[0]!;
    expect(header.parameters[0]!.document).toEqual({ link: "https://example.com/a.pdf", filename: "a.pdf" });
  });
});

describe("checkDocument", () => {
  it("accepts a real PDF and reports its mime type", () => {
    const r = checkDocument({ kind: "bytes", bytes: pdf, filename: "presupuesto.pdf" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe("application/pdf");
      expect(r.filename).toBe("presupuesto.pdf");
    }
  });

  it("removes directories and control characters from the file name", () => {
    const r = checkDocument({ kind: "bytes", bytes: pdf, filename: "../../etc/passwd/factura\u0000-1.pdf" });
    expect(r.ok && r.filename).toBe("factura-1.pdf");
  });

  it("requires a file name with an extension", () => {
    for (const filename of ["", "   ", "factura", "/"]) {
      const r = checkDocument({ kind: "bytes", bytes: pdf, filename });
      expect(r.ok === false && r.code, filename).toBe("no_filename");
    }
  });

  it("rejects file types WhatsApp does not guarantee", () => {
    const r = checkDocument({ kind: "bytes", bytes: pdf, filename: "virus.exe" });
    expect(r.ok === false && r.code).toBe("bad_extension");
  });

  it("rejects an empty file", () => {
    const r = checkDocument({ kind: "bytes", bytes: new Uint8Array(0), filename: "a.pdf" });
    expect(r.ok === false && r.code).toBe("empty_file");
  });

  it("allows exactly 100 MB and rejects one byte more", () => {
    const head = Buffer.from("%PDF-1.4\n");
    const sized = (n: number) => Object.defineProperty(new Uint8Array(head), "byteLength", { value: n });
    expect(checkDocument({ kind: "bytes", bytes: sized(100 * 1024 * 1024), filename: "a.pdf" }).ok).toBe(true);
    const over = checkDocument({ kind: "bytes", bytes: sized(100 * 1024 * 1024 + 1), filename: "a.pdf" });
    expect(over.ok === false && over.code).toBe("too_large");
  });

  it("rejects a .pdf that is not a PDF", () => {
    const r = checkDocument({ kind: "bytes", bytes: Buffer.from("hello world"), filename: "a.pdf" });
    expect(r.ok === false && r.code).toBe("not_a_pdf");
  });

  it("does not check the magic bytes of other types", () => {
    expect(checkDocument({ kind: "bytes", bytes: Buffer.from("a,b,c"), filename: "a.txt" }).ok).toBe(true);
  });

  it("accepts https and http links and rejects other schemes", () => {
    expect(checkDocument({ kind: "link", url: "https://example.com/a.pdf", filename: "a.pdf" }).ok).toBe(true);
    expect(checkDocument({ kind: "link", url: "http://example.com/a.pdf", filename: "a.pdf" }).ok).toBe(true);
    for (const url of ["ftp://example.com/a.pdf", "file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      const r = checkDocument({ kind: "link", url, filename: "a.pdf" });
      expect(r.ok === false && r.code, url).toBe("bad_link");
    }
  });
});

describe("document problems", () => {
  it("have Spanish and English text", () => {
    for (const code of ["empty_file", "too_large", "bad_extension", "no_filename", "not_a_pdf", "bad_link", "caption_too_long"] as const) {
      const p = documentProblem(code);
      expect(p.ok).toBe(false);
      expect(p.message.es.length).toBeGreaterThan(10);
      expect(p.message.en.length).toBeGreaterThan(10);
    }
    expect(documentProblem("too_large").message.en).toContain("100 MB");
  });
});

describe("file name helpers", () => {
  it("cleanFilename keeps the last path segment, drops control characters and caps the length", () => {
    expect(cleanFilename("C:\\Users\\x\\a.pdf")).toBe("a.pdf");
    expect(cleanFilename("a/b/c.pdf")).toBe("c.pdf");
    expect(cleanFilename("  a.pdf  ")).toBe("a.pdf");
    expect(cleanFilename("a\tb\n.pdf")).toBe("ab.pdf");
    expect(cleanFilename("x".repeat(300) + ".pdf")).toHaveLength(200);
  });

  it("extensionOf is lower-case and handles no extension", () => {
    expect(extensionOf("A.PDF")).toBe("pdf");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(extensionOf("noext")).toBe("");
  });

  it("lists the documented document types", () => {
    expect(Object.keys(DOCUMENT_TYPES).sort()).toEqual(["doc", "docx", "pdf", "ppt", "pptx", "txt", "xls", "xlsx"]);
    expect(DOCUMENT_TYPES["pdf"]).toBe("application/pdf");
    expect(MAX_CAPTION_CHARS).toBe(1024);
  });
});

describe("makePdf", () => {
  it("writes a PDF that starts with %PDF- and ends with %%EOF", () => {
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Presupuesto P-1");
  });
});
