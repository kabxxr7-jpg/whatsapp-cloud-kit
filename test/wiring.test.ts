import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, createWhatsAppIntegration, type Env } from "../examples/own-app/wiring.ts";
import { Store } from "../src/db.ts";
import { makePdf } from "../src/pdf.ts";
import { inboundPayload, sign, statusPayload, verifyQuery } from "../testing/fixtures.ts";
import { AR } from "../testing/harness.ts";

const ENV: Env = { WHATSAPP_APP_SECRET: "wiring-secret-1", WHATSAPP_VERIFY_TOKEN: "wiring-verify" };
const stores: Store[] = [];
function store(): Store {
  const s = new Store(":memory:");
  s.upsertTenant({ id: AR.tenantId, name: "Taller Ejemplo", phoneNumberId: AR.phoneNumberId, accessToken: "fake-token", wabaId: AR.wabaId, defaultCountry: "AR", locale: "es" });
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe("environment", () => {
  it("refuses to start without the app secret", () => {
    expect(() => createWhatsAppIntegration({ WHATSAPP_VERIFY_TOKEN: "x" }, { store: store() })).toThrow(ConfigError);
  });
  it("refuses to start without the verify token", () => {
    expect(() => createWhatsAppIntegration({ WHATSAPP_APP_SECRET: "x" }, { store: store() })).toThrow(/WHATSAPP_VERIFY_TOKEN/);
  });
  it("treats a blank value as missing", () => {
    expect(() => createWhatsAppIntegration({ ...ENV, WHATSAPP_APP_SECRET: "   " }, { store: store() })).toThrow(/WHATSAPP_APP_SECRET/);
  });
});

describe("webhook mounted from the environment", () => {
  it("answers the GET verification with the challenge", () => {
    const w = createWhatsAppIntegration(ENV, { store: store() });
    const r = w.verify(verifyQuery("wiring-verify", "424242"));
    expect(r.status).toBe(200);
    expect(r.body).toBe("424242");
  });
  it("refuses a wrong verify token", () => {
    const w = createWhatsAppIntegration(ENV, { store: store() });
    expect(w.verify(verifyQuery("nope")).status).toBe(403);
  });
  it("accepts an event signed with the app secret", async () => {
    const w = createWhatsAppIntegration(ENV, { store: store() });
    const now = Math.floor(Date.now() / 1000);
    const signed = sign("wiring-secret-1", inboundPayload({ phoneNumberId: AR.phoneNumberId }, { from: "5491155500101", name: "María", wamid: "wamid.W1", ts: now, text: "hola" }));
    const r = await w.receive(signed.rawBody, signed.headers);
    expect(r.status).toBe(200);
  });
  it("refuses an event signed with some other secret", async () => {
    const w = createWhatsAppIntegration(ENV, { store: store() });
    const signed = sign("not-the-secret", statusPayload({ phoneNumberId: AR.phoneNumberId }, []));
    expect((await w.receive(signed.rawBody, signed.headers)).status).toBe(403);
  });
  it("accepts the previous secret while the app secret is being rotated, and not afterwards", async () => {
    const rotating = createWhatsAppIntegration({ ...ENV, WHATSAPP_APP_SECRET: "new-secret", WHATSAPP_APP_SECRET_PREVIOUS: "old-secret" }, { store: store() });
    const done = createWhatsAppIntegration({ ...ENV, WHATSAPP_APP_SECRET: "new-secret" }, { store: store() });
    const old = sign("old-secret", statusPayload({ phoneNumberId: AR.phoneNumberId }, []));
    expect((await rotating.receive(old.rawBody, old.headers)).status).toBe(200);
    expect((await done.receive(old.rawBody, old.headers)).status).toBe(403);
  });
});

describe("sender built from the environment", () => {
  function fakeGraph() {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = url.endsWith("/media")
        ? { id: "MEDIA1" }
        : { messaging_product: "whatsapp", contacts: [{ input: "+5491155500101", wa_id: "5491155500101" }], messages: [{ id: "wamid.SENT1" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { urls, fetchFn };
  }
  const input = {
    tenantId: AR.tenantId,
    documentId: "doc-1",
    docType: "budget" as const,
    to: "011 15 5550-0101",
    document: { kind: "bytes" as const, bytes: makePdf("Presupuesto", ["linea"]), filename: "presupuesto.pdf" },
    recipientName: "María",
    documentNumber: "P-1",
    mode: "template" as const,
  };

  it("uses graph.facebook.com and v26.0 unless told otherwise (against a fake fetch: nothing leaves the machine)", async () => {
    const { urls, fetchFn } = fakeGraph();
    const w = createWhatsAppIntegration(ENV, { store: store(), fetch: fetchFn });
    const r = await w.sender.sendDocument(input);
    expect(r.outcome).toBe("sent");
    expect(urls).toEqual([`https://graph.facebook.com/v26.0/${AR.phoneNumberId}/media`, `https://graph.facebook.com/v26.0/${AR.phoneNumberId}/messages`]);
  });
  it("takes the Graph version and base URL from the environment", async () => {
    const { urls, fetchFn } = fakeGraph();
    const w = createWhatsAppIntegration({ ...ENV, WHATSAPP_GRAPH_VERSION: "v99.0", WHATSAPP_GRAPH_BASE_URL: "http://127.0.0.1:4751/" }, { store: store(), fetch: fetchFn });
    await w.sender.sendDocument(input);
    expect(urls[0]).toBe(`http://127.0.0.1:4751/v99.0/${AR.phoneNumberId}/media`);
  });
});
