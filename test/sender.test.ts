import { afterEach, describe, expect, it } from "vitest";
import { WhatsAppSender, type SendResult } from "../src/sender.ts";
import { makePdf } from "../src/pdf.ts";
import { mapWhatsAppError } from "../src/whatsapp-errors.ts";
import { inboundPayload } from "../testing/fixtures.ts";
import { AR, DOC, ES, makeWorld, type World, type WorldOptions } from "../testing/harness.ts";

const worlds: World[] = [];
function make(options?: WorldOptions): World {
  const w = makeWorld(options);
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

type Options = Parameters<World["documents"]["sendByWhatsApp"]>[3];
async function go(w: World, docId: string = DOC.arBudget, options: Options = {}, tenantId: string = AR.tenantId): Promise<SendResult> {
  const r = await w.documents.sendByWhatsApp(w.sender, tenantId, docId, options);
  if ("notFound" in r) throw new Error("document not found");
  return r;
}

const MARIA = "5491155500101"; // wa_id of the budget's customer
const pdf = makePdf("Test", ["x"]);

async function customerWrites(w: World, text = "hola", from = MARIA, phoneNumberId = AR.phoneNumberId) {
  await w.mock.emitInbound(phoneNumberId, from, text);
}

describe("a first send outside the 24-hour window", () => {
  it("sends the Spanish template with the PDF as the document header", async () => {
    const w = make();
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages).toHaveLength(1);
    const msg = w.mock.messages[0]!;
    expect(msg.type).toBe("template");
    expect(msg.body["to"]).toBe("+5491155500101");
    expect(msg.body["template"]).toEqual({
      name: "presupuesto_adjunto",
      language: { code: "es" },
      components: [
        { type: "header", parameters: [{ type: "document", document: { id: w.mock.uploads[0]!.id, filename: "presupuesto-P-2026-0042.pdf" } }] },
        { type: "body", parameters: [{ type: "text", text: "María Gómez" }, { type: "text", text: "P-2026-0042" }, { type: "text", text: "Taller Ejemplo SRL" }] },
      ],
    });
  });

  it("uploads the PDF as multipart with the right type and file name", async () => {
    const w = make();
    await go(w);
    const up = w.mock.uploads[0]!;
    expect(up.mime).toBe("application/pdf");
    expect(up.filename).toBe("presupuesto-P-2026-0042.pdf");
    expect(up.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(up.phoneNumberId).toBe(AR.phoneNumberId);
  });

  it("records the message id, the wa_id WhatsApp reports and a pending-delivery status", async () => {
    const w = make();
    const r = await go(w);
    expect(r.send!.status).toBe("accepted");
    expect(r.send!.wamid).toBe(w.mock.messages[0]!.wamid);
    expect(r.send!.waId).toBe(MARIA);
    expect(r.send!.kind).toBe("template");
    expect(r.send!.templateName).toBe("presupuesto_adjunto");
    expect(r.message.es).toContain("Enviado a WhatsApp");
    expect(r.message.en).toContain("Sent to WhatsApp");
  });

  it("sends the send's reference as biz_opaque_callback_data", async () => {
    const w = make();
    const r = await go(w);
    expect(r.send!.ref).toMatch(/^ws_[0-9a-f]{24}$/);
    expect(w.mock.messages[0]!.body["biz_opaque_callback_data"]).toBe(r.send!.ref);
  });

  it("uses the tenant's access token and phone_number_id and the configured Graph version", async () => {
    const w = make();
    await go(w);
    const [upload, message] = w.mock.requests;
    expect(upload!.path).toBe(`/v26.0/${AR.phoneNumberId}/media`);
    expect(message!.path).toBe(`/v26.0/${AR.phoneNumberId}/messages`);
    expect(message!.authorization).toBe(`Bearer ${AR.token}`);
  });

  it("uses another tenant's credentials for another tenant's document", async () => {
    const w = make();
    const r = await go(w, "doc-es-budget-1", {}, ES.tenantId);
    expect(r.outcome).toBe("sent");
    for (const req of w.mock.requests) {
      expect(req.path).toContain(ES.phoneNumberId);
      expect(req.authorization).toBe(`Bearer ${ES.token}`);
    }
    expect(w.mock.messages[0]!.body["to"]).toBe("+34612345678");
  });

  it("sends English templates to an English-language tenant", async () => {
    const w = make();
    w.store.upsertTenant({ id: "shop-us", name: "Shop Inc", phoneNumberId: "100000000000003", accessToken: "fake-token-shop-us", wabaId: "200000000000003", defaultCountry: "US", locale: "en" });
    w.mock.addNumber({ phoneNumberId: "100000000000003", token: "fake-token-shop-us", wabaId: "200000000000003", displayPhone: "16315550000" });
    w.mock.addDefaultTemplates("200000000000003");
    const r = await w.sender.sendDocument({
      tenantId: "shop-us",
      documentId: "q1",
      docType: "budget",
      to: "(631) 555-1234",
      document: { kind: "bytes", bytes: pdf, filename: "quote-1.pdf" },
      recipientName: "Maria",
      documentNumber: "Q-1",
    });
    expect(r.outcome).toBe("sent");
    const t = w.mock.messages[0]!.body["template"] as { name: string; language: { code: string }; components: Array<{ parameters: Array<{ text?: string }> }> };
    expect(t.name).toBe("quote_attached");
    expect(t.language.code).toBe("en");
    expect(t.components[1]!.parameters.map((p) => p.text)).toEqual(["Maria", "Q-1", "Shop Inc"]);
    expect(w.mock.messages[0]!.body["to"]).toBe("+16315551234");
  });

  it("uses a tenant's own template name and language when configured", async () => {
    const w = make();
    const t = w.store.getTenant(AR.tenantId)!;
    w.store.upsertTenant({ ...t, templates: { budget: { name: "mi_presupuesto", language: "es_AR" } } });
    w.mock.addTemplate(AR.wabaId, { name: "mi_presupuesto", language: "es_AR" });
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages[0]!.body["template"]).toMatchObject({ name: "mi_presupuesto", language: { code: "es_AR" } });
  });

  it("collapses line breaks in template variables", async () => {
    const w = make();
    const r = await w.sender.sendDocument({
      tenantId: AR.tenantId,
      documentId: "x1",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "bytes", bytes: pdf, filename: "f.pdf" },
      recipientName: "  María\n  Gómez ",
      documentNumber: "A-1",
    });
    expect(r.outcome).toBe("sent");
    const t = w.mock.messages[0]!.body["template"] as { components: Array<{ parameters: Array<{ text?: string }> }> };
    expect(t.components[1]!.parameters[0]!.text).toBe("María Gómez");
  });
});

describe("idempotency per (tenant, document, recipient)", () => {
  it("does not send twice when the button is pressed twice", async () => {
    const w = make();
    const first = await go(w);
    const second = await go(w);
    expect(first.outcome).toBe("sent");
    expect(second.outcome).toBe("duplicate");
    expect(second.send!.id).toBe(first.send!.id);
    expect(second.message.es).toContain("ya se envió");
    expect(w.mock.messages).toHaveLength(1);
    expect(w.store.listSendsForDocument(AR.tenantId, DOC.arBudget)).toHaveLength(1);
  });

  it("treats the number written two ways as the same recipient", async () => {
    const w = make();
    await go(w); // "011 15 5550-0101"
    const again = await go(w, DOC.arBudget, { to: "+54 11 5550 0101" });
    const again2 = await go(w, DOC.arBudget, { to: "+54 9 11 5550 0101" });
    expect(again.outcome).toBe("duplicate");
    expect(again2.outcome).toBe("duplicate");
    expect(w.mock.messages).toHaveLength(1);
  });

  it("sends once under concurrent clicks", async () => {
    const w = make();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => go(w)));
    expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "in_flight" || r.outcome === "duplicate")).toHaveLength(4);
    expect(w.mock.messages).toHaveLength(1);
  });

  it("sends the same document to a different recipient", async () => {
    const w = make();
    await go(w);
    const other = await go(w, DOC.arBudget, { to: "+54 9 351 555 0199" });
    expect(other.outcome).toBe("sent");
    expect(w.mock.messages).toHaveLength(2);
  });

  it("sends a different document to the same recipient", async () => {
    const w = make();
    await go(w);
    const other = await go(w, DOC.arInvoice, { to: "011 15 5550-0101" });
    expect(other.outcome).toBe("sent");
    expect(w.mock.messages).toHaveLength(2);
  });

  it("keeps two tenants apart even for the same document id and number", async () => {
    const w = make();
    const input = (tenantId: string) => ({
      tenantId,
      documentId: "same-id",
      docType: "invoice" as const,
      to: "+34 612 345 678",
      document: { kind: "bytes" as const, bytes: pdf, filename: "f.pdf" },
      recipientName: "X",
      documentNumber: "1",
    });
    const a = await w.sender.sendDocument(input(AR.tenantId));
    const b = await w.sender.sendDocument(input(ES.tenantId));
    expect(a.outcome).toBe("sent");
    expect(b.outcome).toBe("sent");
    expect(w.mock.messages.map((m) => m.phoneNumberId).sort()).toEqual([AR.phoneNumberId, ES.phoneNumberId]);
  });

  it("allows a deliberate resend as a new message with its own key", async () => {
    const w = make();
    const first = await go(w);
    const again = await go(w, DOC.arBudget, { resend: true });
    expect(again.outcome).toBe("sent");
    expect(again.send!.id).not.toBe(first.send!.id);
    expect(again.send!.seq).toBe(2);
    expect(again.send!.idempotencyKey).toBe(`${first.send!.idempotencyKey}#2`);
    expect(w.mock.messages).toHaveLength(2);
    // and a plain click after that is a duplicate of the resend
    expect((await go(w)).outcome).toBe("duplicate");
    expect(w.mock.messages).toHaveLength(2);
  });
});

describe("media", () => {
  it("uploads a file once and reuses the media id for another recipient", async () => {
    const w = make();
    const input = (to: string) => ({
      tenantId: AR.tenantId,
      documentId: "d1",
      docType: "invoice" as const,
      to,
      document: { kind: "bytes" as const, bytes: pdf, filename: "same.pdf" },
      recipientName: "X",
      documentNumber: "1",
    });
    await w.sender.sendDocument(input("+54 9 11 5550 0101"));
    await w.sender.sendDocument(input("+54 9 11 5550 0102"));
    expect(w.mock.uploads).toHaveLength(1);
    expect(w.mock.messages).toHaveLength(2);
    expect(JSON.stringify(w.mock.messages[1]!.body)).toContain(w.mock.uploads[0]!.id);
  });

  it("uploads again after the cached media id would have expired", async () => {
    const w = make();
    await go(w);
    w.clock.advance(30 * 24 * 3600);
    await go(w, DOC.arBudget, { resend: true });
    expect(w.mock.uploads).toHaveLength(2);
  });

  it("uploads again after the API refused a cached media id, instead of failing the same way until the cache entry expires", async () => {
    const w = make();
    await go(w); // uploads and caches
    w.mock.expireMedia(w.mock.uploads[0]!.id); // the platform stops accepting that id early
    const refused = await go(w, DOC.arBudget, { resend: true });
    expect(refused.outcome).toBe("failed");
    expect(refused.error?.code).toBe(131009);
    const again = await go(w, DOC.arBudget, { resend: true });
    expect(again.outcome).toBe("sent");
    expect(w.mock.uploads).toHaveLength(2);
    expect(JSON.stringify(w.mock.messages.at(-1)!.body)).toContain(w.mock.uploads[1]!.id);
  });

  it("keeps the cached media id when the outcome is only in doubt (a dropped connection says nothing about the file)", async () => {
    const w = make({ sender: { retryAmbiguous: false } });
    w.mock.dropNext(1, "messages");
    const doubtful = await go(w);
    expect(doubtful.outcome).toBe("in_doubt");
    const forced = await go(w, DOC.arBudget, { retryInDoubt: true });
    expect(forced.outcome).toBe("sent");
    expect(w.mock.uploads).toHaveLength(1);
  });

  it("does not share uploads between tenants", async () => {
    const w = make();
    const base = { documentId: "d1", docType: "invoice" as const, document: { kind: "bytes" as const, bytes: pdf, filename: "same.pdf" }, recipientName: "X", documentNumber: "1" };
    await w.sender.sendDocument({ ...base, tenantId: AR.tenantId, to: "+54 9 11 5550 0101" });
    await w.sender.sendDocument({ ...base, tenantId: ES.tenantId, to: "+34 612 345 678" });
    expect(w.mock.uploads.map((u) => u.phoneNumberId).sort()).toEqual([AR.phoneNumberId, ES.phoneNumberId]);
  });

  it("can send a hosted link instead of uploading", async () => {
    const w = make();
    const r = await w.sender.sendDocument({
      tenantId: AR.tenantId,
      documentId: "d2",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "link", url: "https://files.example.com/f.pdf", filename: "f.pdf" },
      recipientName: "X",
      documentNumber: "1",
    });
    expect(r.outcome).toBe("sent");
    expect(w.mock.uploads).toHaveLength(0);
    const header = (w.mock.messages[0]!.body["template"] as { components: Array<{ parameters: Array<{ document: unknown }> }> }).components[0]!;
    expect(header.parameters[0]!.document).toEqual({ link: "https://files.example.com/f.pdf", filename: "f.pdf" });
  });

  it("reports an upload the API rejects, sends nothing, and works on the next click", async () => {
    const w = make();
    w.mock.failNext({ status: 400, code: 131053, message: "(#131053) Media upload error", details: "bad" }, 1, "media");
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.error!.code).toBe(131053);
    expect(r.message.es).toBe(mapWhatsAppError(131053).es);
    expect(r.send!.status).toBe("failed");
    expect(w.mock.messages).toHaveLength(0);
    const retry = await go(w);
    expect(retry.outcome).toBe("sent");
    expect(retry.send!.id).toBe(r.send!.id);
  });

  it("retries an upload that hits a server error", async () => {
    const w = make();
    w.mock.serverErrorNext(2, "media");
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.sleeps).toEqual([500, 1000]);
    expect(w.mock.uploads).toHaveLength(1);
  });
});

describe("free-form versus template (the 24-hour window)", () => {
  it("sends a free-form document with a caption while the customer's window is open", async () => {
    const w = make();
    await customerWrites(w);
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    const msg = w.mock.messages[0]!;
    expect(msg.type).toBe("document");
    expect(msg.body["document"]).toEqual({ id: w.mock.uploads[0]!.id, filename: "presupuesto-P-2026-0042.pdf", caption: "Presupuesto N.º P-2026-0042 de Taller Ejemplo SRL" });
    expect(r.send!.kind).toBe("document");
    expect(r.send!.templateName).toBeNull();
  });

  it("uses the template again when the window has closed", async () => {
    const w = make();
    await customerWrites(w);
    w.clock.advance(24 * 3600);
    const r = await go(w);
    expect(r.send!.kind).toBe("template");
    expect(w.mock.messages[0]!.type).toBe("template");
  });

  it("keeps the window open for 24 hours less one second", async () => {
    const w = make();
    await customerWrites(w);
    w.clock.advance(24 * 3600 - 1);
    expect((await go(w)).send!.kind).toBe("document");
  });

  it("resets the window on each new message from the customer", async () => {
    const w = make();
    await customerWrites(w);
    w.clock.advance(20 * 3600);
    await customerWrites(w, "otra consulta");
    w.clock.advance(20 * 3600);
    expect((await go(w)).send!.kind).toBe("document");
  });

  it("opens the window for that customer only", async () => {
    const w = make();
    await customerWrites(w, "hola", "5493515550102");
    expect((await go(w)).send!.kind).toBe("template");
  });

  it("opens the window for that tenant only", async () => {
    const w = make();
    await customerWrites(w, "hola", MARIA, ES.phoneNumberId);
    expect((await go(w)).send!.kind).toBe("template");
  });

  it("recognises the customer whichever way their Argentine number is written", async () => {
    const w = make();
    await customerWrites(w, "hola", "541155500101"); // reported without the 9
    expect((await go(w)).send!.kind).toBe("document");
  });

  it("refuses a free-form send outside the window without calling the API", async () => {
    const w = make();
    const r = await go(w, DOC.arBudget, { mode: "freeform" });
    expect(r.outcome).toBe("outside_window");
    expect(r.message.es).toContain("24 horas");
    expect(w.mock.requests).toHaveLength(0);
    expect(w.store.listSends(AR.tenantId)).toHaveLength(0);
  });

  it("can force the template even inside the window", async () => {
    const w = make();
    await customerWrites(w);
    const r = await go(w, DOC.arBudget, { mode: "template" });
    expect(r.send!.kind).toBe("template");
  });

  it("falls back to a template when WhatsApp says the window is closed, and updates the send's route", async () => {
    const w = make();
    // the kit believes the window is open (it saw an inbound webhook) but the platform does not
    await w.post(inboundPayload({ phoneNumberId: AR.phoneNumberId }, { from: MARIA, wamid: "wamid.IN1", ts: w.clock.sec, text: "hola" }));
    const first = await go(w);
    expect(first.outcome).toBe("failed");
    expect(first.error).toMatchObject({ code: 131047, key: "reengagement_window", action: "send_template", retryable: false });
    expect(first.message.es).toContain("24 horas");
    const second = await go(w, DOC.arBudget, { mode: "template" });
    expect(second.outcome).toBe("sent");
    expect(second.send!.id).toBe(first.send!.id);
    expect(second.send!.kind).toBe("template");
    expect(second.send!.templateName).toBe("presupuesto_adjunto");
    expect(second.send!.language).toBe("es");
  });
});

describe("opt-out", () => {
  it("blocks a send to a number that wrote BAJA, without calling the API", async () => {
    const w = make();
    await customerWrites(w, "BAJA");
    w.mock.messages.length = 0;
    w.mock.requests.length = 0;
    const r = await go(w);
    expect(r.outcome).toBe("blocked_opt_out");
    expect(r.message.es).toContain("BAJA");
    expect(w.mock.requests).toHaveLength(0);
    expect(w.store.listSends(AR.tenantId).filter((s) => s.documentId !== null)).toHaveLength(0);
  });

  it("blocks whichever way the number is written", async () => {
    const w = make();
    await customerWrites(w, "stop", "541155500101");
    for (const to of ["011 15 5550-0101", "+54 9 11 5550 0101", "+54 11 5550 0101"]) {
      expect((await go(w, DOC.arBudget, { to })).outcome, to).toBe("blocked_opt_out");
    }
  });

  it("is per tenant: another business may still message that person", async () => {
    const w = make();
    await customerWrites(w, "STOP");
    const r = await w.sender.sendDocument({
      tenantId: ES.tenantId,
      documentId: "d9",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "bytes", bytes: pdf, filename: "f.pdf" },
      recipientName: "X",
      documentNumber: "1",
    });
    expect(r.outcome).toBe("sent");
  });

  it("lets sends through again after START", async () => {
    const w = make();
    await customerWrites(w, "BAJA");
    await customerWrites(w, "ALTA");
    expect((await go(w)).outcome).toBe("sent");
  });
});

describe("invalid input", () => {
  it("rejects an invalid number in plain language before any request or database row", async () => {
    const w = make();
    const r = await go(w, DOC.arBudget, { to: "12345" });
    expect(r.outcome).toBe("invalid_number");
    expect(r.phoneError!.code).toBe("too_short");
    expect(r.message.es).toContain("demasiado corto");
    expect(r.message.en).toContain("too short");
    expect(w.mock.requests).toHaveLength(0);
    expect(w.store.listSends(AR.tenantId)).toHaveLength(0);
  });

  it("rejects a document type WhatsApp does not accept", async () => {
    const w = make();
    const r = await w.sender.sendDocument({
      tenantId: AR.tenantId,
      documentId: "d1",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "bytes", bytes: pdf, filename: "setup.exe" },
      recipientName: "X",
      documentNumber: "1",
    });
    expect(r.outcome).toBe("invalid_document");
    expect(r.message.es).toContain("PDF");
    expect(w.mock.requests).toHaveLength(0);
  });

  it("rejects a caption over 1024 characters", async () => {
    const w = make();
    const r = await w.sender.sendDocument({
      tenantId: AR.tenantId,
      documentId: "d1",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "bytes", bytes: pdf, filename: "f.pdf" },
      recipientName: "X",
      documentNumber: "1",
      caption: "x".repeat(1025),
    });
    expect(r.outcome).toBe("invalid_document");
    expect(r.message.en).toContain("1024");
  });

  it("throws for an unknown tenant", async () => {
    const w = make();
    await expect(
      w.sender.sendDocument({ tenantId: "nope", documentId: "d", docType: "invoice", to: "+54 9 11 5550 0101", document: { kind: "bytes", bytes: pdf, filename: "f.pdf" }, recipientName: "X", documentNumber: "1" }),
    ).rejects.toMatchObject({ name: "UnknownTenantError" });
  });
});

describe("API errors in plain language", () => {
  it("explains a number that is not on WhatsApp and does not retry", async () => {
    const w = make();
    w.mock.notOnWhatsApp.add(MARIA);
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatchObject({ code: 131026, key: "undeliverable", retryable: false, action: "check_recipient" });
    expect(r.message.es).toContain("no tiene WhatsApp");
    expect(r.message.en).toContain("not on WhatsApp");
    expect(r.send!.status).toBe("failed");
    expect(r.send!.errorCode).toBe(131026);
    expect(r.send!.errorEs).toBe(r.message.es);
    expect(r.send!.errorEn).toBe(r.message.en);
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
  });

  it("explains a missing template (not approved yet)", async () => {
    const w = make({ templates: false });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatchObject({ code: 132001, key: "template_missing", action: "fix_template" });
    expect(r.message.es).toContain("no existe");
    expect(w.sleeps).toEqual([]);
  });

  it("explains a template whose variable count changed", async () => {
    const w = make({ templates: false });
    w.mock.addTemplate(AR.wabaId, { name: "presupuesto_adjunto", language: "es", bodyParams: 2 });
    const r = await go(w);
    expect(r.error).toMatchObject({ code: 132000, key: "template_param_count", action: "fix_parameters" });
  });

  it("explains a revoked token and does not retry", async () => {
    const w = make();
    w.store.upsertTenant({ ...w.store.getTenant(AR.tenantId)!, accessToken: "revoked-token" });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatchObject({ code: 190, key: "token_expired", action: "fix_token", retryable: false });
    expect(r.message.es).toContain("venció");
    expect(w.sleeps).toEqual([]);
  });

  it("explains a send to the business's own number", async () => {
    const w = make();
    const r = await go(w, DOC.arBudget, { to: "+" + AR.display });
    expect(r.error).toMatchObject({ code: 131021, key: "same_sender_recipient" });
  });

  it("keeps the technical detail for support next to the plain text", async () => {
    const w = make();
    w.mock.notOnWhatsApp.add(MARIA);
    const r = await go(w);
    expect(r.send!.errorDetails).toBe("Message undeliverable.");
  });

  it("lets the person press the button again after a failure, on the same send", async () => {
    const w = make();
    w.mock.notOnWhatsApp.add(MARIA);
    const failed = await go(w);
    w.mock.notOnWhatsApp.clear();
    const ok = await go(w);
    expect(ok.outcome).toBe("sent");
    expect(ok.send!.id).toBe(failed.send!.id);
    expect(ok.send!.errorCode).toBeNull();
    expect(ok.send!.errorEs).toBeNull();
  });
});

describe("retry with backoff", () => {
  it("retries a 429 with exponential delays and then succeeds", async () => {
    const w = make();
    w.mock.failNext({ status: 429, code: 130429, message: "(#130429) Rate limit hit" }, 2, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.sleeps).toEqual([500, 1000]);
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(3);
    expect(w.mock.messages).toHaveLength(1);
    expect(r.send!.attempts).toBe(4); // 1 upload + 3 message requests
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    const w = make();
    w.mock.failNext({ status: 429, code: 130429, retryAfterSeconds: 3 }, 1, "messages");
    await go(w);
    expect(w.sleeps).toEqual([3000]);
  });

  it("caps Retry-After at one minute", async () => {
    const w = make();
    w.mock.failNext({ status: 429, code: 130429, retryAfterSeconds: 500 }, 1, "messages");
    await go(w);
    expect(w.sleeps).toEqual([60_000]);
  });

  it("gives up after 3 retries and says the failure is temporary", async () => {
    const w = make();
    w.mock.failNext({ status: 429, code: 130429 }, 10, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatchObject({ code: 130429, key: "throughput", retryable: true, action: "retry_later" });
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(4);
    expect(w.sleeps).toEqual([500, 1000, 2000]);
    expect(r.send!.status).toBe("failed");
  });

  it("retries a 500 that carries a documented retryable code", async () => {
    const w = make();
    w.mock.serverErrorNext(1, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.sleeps).toEqual([500]);
  });

  it("retries the throttling code even when the HTTP status is not 429", async () => {
    const w = make();
    w.mock.failNext({ status: 400, code: 131056, message: "(#131056) pair rate limit" }, 1, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.sleeps).toEqual([500]);
  });

  it("does not retry a client error", async () => {
    const w = make();
    w.mock.failNext({ status: 400, code: 131009, message: "(#131009) bad value" }, 5, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
  });

  it("computes the delay as base * 2^n, capped, with +-20 % jitter", () => {
    const w = make();
    const at = (random: number) => new WhatsAppSender({ store: w.store, fetch: w.mock.fetch, random: () => random });
    const mid = at(0.5);
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => mid.backoffMs(n, null))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(at(0).backoffMs(1, null)).toBe(400);
    expect(at(1).backoffMs(1, null)).toBe(600);
    expect(at(0).backoffMs(5, null)).toBe(6400);
    expect(mid.backoffMs(1, 2000)).toBe(2000);
    expect(mid.backoffMs(3, 100)).toBe(2000);
  });

  it("honours custom retry settings", async () => {
    const w = make({ sender: { maxRetries: 1, baseDelayMs: 100 } });
    w.mock.failNext({ status: 429, code: 130429 }, 10, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(2);
    expect(w.sleeps).toEqual([100]);
  });
});

describe("outcomes the API leaves unclear", () => {
  it("retries a dropped connection by default", async () => {
    const w = make();
    w.mock.dropNext(1, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages).toHaveLength(1);
  });

  it("with retryAmbiguous off, stops and marks the send unknown instead of risking a double send", async () => {
    const w = make({ sender: { retryAmbiguous: false } });
    w.mock.dropNext(1, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("in_doubt");
    expect(r.send!.status).toBe("unknown");
    expect(r.error!.key).toBe("network");
    expect(w.sleeps).toEqual([]);
    expect(w.mock.messages).toHaveLength(0);
    // the next click does not blindly resend ...
    const again = await go(w);
    expect(again.outcome).toBe("in_doubt");
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(1);
    // ... unless the person says so
    const forced = await go(w, DOC.arBudget, { retryInDoubt: true });
    expect(forced.outcome).toBe("sent");
    expect(forced.send!.id).toBe(r.send!.id);
  });

  it("treats a request timeout as unknown, with the reason kept", async () => {
    const w = make({ sender: { retryAmbiguous: false, requestTimeoutMs: 50 } });
    w.mock.hangNext(1, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("in_doubt");
    expect(r.send!.errorDetails).toMatch(/timeout|abort/i);
  });

  it("adopts the message id from a later status webhook when the answer was lost", async () => {
    const w = make({ sender: { retryAmbiguous: false } });
    w.mock.failAfterAccept(1);
    const r = await go(w);
    expect(r.outcome).toBe("in_doubt");
    expect(w.mock.messages).toHaveLength(1);
    const created = w.mock.messages[0]!;
    await w.mock.emitStatus(created.wamid, "sent");
    const row = w.store.getSend(r.send!.id)!;
    expect(row.wamid).toBe(created.wamid);
    expect(row.status).toBe("sent");
    expect(row.errorEs).toBeNull();
    // and the button now says "already sent"
    expect((await go(w)).outcome).toBe("duplicate");
    expect(w.mock.messages).toHaveLength(1);
  });

  it("flags a possible double send when a retry after a 5xx created a second message", async () => {
    const w = make();
    w.mock.failAfterAccept(1);
    const r = await go(w);
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages).toHaveLength(2);
    const [first, second] = w.mock.messages;
    expect(r.send!.wamid).toBe(second!.wamid);
    await w.mock.emitStatus(first!.wamid, "delivered");
    const row = w.store.getSend(r.send!.id)!;
    expect(row.doubleSendSuspected).toBe(true);
    expect(w.store.listExtraWamids(row.id)).toEqual([first!.wamid]);
    const entry = w.documents.history(AR.tenantId, DOC.arBudget)[0]!;
    expect(entry.warnings[0]).toContain("2 mensajes");
  });

  it("marks a 2xx answer without a message id as unknown", async () => {
    const w = make({ sender: { fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) } });
    const r = await w.sender.sendDocument({
      tenantId: AR.tenantId,
      documentId: "d1",
      docType: "invoice",
      to: "+54 9 11 5550 0101",
      document: { kind: "link", url: "https://example.com/f.pdf", filename: "f.pdf" },
      recipientName: "X",
      documentNumber: "1",
    });
    expect(r.outcome).toBe("in_doubt");
    expect(r.send!.status).toBe("unknown");
    expect(r.send!.wamid).toBeNull();
  });

  it("marks repeated unreadable 5xx answers as unknown, not failed", async () => {
    const w = make();
    w.mock.failNext({ status: 502, raw: "<html>Bad Gateway</html>" }, 10, "messages");
    const r = await go(w);
    expect(r.outcome).toBe("in_doubt");
    expect(r.error).toMatchObject({ key: "unexpected_response", retryable: true });
    expect(r.send!.status).toBe("unknown");
    expect(w.mock.requests.filter((q) => q.target === "messages")).toHaveLength(4);
  });

  it("does not let a deliberate resend start while the previous send is still running", async () => {
    const w = make();
    const tenant = w.store.getTenant(AR.tenantId)!;
    const doc = w.documents.get(AR.tenantId, DOC.arBudget)!;
    const running = w.store.reserveSend({
      tenantId: tenant.id,
      documentId: doc.id,
      docType: doc.type,
      recipientKey: "541155500101",
      recipientE164: "+5491155500101",
      baseKey: `${tenant.id}|${doc.id}|541155500101`,
      kind: "template",
      templateName: "presupuesto_adjunto",
      language: "es",
      filename: "f.pdf",
      resend: false,
    });
    const r = await go(w, DOC.arBudget, { resend: true });
    expect(r.outcome).toBe("in_flight");
    expect(r.send!.id).toBe(running.send.id);
    expect(w.store.listSendsForDocument(tenant.id, doc.id)).toHaveLength(1);
    expect(w.mock.messages).toHaveLength(0);
  });

  it("does not let \"retry the doubtful send\" take over a send another worker is running right now", async () => {
    const w = make();
    const tenant = w.store.getTenant(AR.tenantId)!;
    const doc = w.documents.get(AR.tenantId, DOC.arBudget)!;
    const running = w.store.reserveSend({
      tenantId: tenant.id,
      documentId: doc.id,
      docType: doc.type,
      recipientKey: "541155500101",
      recipientE164: "+5491155500101",
      baseKey: `${tenant.id}|${doc.id}|541155500101`,
      kind: "template",
      templateName: "presupuesto_adjunto",
      language: "es",
      filename: "f.pdf",
      resend: false,
    });
    const r = await go(w, DOC.arBudget, { retryInDoubt: true });
    expect(r.outcome).toBe("in_flight");
    expect(r.send!.id).toBe(running.send.id);
    expect(w.mock.messages).toHaveLength(0);
  });

  it("resumes a send whose worker died mid-request, but only after the stale period", async () => {
    const w = make();
    const tenant = w.store.getTenant(AR.tenantId)!;
    const doc = w.documents.get(AR.tenantId, DOC.arBudget)!;
    w.store.reserveSend({
      tenantId: tenant.id,
      documentId: doc.id,
      docType: doc.type,
      recipientKey: "541155500101",
      recipientE164: "+5491155500101",
      baseKey: `${tenant.id}|${doc.id}|541155500101`,
      kind: "template",
      templateName: "presupuesto_adjunto",
      language: "es",
      filename: "f.pdf",
      resend: false,
    });
    expect((await go(w)).outcome).toBe("in_flight");
    w.clock.advance(301);
    expect((await go(w)).outcome).toBe("in_doubt");
    expect((await go(w, DOC.arBudget, { retryInDoubt: true })).outcome).toBe("sent");
  });
});

describe("sendText", () => {
  const text = (w: World, extra: Partial<Parameters<WhatsAppSender["sendText"]>[0]> = {}) =>
    w.sender.sendText({ tenantId: AR.tenantId, to: "+54 9 11 5550 0101", body: "Hola, ¿necesita algo más?", key: "k1", ...extra });

  it("is refused outside the 24-hour window", async () => {
    const w = make();
    const r = await text(w);
    expect(r.outcome).toBe("outside_window");
    expect(w.mock.requests).toHaveLength(0);
  });

  it("sends inside the window and is idempotent per key", async () => {
    const w = make();
    await customerWrites(w);
    const a = await text(w);
    const b = await text(w);
    const c = await text(w, { key: "k2" });
    expect(a.outcome).toBe("sent");
    expect(b.outcome).toBe("duplicate");
    expect(c.outcome).toBe("sent");
    expect(w.mock.messages.map((m) => m.type)).toEqual(["text", "text"]);
    expect((w.mock.messages[0]!.body["text"] as { body: string }).body).toBe("Hola, ¿necesita algo más?");
  });

  it("is blocked after an opt-out, except for the confirmation of the opt-out itself", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    await customerWrites(w, "BAJA");
    expect((await text(w)).outcome).toBe("blocked_opt_out");
    expect((await text(w, { purpose: "optout_ack", key: "ack1" })).outcome).toBe("sent");
  });

  it("can address a person by business-scoped user id", async () => {
    const w = make();
    await w.post(inboundPayload({ phoneNumberId: AR.phoneNumberId }, { fromUserId: "AR.13491208655302741918", wamid: "wamid.IN7", ts: w.clock.sec, text: "hola" }));
    const r = await w.sender.sendText({ tenantId: AR.tenantId, bsuid: "AR.13491208655302741918", body: "Hola", key: "b1" });
    expect(r.outcome).toBe("sent");
    expect(w.mock.messages[0]!.body["recipient"]).toBe("AR.13491208655302741918");
    expect("to" in w.mock.messages[0]!.body).toBe(false);
  });

  it("rejects a call with no recipient", async () => {
    const w = make();
    const r = await w.sender.sendText({ tenantId: AR.tenantId, body: "x", key: "k" });
    expect(r.outcome).toBe("invalid_number");
  });

  it("rejects an invalid number", async () => {
    const w = make();
    const r = await text(w, { to: "abc" });
    expect(r.outcome).toBe("invalid_number");
    expect(r.phoneError!.code).toBe("invalid_characters");
  });
});
