// Tests of the mock itself. They pin down the rules the other tests rely on, and they are the honest statement of what
// "the mock follows the docs" means: these are the kit's reading of Meta's pages, not Meta's behaviour.
import { afterEach, describe, expect, it } from "vitest";
import { MockGraph, waIdTransforms } from "../testing/mock-graph.ts";
import { APP_SECRET, AR, makeWorld, type World } from "../testing/harness.ts";
import { makePdf } from "../src/pdf.ts";

const worlds: World[] = [];
function make(): World {
  const w = makeWorld({ connect: false });
  worlds.push(w);
  return w;
}
const mocks: MockGraph[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) w.close();
  for (const m of mocks.splice(0)) await m.close();
});

const URL_MSG = `https://graph.facebook.com/v26.0/${AR.phoneNumberId}/messages`;
const URL_MEDIA = `https://graph.facebook.com/v26.0/${AR.phoneNumberId}/media`;
const auth = { authorization: `Bearer ${AR.token}`, "content-type": "application/json" };

const post = (w: World, body: unknown, headers: Record<string, string> = auth, url = URL_MSG) => w.mock.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: number; type: string; message: string; error_data: { details: string; messaging_product: string }; fbtrace_id: string } }).error;

const text = (to: string, extra: Record<string, unknown> = {}) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: "hola" }, ...extra });

async function upload(w: World, name = "a.pdf", type = "application/pdf", bytes: Uint8Array = makePdf("x", ["y"]), extra: Record<string, string> = { messaging_product: "whatsapp" }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.set("type", type);
  form.set("file", new Blob([Uint8Array.from(bytes)], { type }), name);
  return w.mock.fetch(URL_MEDIA, { method: "POST", headers: { authorization: auth.authorization }, body: form });
}

describe("authentication and routing", () => {
  it("rejects a missing token with code 0", async () => {
    const w = make();
    const res = await post(w, text("5491155500101"), { "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe(0);
  });

  it("rejects another tenant's token with code 190", async () => {
    const w = make();
    const res = await post(w, text("5491155500101"), { authorization: "Bearer fake-token-estudio-es", "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe(190);
  });

  it("rejects an unknown phone number id", async () => {
    const w = make();
    const res = await post(w, text("5491155500101"), auth, "https://graph.facebook.com/v26.0/123456789012345/messages");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe(100);
  });

  it("answers errors in the documented shape", async () => {
    const w = make();
    const e = await errorOf(await post(w, text("5491155500101")));
    expect(e.code).toBe(131047);
    expect(e.message).toContain("131047");
    expect(e.error_data.messaging_product).toBe("whatsapp");
    expect(e.error_data.details).toBeTruthy();
    expect(e.fbtrace_id).toMatch(/^MOCK/);
  });

  it("only knows POST on messages and media", async () => {
    const w = make();
    expect((await w.mock.fetch(URL_MSG, { method: "GET", headers: auth })).status).toBe(400);
    expect((await w.mock.fetch("https://graph.facebook.com/v26.0/me", { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
  });
});

describe("message validation", () => {
  it("requires messaging_product whatsapp", async () => {
    const w = make();
    const res = await post(w, { ...text("5491155500101"), messaging_product: "other" });
    expect((await errorOf(res)).code).toBe(100);
  });

  it("rejects a body that is not JSON", async () => {
    const w = make();
    const res = await w.mock.fetch(URL_MSG, { method: "POST", headers: auth, body: "{nope" });
    expect((await errorOf(res)).code).toBe(100);
  });

  it("requires a recipient", async () => {
    const w = make();
    const { to: _to, ...noTo } = text("1");
    expect((await errorOf(await post(w, noTo))).code).toBe(131008);
  });

  it("rejects numbers that are not 7 to 15 digits", async () => {
    const w = make();
    for (const to of ["abc", "12345", "1".repeat(16)]) expect((await errorOf(await post(w, text(to)))).code, to).toBe(131009);
  });

  it("accepts the separators the docs allow", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    const res = await post(w, text("+54 (9) 11-5550 0101"));
    expect(res.status).toBe(200);
  });

  it("rejects an unsupported message type", async () => {
    const w = make();
    expect((await errorOf(await post(w, { ...text("5491155500101"), type: "location" }))).code).toBe(131051);
  });

  it("rejects the business's own number as recipient", async () => {
    const w = make();
    expect((await errorOf(await post(w, text(AR.display)))).code).toBe(131021);
  });

  it("requires text.body and document.id or link", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    expect((await errorOf(await post(w, { ...text("5491155500101"), text: {} }))).code).toBe(131008);
    expect((await errorOf(await post(w, { ...text("5491155500101"), type: "document", document: {} }))).code).toBe(131008);
  });

  it("rejects a document id that was never uploaded", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    const res = await post(w, { ...text("5491155500101"), type: "document", document: { id: "111", filename: "a.pdf" } });
    expect((await errorOf(res)).code).toBe(131009);
  });

  it("returns the documented success shape", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    const res = await post(w, text("+5491155500101"));
    expect(await res.json()).toEqual({
      messaging_product: "whatsapp",
      contacts: [{ input: "+5491155500101", wa_id: "5491155500101" }],
      messages: [{ id: w.mock.messages[0]!.wamid }],
    });
    expect(w.mock.messages[0]!.wamid).toMatch(/^wamid\./);
  });
});

describe("templates", () => {
  const tpl = (name: string, language: string, components: unknown[] = []) => ({ messaging_product: "whatsapp", to: "5491155500101", type: "template", template: { name, language: { code: language }, components } });
  const body3 = { type: "body", parameters: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }] };

  it("rejects an unknown template or a language that was not created", async () => {
    const w = make();
    expect((await errorOf(await post(w, tpl("nope", "es")))).code).toBe(132001);
    expect((await errorOf(await post(w, tpl("presupuesto_adjunto", "es_AR")))).code).toBe(132001);
  });

  it("rejects templates that are not approved, paused or disabled", async () => {
    const w = make();
    w.mock.addTemplate(AR.wabaId, { name: "pending_one", language: "es", status: "PENDING" });
    w.mock.addTemplate(AR.wabaId, { name: "paused_one", language: "es", status: "PAUSED" });
    w.mock.addTemplate(AR.wabaId, { name: "disabled_one", language: "es", status: "DISABLED" });
    expect((await errorOf(await post(w, tpl("pending_one", "es")))).code).toBe(132001);
    expect((await errorOf(await post(w, tpl("paused_one", "es")))).code).toBe(132015);
    expect((await errorOf(await post(w, tpl("disabled_one", "es")))).code).toBe(132016);
  });

  it("checks the number of body parameters and the document header", async () => {
    const w = make();
    const header = { type: "header", parameters: [{ type: "document", document: { link: "https://example.com/a.pdf" } }] };
    expect((await errorOf(await post(w, tpl("presupuesto_adjunto", "es", [header])))).code).toBe(132000);
    expect((await errorOf(await post(w, tpl("presupuesto_adjunto", "es", [body3])))).code).toBe(132000);
    const ok = await post(w, tpl("presupuesto_adjunto", "es", [header, body3]));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { messages: Array<{ message_status?: string }> }).messages[0]!.message_status).toBe("accepted");
  });

  it("is not subject to the 24-hour window", async () => {
    const w = make();
    const header = { type: "header", parameters: [{ type: "document", document: { link: "https://example.com/a.pdf" } }] };
    expect((await post(w, tpl("presupuesto_adjunto", "es", [header, body3]))).status).toBe(200);
  });
});

describe("the 24-hour window", () => {
  it("allows free-form messages for 24 hours after the user wrote", async () => {
    const w = make();
    expect((await post(w, text("5491155500101"))).status).toBe(400);
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    expect((await post(w, text("5491155500101"))).status).toBe(200);
    w.clock.advance(24 * 3600 - 1);
    expect((await post(w, text("5491155500101"))).status).toBe(200);
    w.clock.advance(1);
    expect((await errorOf(await post(w, text("5491155500101")))).code).toBe(131047);
  });

  it("is per number", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    expect((await errorOf(await post(w, text("5491155500102")))).code).toBe(131047);
  });
});

describe("media uploads", () => {
  it("stores the file and answers with an id", async () => {
    const w = make();
    const res = await upload(w);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(w.mock.uploads[0]).toMatchObject({ id, filename: "a.pdf", mime: "application/pdf" });
    expect(w.mock.uploads[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a missing messaging_product, type or file", async () => {
    const w = make();
    expect((await errorOf(await upload(w, "a.pdf", "application/pdf", makePdf("x", []), {}))).code).toBe(100);
    const noFile = new FormData();
    noFile.set("messaging_product", "whatsapp");
    noFile.set("type", "application/pdf");
    expect((await errorOf(await w.mock.fetch(URL_MEDIA, { method: "POST", headers: { authorization: auth.authorization }, body: noFile }))).code).toBe(131008);
    const noType = new FormData();
    noType.set("messaging_product", "whatsapp");
    noType.set("file", new Blob(["x"], { type: "application/pdf" }), "a.pdf");
    expect((await errorOf(await w.mock.fetch(URL_MEDIA, { method: "POST", headers: { authorization: auth.authorization }, body: noType }))).code).toBe(131008);
  });

  it("rejects an unsupported type, a name that does not match the type, and an empty file", async () => {
    const w = make();
    expect((await errorOf(await upload(w, "a.exe", "application/x-msdownload"))).code).toBe(131053);
    expect((await errorOf(await upload(w, "a.png", "application/pdf"))).code).toBe(131053);
    expect((await errorOf(await upload(w, "a.pdf", "application/pdf", new Uint8Array(0)))).code).toBe(131053);
  });

  it("rejects a file over the size limit", async () => {
    const w = make();
    w.mock.maxDocumentBytes = 10;
    expect((await errorOf(await upload(w, "a.pdf", "application/pdf", Buffer.from("%PDF-1.4 more than ten bytes")))).code).toBe(131053);
  });

  it("lets a message use an uploaded id only for the same phone number, and not after it expired", async () => {
    const w = make();
    const { id } = (await (await upload(w)).json()) as { id: string };
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    const doc = { ...text("5491155500101"), type: "document", document: { id, filename: "a.pdf" } };
    expect((await post(w, doc)).status).toBe(200);
    w.mock.expireMedia(id);
    expect((await errorOf(await post(w, doc))).code).toBe(131009);
  });
});

describe("scripted failures", () => {
  it("fails the next N matching requests and then recovers", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    w.mock.failNext({ status: 503, code: 131016 }, 2, "messages");
    expect((await post(w, text("5491155500101"))).status).toBe(503);
    expect((await post(w, text("5491155500101"))).status).toBe(503);
    expect((await post(w, text("5491155500101"))).status).toBe(200);
  });

  it("applies a failure only to the targeted endpoint", async () => {
    const w = make();
    w.mock.failNext({ status: 500, code: 131000 }, 1, "media");
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    expect((await post(w, text("5491155500101"))).status).toBe(200);
    expect((await upload(w)).status).toBe(500);
  });

  it("sends a Retry-After header with a rate limit", async () => {
    const w = make();
    w.mock.rateLimitNext(1, 7);
    const res = await post(w, text("5491155500101"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect((await errorOf(res)).code).toBe(130429);
  });

  it("can answer with an unreadable body", async () => {
    const w = make();
    w.mock.failNext({ status: 502, raw: "<html>Bad Gateway</html>" });
    const res = await post(w, text("5491155500101"));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Bad Gateway");
  });

  it("creates the message and then fails the answer with failAfterAccept", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    w.mock.failAfterAccept(1);
    expect((await post(w, text("5491155500101"))).status).toBe(500);
    expect(w.mock.messages).toHaveLength(1);
  });

  it("drops the connection as a network error", async () => {
    const w = make();
    w.mock.dropNext(1);
    await expect(post(w, text("5491155500101"))).rejects.toThrow(TypeError);
  });

  it("hangs until the caller gives up", async () => {
    const w = make();
    w.mock.hangNext(1);
    await expect(w.mock.fetch(URL_MSG, { method: "POST", headers: auth, body: "{}", signal: AbortSignal.timeout(30) })).rejects.toThrow();
  });

  it("can be slowed down", async () => {
    const w = make();
    w.mock.latencyMs = 40;
    const t0 = Date.now();
    await post(w, text("5491155500101"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it("records every request with its target and status", async () => {
    const w = make();
    await post(w, text("5491155500101"));
    expect(w.mock.requests).toHaveLength(1);
    expect(w.mock.requests[0]).toMatchObject({ method: "POST", target: "messages", phoneNumberId: AR.phoneNumberId, status: 400, authorization: auth.authorization });
  });
});

describe("wa_id rewriting", () => {
  it("can report an Argentine number without the 9", async () => {
    const w = make();
    w.mock.waIdTransform = waIdTransforms.argentinaDropNine;
    w.mock.userMessaged(AR.phoneNumberId, "541155500101");
    const res = await post(w, text("+5491155500101"));
    const json = (await res.json()) as { contacts: Array<{ input: string; wa_id: string }> };
    expect(json.contacts[0]).toEqual({ input: "+5491155500101", wa_id: "541155500101" });
  });

  it("can report a Mexican number without the 1", () => {
    expect(waIdTransforms.mexicoDropOne("5215555500104")).toBe("525555500104");
    expect(waIdTransforms.mexicoDropOne("525555500104")).toBe("525555500104");
    expect(waIdTransforms.identity("123")).toBe("123");
    expect(waIdTransforms.argentinaDropNine("5493515550102")).toBe("543515550102");
  });
});

describe("webhooks from the mock", () => {
  it("signs what it delivers with the connected app secret", async () => {
    const w = make();
    const got: Array<{ rawBody: Buffer; headers: Record<string, string> }> = [];
    w.mock.connectWebhook(APP_SECRET, async (req) => {
      got.push(req);
    });
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    await post(w, text("5491155500101", { biz_opaque_callback_data: "ws_ref1" }));
    await w.mock.emitStatus(w.mock.messages[0]!.wamid, "delivered");
    expect(got).toHaveLength(1);
    expect(got[0]!.headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const payload = JSON.parse(got[0]!.rawBody.toString("utf8")) as { entry: Array<{ changes: Array<{ value: { statuses: Array<Record<string, unknown>>; metadata: Record<string, string> } }> }> };
    const value = payload.entry[0]!.changes[0]!.value;
    expect(value.metadata["phone_number_id"]).toBe(AR.phoneNumberId);
    expect(value.statuses[0]).toMatchObject({ status: "delivered", recipient_id: "5491155500101", biz_opaque_callback_data: "ws_ref1" });
  });

  it("refuses to emit for a message it never created, or without a webhook", async () => {
    const w = make();
    await expect(w.mock.emitStatus("wamid.nope", "sent")).rejects.toThrow("unknown message");
    await expect(w.mock.deliver({})).rejects.toThrow("no webhook");
  });

  it("resets its state", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, "5491155500101");
    await post(w, text("5491155500101"));
    w.mock.reset();
    expect(w.mock.messages).toHaveLength(0);
    expect(w.mock.requests).toHaveLength(0);
    expect(w.mock.windowOpen(AR.phoneNumberId, "5491155500101")).toBe(false);
  });
});

describe("over HTTP", () => {
  it("listens inside 4750-4769 and answers the same way", async () => {
    const mock = new MockGraph();
    mocks.push(mock);
    mock.addNumber({ phoneNumberId: AR.phoneNumberId, token: AR.token });
    const port = await mock.listen();
    expect(port).toBeGreaterThanOrEqual(4750);
    expect(port).toBeLessThanOrEqual(4769);
    expect(mock.baseUrl).toBe(`http://127.0.0.1:${port}`);
    const res = await fetch(`${mock.baseUrl}/v26.0/${AR.phoneNumberId}/messages`, { method: "POST", headers: auth, body: JSON.stringify(text("5491155500101")) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(131047);
  });

  it("handles a multipart upload and a dropped connection", async () => {
    const mock = new MockGraph();
    mocks.push(mock);
    mock.addNumber({ phoneNumberId: AR.phoneNumberId, token: AR.token });
    await mock.listen();
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", "application/pdf");
    form.set("file", new Blob([Uint8Array.from(makePdf("x", []))], { type: "application/pdf" }), "a.pdf");
    const ok = await fetch(`${mock.baseUrl}/v26.0/${AR.phoneNumberId}/media`, { method: "POST", headers: { authorization: auth.authorization }, body: form });
    expect(ok.status).toBe(200);
    expect(mock.uploads).toHaveLength(1);
    mock.dropNext(1);
    await expect(fetch(`${mock.baseUrl}/v26.0/${AR.phoneNumberId}/messages`, { method: "POST", headers: auth, body: "{}" })).rejects.toThrow();
  });
});
