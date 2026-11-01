// End to end over real HTTP on ports 4750-4769: the kit's server, the mock Graph API, and signed webhooks between them.
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, closeServer, listenInRange, type App, type AppConfig } from "../src/server.ts";
import { WhatsAppSender } from "../src/sender.ts";
import { inboundPayload, sign, statusPayload, verifyQuery } from "../testing/fixtures.ts";
import { APP_SECRET, AR, DOC, ES, OTHER_SECRET, VERIFY_TOKEN, makeWorld, type World } from "../testing/harness.ts";

interface Kit {
  w: World;
  app: App;
  base: string;
  port: number;
}

const kits: Kit[] = [];
const extraServers: http.Server[] = [];

async function startKit(config: Partial<AppConfig> = {}): Promise<Kit> {
  const w = makeWorld({ connect: false });
  await w.mock.listen();
  const sender = new WhatsAppSender({ store: w.store, baseUrl: w.mock.baseUrl, sleep: async () => undefined, random: () => 0.5, requestTimeoutMs: 3000 });
  const app = createApp({ store: w.store, documents: w.documents, sender, secrets: [{ secret: APP_SECRET }], verifyToken: VERIFY_TOKEN, ...config });
  const port = await listenInRange(app.server);
  const base = `http://127.0.0.1:${port}`;
  w.mock.connectWebhook(APP_SECRET, (req) => fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { ...req.headers, connection: "close" }, body: req.rawBody }));
  const kit = { w, app, base, port };
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const k of kits.splice(0)) {
    await closeServer(k.app.server);
    await k.w.mock.close();
    k.w.close();
  }
  for (const s of extraServers.splice(0)) await closeServer(s);
});

async function call(kit: Kit, path: string, init: RequestInit = {}) {
  // "connection: close" because the next test may start another server on this same port
  const res = await fetch(kit.base + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), connection: "close" } });
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, raw, json };
}
const sendDoc = (kit: Kit, docId: string = DOC.arBudget, body: unknown = {}, tenant: string = AR.tenantId) =>
  call(kit, `/t/${tenant}/documents/${docId}/send-whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const arEnv = { phoneNumberId: AR.phoneNumberId, displayPhone: AR.display, wabaId: AR.wabaId };

describe("basics", () => {
  it("answers /health and uses only a port from 4750-4769", async () => {
    const kit = await startKit();
    expect(kit.port).toBeGreaterThanOrEqual(4750);
    expect(kit.port).toBeLessThanOrEqual(4769);
    const r = await call(kit, "/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it("sets no-store and nosniff headers", async () => {
    const kit = await startKit();
    const r = await call(kit, "/health");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 for unknown routes and 405 with Allow for wrong methods", async () => {
    const kit = await startKit();
    expect((await call(kit, "/nope")).status).toBe(404);
    expect((await call(kit, "/t/taller-ar")).status).toBe(404);
    const post = await call(kit, "/health", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const put = await call(kit, "/webhooks/whatsapp", { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
    expect((await call(kit, `/t/${AR.tenantId}/documents`, { method: "POST" })).status).toBe(405);
    expect((await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}/send-whatsapp`)).headers.get("allow")).toBe("POST");
  });

  it("answers 400 to a path that cannot be decoded", async () => {
    const kit = await startKit();
    const r = await call(kit, "/t/%E0%A4%A/documents");
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "bad_path" });
  });
});

describe("webhook endpoint", () => {
  it("answers the verification challenge as plain text", async () => {
    const kit = await startKit();
    const r = await call(kit, `/webhooks/whatsapp?${verifyQuery(VERIFY_TOKEN, "1158201444")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(r.raw).toBe("1158201444");
  });

  it("rejects a wrong verify token", async () => {
    const kit = await startKit();
    expect((await call(kit, `/webhooks/whatsapp?${verifyQuery("wrong")}`)).status).toBe(403);
    expect((await call(kit, "/webhooks/whatsapp")).status).toBe(400);
  });

  it("rejects unsigned, mis-signed and tampered events and accepts a signed one", async () => {
    const kit = await startKit();
    const payload = statusPayload(arEnv, [{ wamid: "wamid.X", status: "sent", ts: kit.w.clock.sec }]);
    const signed = sign(APP_SECRET, payload);
    const post = (headers: Record<string, string>, body: Buffer = signed.rawBody) => call(kit, "/webhooks/whatsapp", { method: "POST", headers, body });
    expect((await post({ "content-type": "application/json" })).status).toBe(401);
    expect((await post(sign(OTHER_SECRET, payload).headers)).status).toBe(403);
    expect((await post(signed.headers, Buffer.from(signed.rawBody.toString().replace("sent", "read")))).status).toBe(403);
    const ok = await post(signed.headers);
    expect(ok.status).toBe(200);
    expect(ok.json.received).toBe(true);
    expect(ok.json.counts.statuses).toBe(1);
  });

  it("refuses a body over the limit with 413 and accepts one exactly at the limit", async () => {
    const kit = await startKit({ maxBodyBytes: 1000 });
    const over = await call(kit, "/webhooks/whatsapp", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1001) });
    expect(over.status).toBe(413);
    expect(over.json).toEqual({ error: "payload_too_large" });
    const exact = await call(kit, "/webhooks/whatsapp", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1000) });
    expect(exact.status).toBe(401); // read in full, then rejected for having no signature
  });

  it("still works after refusing an oversized body", async () => {
    const kit = await startKit({ maxBodyBytes: 1000 });
    await call(kit, "/webhooks/whatsapp", { method: "POST", body: "x".repeat(5000) });
    expect((await call(kit, "/health")).status).toBe(200);
  });
});

describe("Send by WhatsApp, end to end", () => {
  it("sends the template, then shows sent, delivered and read in the document's history", async () => {
    const kit = await startKit();
    kit.w.mock.autoStatus = { sequence: ["sent", "delivered", "read"] };
    const sent = await sendDoc(kit);
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ outcome: "sent", status: "accepted", error: null, phoneError: null });
    expect(sent.json.message.es).toContain("Enviado a WhatsApp");
    await kit.w.mock.flush();
    const doc = await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}`);
    expect(doc.status).toBe(200);
    expect(doc.json.document.number).toBe("P-2026-0042");
    expect(doc.json.document.totalCents).toBe(23300000);
    expect(doc.json.whatsapp).toHaveLength(1);
    expect(doc.json.whatsapp[0]).toMatchObject({ recipient: "+5491155500101", how: "template", status: "read", statusText: "Leído" });
  });

  it("answers a second click with duplicate and sends nothing", async () => {
    const kit = await startKit();
    await sendDoc(kit);
    const again = await sendDoc(kit);
    expect(again.status).toBe(200);
    expect(again.json.outcome).toBe("duplicate");
    expect(kit.w.mock.messages).toHaveLength(1);
  });

  it("sends once when five clicks arrive together", async () => {
    const kit = await startKit();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => sendDoc(kit)));
    expect(results.filter((r) => r.json.outcome === "sent")).toHaveLength(1);
    expect(kit.w.mock.messages).toHaveLength(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
  });

  it("can resend deliberately", async () => {
    const kit = await startKit();
    await sendDoc(kit);
    const again = await sendDoc(kit, DOC.arBudget, { resend: true });
    expect(again.json.outcome).toBe("sent");
    expect(kit.w.mock.messages).toHaveLength(2);
  });

  it("uses the other tenant's credentials for its documents", async () => {
    const kit = await startKit();
    const r = await sendDoc(kit, "doc-es-invoice-1", {}, ES.tenantId);
    expect(r.json.outcome).toBe("sent");
    expect(kit.w.mock.requests.every((q) => q.phoneNumberId === ES.phoneNumberId && q.authorization === `Bearer ${ES.token}`)).toBe(true);
  });

  it("maps outcomes to HTTP statuses with plain-language messages", async () => {
    const kit = await startKit();
    const invalid = await sendDoc(kit, DOC.arBudget, { to: "12345" });
    expect(invalid.status).toBe(422);
    expect(invalid.json.outcome).toBe("invalid_number");
    expect(invalid.json.phoneError.code).toBe("too_short");
    expect(invalid.json.message.es).toContain("demasiado corto");

    kit.w.mock.notOnWhatsApp.add("5491155500101");
    const failed = await sendDoc(kit);
    expect(failed.status).toBe(502);
    expect(failed.json.outcome).toBe("failed");
    expect(failed.json.error).toMatchObject({ code: 131026, key: "undeliverable" });

    const window = await sendDoc(kit, DOC.arInvoice, { mode: "freeform" });
    expect(window.status).toBe(409);
    expect(window.json.outcome).toBe("outside_window");
  });

  it("blocks a customer who sent BAJA, and confirms the opt-out", async () => {
    const kit = await startKit();
    await kit.w.mock.emitInbound(AR.phoneNumberId, "5491155500101", "BAJA");
    await kit.app.whenIdle();
    expect(kit.w.mock.messages).toHaveLength(1);
    expect(kit.w.mock.messages[0]!.type).toBe("text");
    const r = await sendDoc(kit);
    expect(r.status).toBe(422);
    expect(r.json.outcome).toBe("blocked_opt_out");
  });

  it("sends the free-form document inside the window", async () => {
    const kit = await startKit();
    const res = await call(kit, "/webhooks/whatsapp", {
      method: "POST",
      ...(() => {
        kit.w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
        const s = sign(APP_SECRET, inboundPayload(arEnv, { from: "5491155500101", wamid: "wamid.IN1", ts: kit.w.clock.sec, text: "hola" }));
        return { headers: s.headers, body: s.rawBody };
      })(),
    });
    expect(res.status).toBe(200);
    await kit.app.whenIdle();
    const r = await sendDoc(kit);
    expect(r.json.outcome).toBe("sent");
    expect(kit.w.mock.messages[0]!.type).toBe("document");
  });

  it("answers 404 for unknown tenants and documents, 400 for bad input", async () => {
    const kit = await startKit();
    expect((await sendDoc(kit, DOC.arBudget, {}, "nope")).json).toEqual({ error: "unknown_tenant" });
    expect((await sendDoc(kit, "nope")).json).toEqual({ error: "unknown_document" });
    expect((await sendDoc(kit, "doc-es-budget-1")).status).toBe(404); // another tenant's document
    const badJson = await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}/send-whatsapp`, { method: "POST", body: "{nope" });
    expect(badJson).toMatchObject({ status: 400, json: { error: "invalid_json" } });
    expect((await sendDoc(kit, DOC.arBudget, [1])).json).toEqual({ error: "invalid_json" });
    expect((await sendDoc(kit, DOC.arBudget, { mode: "bulk" })).json).toEqual({ error: "invalid_mode" });
    expect((await sendDoc(kit, DOC.arBudget, { to: 123 })).json).toEqual({ error: "invalid_to" });
    expect(kit.w.mock.requests).toHaveLength(0);
  });

  it("refuses an oversized send request body", async () => {
    const kit = await startKit();
    const r = await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}/send-whatsapp`, { method: "POST", body: JSON.stringify({ to: "1".repeat(70_000) }) });
    expect(r.status).toBe(413);
  });

  it("does not leak internals when something breaks", async () => {
    const kit = await startKit();
    kit.w.store.db.exec("DROP TABLE sends");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let r: Awaited<ReturnType<typeof sendDoc>>;
    try {
      r = await sendDoc(kit);
    } finally {
      spy.mockRestore();
    }
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "internal_error" });
    expect(r.raw).not.toContain("sends");
    // the detail goes to the server log, not to the client
    expect(logged.join("")).toContain("no such table: sends");
  });
});

describe("document views", () => {
  it("lists a tenant's documents as JSON with their WhatsApp history", async () => {
    const kit = await startKit();
    await sendDoc(kit);
    const r = await call(kit, `/t/${AR.tenantId}/documents`);
    expect(r.status).toBe(200);
    expect(r.json.documents).toHaveLength(3);
    const budget = r.json.documents.find((d: any) => d.id === DOC.arBudget);
    expect(budget.whatsapp).toHaveLength(1);
    expect(r.json.documents.find((d: any) => d.id === DOC.arInvoice).whatsapp).toEqual([]);
  });

  it("serves HTML on request and escapes it", async () => {
    const kit = await startKit();
    const byQuery = await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}?format=html`);
    expect(byQuery.headers.get("content-type")).toContain("text/html");
    expect(byQuery.raw).toContain("Enviar por WhatsApp");
    expect(byQuery.raw).toContain("Presupuesto P-2026-0042".replace("Presupuesto", "presupuesto"));
    const byAccept = await call(kit, `/t/${AR.tenantId}/documents`, { headers: { accept: "text/html" } });
    expect(byAccept.headers.get("content-type")).toContain("text/html");
    const json = await call(kit, `/t/${AR.tenantId}/documents/${DOC.arBudget}?format=json`, { headers: { accept: "text/html" } });
    expect(json.headers.get("content-type")).toContain("application/json");
  });

  it("serves the PDF", async () => {
    const kit = await startKit();
    const res = await fetch(`${kit.base}/t/${AR.tenantId}/documents/${DOC.arBudget}/pdf`, { headers: { connection: "close" } });
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("presupuesto-P-2026-0042.pdf");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("does not show one tenant another tenant's documents", async () => {
    const kit = await startKit();
    expect((await call(kit, `/t/${ES.tenantId}/documents/${DOC.arBudget}`)).status).toBe(404);
    expect((await call(kit, `/t/${ES.tenantId}/documents`)).json.documents.map((d: any) => d.id)).not.toContain(DOC.arBudget);
  });
});

describe("listenInRange", () => {
  it("never leaves the range 4750-4769", async () => {
    const s = http.createServer();
    for (const [from, to] of [[4749, 4760], [4750, 4770], [3307, 3307], [4600, 4700], [4760, 4750], [4750.5, 4751], [5432, 5432]] as const) {
      await expect(listenInRange(s, "127.0.0.1", from, to), `${from}-${to}`).rejects.toThrow(RangeError);
    }
    expect(s.listening).toBe(false);
  });

  it("takes the next free port when one is busy and fails when none is free", async () => {
    const first = http.createServer();
    extraServers.push(first);
    const p1 = await listenInRange(first);
    const second = http.createServer();
    extraServers.push(second);
    await expect(listenInRange(second, "127.0.0.1", p1, p1)).rejects.toThrow("no free port");
    if (p1 < 4769) {
      const p2 = await listenInRange(second, "127.0.0.1", p1, 4769);
      expect(p2).toBeGreaterThan(p1);
      expect(p2).toBeLessThanOrEqual(4769);
    }
  });

  it("closeServer is safe on a server that is not listening", async () => {
    await closeServer(http.createServer());
  });
});
