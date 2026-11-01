import { afterEach, describe, expect, it } from "vitest";
import { escapeHtml, formatMoney, renderDocument, renderDocumentList, totalCents, type DocumentRecord } from "../src/documents.ts";
import { AR, DOC, ES, makeWorld, type World } from "../testing/harness.ts";

const worlds: World[] = [];
function make(): World {
  const w = makeWorld();
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

const send = async (w: World, docId: string = DOC.arBudget, options = {}) => {
  const r = await w.documents.sendByWhatsApp(w.sender, AR.tenantId, docId, options);
  if ("notFound" in r) throw new Error("not found");
  return r;
};

describe("demo documents", () => {
  it("loads two tenants with three documents each", () => {
    const w = make();
    expect(w.store.listTenants().map((t) => t.id)).toEqual([ES.tenantId, AR.tenantId]); // ordered by id
    expect(w.documents.list(AR.tenantId).map((d) => d.type).sort()).toEqual(["budget", "invoice", "purchase_order"]);
    expect(w.documents.list(ES.tenantId)).toHaveLength(3);
  });

  it("reads a document back with its lines", () => {
    const w = make();
    const d = w.documents.get(AR.tenantId, DOC.arBudget)!;
    expect(d.number).toBe("P-2026-0042");
    expect(d.customerPhone).toBe("011 15 5550-0101");
    expect(d.lines).toHaveLength(2);
    expect(w.documents.get(ES.tenantId, DOC.arBudget)).toBeUndefined();
    expect(w.documents.get(AR.tenantId, "nope")).toBeUndefined();
  });

  it("updates a document on a second upsert", () => {
    const w = make();
    const d = w.documents.get(AR.tenantId, DOC.arBudget)!;
    w.documents.upsert({ ...d, customerName: "Otra Persona" });
    expect(w.documents.get(AR.tenantId, DOC.arBudget)!.customerName).toBe("Otra Persona");
    expect(w.documents.list(AR.tenantId)).toHaveLength(3);
  });

  it("totals the lines", () => {
    const w = make();
    expect(totalCents(w.documents.get(AR.tenantId, DOC.arBudget)!)).toBe(18500000 + 4 * 1200000);
    expect(totalCents({ lines: [] })).toBe(0);
  });

  it("formats money for each language", () => {
    expect(formatMoney(23300000, "ARS", "es")).toContain("233.000,00");
    expect(formatMoney(23300000, "ARS", "en")).toContain("233,000.00");
  });

  it("makes a real PDF and a safe file name", () => {
    const w = make();
    const d = w.documents.get(AR.tenantId, DOC.arBudget)!;
    const pdf = Buffer.from(w.documents.pdf(d, "Taller Ejemplo SRL", "es")).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("Presupuesto P-2026-0042");
    expect(pdf).toContain("Total:");
    expect(w.documents.filename(d, "es")).toBe("presupuesto-P-2026-0042.pdf");
    expect(w.documents.filename(d, "en")).toBe("quote-P-2026-0042.pdf");
    expect(w.documents.filename({ ...d, type: "invoice", number: "A/1  2" }, "es")).toBe("factura-A-1-2.pdf");
  });
});

describe("Send by WhatsApp", () => {
  it("reports an unknown document or tenant as not found, and a document of another tenant too", async () => {
    const w = make();
    expect(await w.documents.sendByWhatsApp(w.sender, AR.tenantId, "nope")).toEqual({ notFound: true });
    expect(await w.documents.sendByWhatsApp(w.sender, "nope", DOC.arBudget)).toEqual({ notFound: true });
    expect(await w.documents.sendByWhatsApp(w.sender, ES.tenantId, DOC.arBudget)).toEqual({ notFound: true });
    expect(w.mock.requests).toHaveLength(0);
  });

  it("sends to the number stored on the document unless another is given", async () => {
    const w = make();
    await send(w);
    await send(w, DOC.arBudget, { to: "+54 9 351 555 0199" });
    expect(w.mock.messages.map((m) => m.body["to"])).toEqual(["+5491155500101", "+5493515550199"]);
  });

  it("sends a Mexican customer's document through the Spanish tenant's number", async () => {
    const w = make();
    const r = await w.documents.sendByWhatsApp(w.sender, ES.tenantId, "doc-es-po-1");
    if ("notFound" in r) throw new Error("nf");
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages[0]!.body["to"]).toBe("+525555500104");
  });
});

describe("send history of a document", () => {
  it("is empty before anything is sent", () => {
    const w = make();
    expect(w.documents.history(AR.tenantId, DOC.arBudget)).toEqual([]);
  });

  it("shows who, how, status and times once delivered and read", async () => {
    const w = make();
    const r = await send(w);
    const t = w.clock.sec;
    await w.mock.emitStatus(r.send!.wamid!, "sent", { ts: t + 1 });
    await w.mock.emitStatus(r.send!.wamid!, "delivered", { ts: t + 2 });
    await w.mock.emitStatus(r.send!.wamid!, "read", { ts: t + 3 });
    const [entry] = w.documents.history(AR.tenantId, DOC.arBudget);
    expect(entry).toMatchObject({
      recipient: "+5491155500101",
      how: "template",
      status: "read",
      statusText: "Leído",
      sentAt: t + 1,
      deliveredAt: t + 2,
      readAt: t + 3,
      deliveredImplied: false,
      error: null,
      errorCode: null,
      warnings: [],
    });
  });

  it("lists every send of the document, oldest first", async () => {
    const w = make();
    await send(w);
    await send(w, DOC.arBudget, { resend: true });
    await send(w, DOC.arBudget, { to: "+54 9 351 555 0199" });
    const h = w.documents.history(AR.tenantId, DOC.arBudget);
    expect(h.map((e) => e.recipient)).toEqual(["+5491155500101", "+5491155500101", "+5493515550199"]);
    expect(h.map((e) => e.sendId)).toEqual([...h.map((e) => e.sendId)].sort((a, b) => a - b));
  });

  it("does not show another document's or another tenant's sends", async () => {
    const w = make();
    await send(w);
    expect(w.documents.history(AR.tenantId, DOC.arInvoice)).toEqual([]);
    expect(w.documents.history(ES.tenantId, DOC.arBudget)).toEqual([]);
  });

  it("explains a failure in plain Spanish", async () => {
    const w = make();
    w.mock.notOnWhatsApp.add("5491155500101");
    await send(w);
    const [entry] = w.documents.history(AR.tenantId, DOC.arBudget);
    expect(entry!.status).toBe("failed");
    expect(entry!.statusText).toBe("Falló");
    expect(entry!.error).toContain("no tiene WhatsApp");
    expect(entry!.errorCode).toBe(131026);
  });

  it("says when a send is unconfirmed", async () => {
    const w = makeWorld({ sender: { retryAmbiguous: false } });
    worlds.push(w);
    w.mock.dropNext(1, "messages");
    await send(w);
    const [entry] = w.documents.history(AR.tenantId, DOC.arBudget);
    expect(entry!.status).toBe("unknown");
    expect(entry!.statusText).toBe("Sin confirmar");
  });

  it("warns that a delivery was inferred from a read receipt", async () => {
    const w = make();
    const r = await send(w);
    await w.mock.emitStatus(r.send!.wamid!, "read");
    const [entry] = w.documents.history(AR.tenantId, DOC.arBudget);
    expect(entry!.deliveredImplied).toBe(true);
    expect(entry!.warnings[0]).toContain("deducida");
  });

  it("uses the tenant's language", async () => {
    const w = make();
    w.store.upsertTenant({ id: "shop-us", name: "Shop Inc", phoneNumberId: "100000000000003", accessToken: "fake-token-shop-us", wabaId: "200000000000003", defaultCountry: "US", locale: "en" });
    w.mock.addNumber({ phoneNumberId: "100000000000003", token: "fake-token-shop-us", wabaId: "200000000000003", displayPhone: "16315550000" });
    w.mock.addDefaultTemplates("200000000000003");
    w.documents.upsert({ tenantId: "shop-us", id: "q1", type: "budget", number: "Q-1", customerName: "Maria", customerPhone: "(631) 555-1234", currency: "USD", issuedOn: "2026-10-30", lines: [{ description: "Work", quantity: 1, unitCents: 1000 }] });
    const r = await w.documents.sendByWhatsApp(w.sender, "shop-us", "q1");
    if ("notFound" in r) throw new Error("nf");
    await w.mock.emitStatus(r.send!.wamid!, "read");
    const [entry] = w.documents.history("shop-us", "q1");
    expect(entry!.statusText).toBe("Read");
    expect(entry!.warnings[0]).toContain("inferred");
  });
});

describe("HTML views", () => {
  const evil: DocumentRecord = {
    tenantId: AR.tenantId,
    id: "evil",
    type: "invoice",
    number: '"><script>alert(2)</script>',
    customerName: "<img src=x onerror=alert(1)>",
    customerPhone: "011 15 5550-0101",
    currency: "ARS",
    issuedOn: "2026-10-30",
    lines: [{ description: "x", quantity: 1, unitCents: 100 }],
  };

  it("escapes html special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("escapes document fields on the detail page", () => {
    const w = make();
    w.documents.upsert(evil);
    const html = renderDocument(w.store.getTenant(AR.tenantId)!, evil, []);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes error text and warnings in the history table", async () => {
    const w = make();
    await send(w);
    const row = w.store.listSendsForDocument(AR.tenantId, DOC.arBudget)[0]!;
    w.store.markFailedBeforeAccept(row.id, { code: 1, details: "d", es: "<b>mal</b>", en: "<b>bad</b>" });
    const doc = w.documents.get(AR.tenantId, DOC.arBudget)!;
    const html = renderDocument(w.store.getTenant(AR.tenantId)!, doc, w.documents.history(AR.tenantId, DOC.arBudget));
    expect(html).not.toContain("<b>mal</b>");
    expect(html).toContain("&lt;b&gt;mal&lt;/b&gt;");
  });

  it("shows a disabled email button next to the working WhatsApp one", () => {
    const w = make();
    const doc = w.documents.get(AR.tenantId, DOC.arBudget)!;
    const html = renderDocument(w.store.getTenant(AR.tenantId)!, doc, []);
    expect(html).toMatch(/<button disabled[^>]*>Enviar por email<\/button>/);
    expect(html).toContain("Enviar por WhatsApp");
    expect(html).toContain(`/t/${AR.tenantId}/documents/${DOC.arBudget}/send-whatsapp`);
  });

  it("lists the documents with their latest WhatsApp status", async () => {
    const w = make();
    const r = await send(w);
    await w.mock.emitStatus(r.send!.wamid!, "delivered");
    const html = renderDocumentList(w.store.getTenant(AR.tenantId)!, w.documents.list(AR.tenantId), w.documents);
    expect(html).toContain("P-2026-0042");
    expect(html).toContain("A-0001-00001234");
    expect(html).toContain("Entregado");
    expect(html).not.toContain("P-2026-0043"); // nothing from the other tenant
    expect(html).not.toContain("Estudio Ejemplo");
  });
});
