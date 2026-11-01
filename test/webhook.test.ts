import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_EVENT_AGE_SECONDS, MAX_WEBHOOK_BYTES, handleEvent, handleVerification, type WebhookResponse } from "../src/webhook.ts";
import { inboundPayload, sign, statusPayload, verifyQuery, type StatusInput } from "../testing/fixtures.ts";
import { APP_SECRET, AR, DOC, ES, OTHER_SECRET, VERIFY_TOKEN, makeWorld, type World, type WorldOptions } from "../testing/harness.ts";
import { computeSignature } from "../src/signature.ts";
import { FREEFORM } from "../src/templates.ts";

const worlds: World[] = [];
function make(options?: WorldOptions): World {
  const w = makeWorld(options);
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

const MARIA = "5491155500101";
const arEnv = { phoneNumberId: AR.phoneNumberId, displayPhone: AR.display, wabaId: AR.wabaId };
const esEnv = { phoneNumberId: ES.phoneNumberId, displayPhone: ES.display, wabaId: ES.wabaId };

async function sendBudget(w: World) {
  const r = await w.documents.sendByWhatsApp(w.sender, AR.tenantId, DOC.arBudget);
  if ("notFound" in r) throw new Error("not found");
  return r;
}
const status = (wamid: string, s: StatusInput["status"], ts: number, extra: Partial<StatusInput> = {}): StatusInput => ({ wamid, status: s, ts, recipientId: MARIA, ...extra });
const body = (res: WebhookResponse) => res.body as { received?: boolean; counts?: Record<string, number>; error?: string; reason?: string; ignored?: string };

describe("GET verification", () => {
  const config = { verifyToken: VERIFY_TOKEN };

  it("echoes the challenge as plain text when the token matches", () => {
    const r = handleVerification(verifyQuery(VERIFY_TOKEN, "1158201444"), config);
    expect(r).toEqual({ status: 200, contentType: "text/plain", body: "1158201444" });
  });

  it("echoes any challenge string verbatim", () => {
    expect(handleVerification(verifyQuery(VERIFY_TOKEN, "abc-DEF_9"), config).body).toBe("abc-DEF_9");
  });

  it("rejects a wrong token with 403", () => {
    expect(handleVerification(verifyQuery("wrong"), config).status).toBe(403);
    expect(handleVerification(verifyQuery(""), config).status).toBe(403);
  });

  it("rejects a request that is not a subscribe request or lacks fields", () => {
    expect(handleVerification(new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" }), config).status).toBe(400);
    expect(handleVerification(new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "1" }), config).status).toBe(400);
    expect(handleVerification(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN }), config).status).toBe(400);
    expect(handleVerification(new URLSearchParams(), config).status).toBe(400);
  });

  it("accepts any of several configured tokens", () => {
    const many = { verifyToken: ["token-a", "token-b"] };
    expect(handleVerification(verifyQuery("token-b"), many).status).toBe(200);
    expect(handleVerification(verifyQuery("token-c"), many).status).toBe(403);
  });
});

describe("POST signature", () => {
  it("accepts a correctly signed event", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const res = await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec)]));
    expect(res.status).toBe(200);
    expect(body(res).received).toBe(true);
    expect(body(res).counts!["statuses"]).toBe(1);
    expect(w.store.getSend(sent.send!.id)!.status).toBe("delivered");
  });

  it("rejects an unsigned request with 401 and changes nothing", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const payload = JSON.stringify(statusPayload(arEnv, [status(sent.send!.wamid!, "read", w.clock.sec)]));
    const res = await w.postRaw({ rawBody: Buffer.from(payload), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
    expect(body(res)).toMatchObject({ error: "invalid_signature", reason: "missing_header" });
    expect(w.store.getSend(sent.send!.id)!.status).toBe("accepted");
    expect(w.store.countEvents()).toBe(0);
  });

  it("rejects a malformed signature header with 401", async () => {
    const w = make();
    const raw = Buffer.from(JSON.stringify(statusPayload(arEnv, [])));
    const res = await w.postRaw({ rawBody: raw, headers: { "x-hub-signature-256": "sha1=abcdef" } });
    expect(res.status).toBe(401);
    expect(body(res).reason).toBe("malformed_header");
  });

  it("rejects a wrong signature with 403", async () => {
    const w = make();
    const res = await w.post(statusPayload(arEnv, []), OTHER_SECRET);
    expect(res.status).toBe(403);
    expect(body(res).reason).toBe("mismatch");
  });

  it("rejects a tampered body with 403 and changes nothing", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const signed = sign(APP_SECRET, statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec)]));
    const tampered = Buffer.from(signed.rawBody.toString("utf8").replace('"delivered"', '"read"      '));
    const res = await w.postRaw({ rawBody: tampered, headers: signed.headers });
    expect(res.status).toBe(403);
    expect(w.store.getSend(sent.send!.id)!.status).toBe("accepted");
  });

  it("verifies the exact bytes, so pretty-printed JSON signed as sent is accepted", async () => {
    const w = make();
    const res = await w.postRaw(sign(APP_SECRET, statusPayload(arEnv, []), { pretty: true }));
    expect(res.status).toBe(200);
  });

  it("reads the header name case-insensitively and takes the first of repeated headers", async () => {
    const w = make();
    const signed = sign(APP_SECRET, statusPayload(arEnv, []));
    const sig = signed.headers["x-hub-signature-256"]!;
    expect((await w.postRaw({ rawBody: signed.rawBody, headers: { "X-Hub-Signature-256": sig } })).status).toBe(200);
    expect((await handleEvent({ rawBody: signed.rawBody, headers: { "x-hub-signature-256": [sig, "sha256=00"] } }, w.webhook)).status).toBe(200);
  });

  it("rejects everything when no secret is configured", async () => {
    const w = make({ secrets: [] });
    const res = await w.post(statusPayload(arEnv, []));
    expect(res.status).toBe(403);
    expect(body(res).reason).toBe("no_secrets");
  });

  it("accepts the old and the new secret during a rotation", async () => {
    const w = make({ secrets: [{ secret: OTHER_SECRET }, { secret: APP_SECRET }] });
    expect((await w.post(statusPayload(arEnv, []), APP_SECRET)).status).toBe(200);
    expect((await w.post(statusPayload(arEnv, []), OTHER_SECRET)).status).toBe(200);
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    const w = make();
    const res = await w.postRaw(sign(APP_SECRET, "not json at all"));
    expect(res.status).toBe(400);
    expect(body(res).error).toBe("invalid_json");
  });

  it("acknowledges and ignores a signed payload for another product", async () => {
    const w = make();
    const res = await w.post({ object: "page", entry: [] });
    expect(res.status).toBe(200);
    expect(body(res).ignored).toBe("unexpected_object");
    expect((await w.post([1, 2, 3])).status).toBe(200);
  });
});

describe("replay and stale events", () => {
  it("rejects an event older than the allowed age", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const old = w.clock.sec - DEFAULT_MAX_EVENT_AGE_SECONDS - 1;
    const res = await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "read", old)]));
    expect(res.status).toBe(400);
    expect(body(res).error).toBe("stale_event");
    expect(w.store.getSend(sent.send!.id)!.status).toBe("accepted");
  });

  it("accepts an event just inside the allowed age (7 days, as Meta retries)", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const ts = w.clock.sec - 7 * 24 * 3600;
    expect((await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", ts)]))).status).toBe(200);
  });

  it("rejects an event dated in the future beyond the clock-skew allowance", async () => {
    const w = make();
    expect((await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec + 301)]))).status).toBe(400);
    expect((await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec + 300)]))).status).toBe(200);
  });

  it("uses the configured maximum age", async () => {
    const w = make({ webhook: { maxEventAgeSeconds: 60 } });
    expect((await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec - 61)]))).status).toBe(400);
    expect((await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec - 60)]))).status).toBe(200);
  });

  it("rejects a stale inbound message as well", async () => {
    const w = make();
    const res = await w.post(inboundPayload(arEnv, { from: MARIA, wamid: "wamid.IN1", ts: w.clock.sec - DEFAULT_MAX_EVENT_AGE_SECONDS - 10, text: "STOP" }));
    expect(res.status).toBe(400);
    expect(w.store.isOptedOut(AR.tenantId, "541155500101")).toBe(false);
  });

  it("makes a byte-for-byte replay of a genuine request harmless", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const signed = sign(APP_SECRET, statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec)]));
    const first = await w.postRaw(signed);
    const before = w.store.getSend(sent.send!.id)!;
    const replay = await w.postRaw(signed);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(body(replay).counts).toMatchObject({ statuses: 0, statusDuplicates: 1 });
    expect(w.store.getSend(sent.send!.id)).toEqual(before);
    expect(w.store.countEvents()).toBe(1);
  });

  it("rejects the whole request when any event in it is stale", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const res = await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec), status("wamid.OLD", "sent", w.clock.sec - 20 * 24 * 3600)]));
    expect(res.status).toBe(400);
    expect(w.store.getSend(sent.send!.id)!.status).toBe("accepted");
  });
});

describe("routing by phone_number_id", () => {
  it("applies a status to the tenant that owns the phone number", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const res = await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "read", w.clock.sec)]));
    expect(body(res).counts!["statuses"]).toBe(1);
    expect(w.store.getSend(sent.send!.id)!.status).toBe("read");
  });

  it("does not let another tenant's phone number change the send", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const res = await w.post(statusPayload(esEnv, [status(sent.send!.wamid!, "read", w.clock.sec)]));
    expect(res.status).toBe(200);
    expect(body(res).counts).toMatchObject({ statusOtherTenant: 1, statuses: 0 });
    expect(w.store.getSend(sent.send!.id)!.status).toBe("accepted");
  });

  it("counts, stores nothing and does not retry for an unknown phone number", async () => {
    const w = make();
    const res = await w.post(statusPayload({ phoneNumberId: "999999999999999" }, [status("wamid.X", "sent", w.clock.sec)]));
    expect(res.status).toBe(200);
    expect(body(res).counts!["unrouted"]).toBe(1);
    expect(w.store.countEvents()).toBe(0);
  });

  it("routes two changes of one request to their own tenants", async () => {
    const w = make();
    const a = await sendBudget(w);
    const b = await w.documents.sendByWhatsApp(w.sender, ES.tenantId, "doc-es-budget-1");
    if ("notFound" in b) throw new Error("nf");
    const arPayload = statusPayload(arEnv, [{ ...status(a.send!.wamid!, "delivered", w.clock.sec) }]) as { entry: unknown[] };
    const esPayload = statusPayload(esEnv, [status(b.send!.wamid!, "read", w.clock.sec, { recipientId: "34612345678" })]) as { entry: unknown[] };
    const res = await w.post({ object: "whatsapp_business_account", entry: [...arPayload.entry, ...esPayload.entry] });
    expect(body(res).counts!["statuses"]).toBe(2);
    expect(w.store.getSend(a.send!.id)!.status).toBe("delivered");
    expect(w.store.getSend(b.send!.id)!.status).toBe("read");
  });

  it("opens the customer's window only for the tenant whose number they wrote to", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    await w.post(inboundPayload(esEnv, { from: MARIA, wamid: "wamid.IN1", ts: w.clock.sec, text: "hola" }));
    expect(w.store.lastInboundAt(ES.tenantId, "541155500101")).toBe(w.clock.sec);
    expect(w.store.lastInboundAt(AR.tenantId, "541155500101")).toBeNull();
  });
});

describe("per-tenant secrets", () => {
  const secrets = [
    { secret: APP_SECRET, tenants: [AR.tenantId] },
    { secret: OTHER_SECRET, tenants: [ES.tenantId] },
  ];

  it("accepts each secret for its own tenant", async () => {
    const w = make({ secrets });
    expect((await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec)]), APP_SECRET)).status).toBe(200);
    expect((await w.post(statusPayload(esEnv, [status("wamid.Y", "sent", w.clock.sec)]), OTHER_SECRET)).status).toBe(200);
  });

  it("refuses a valid signature from the wrong tenant's secret", async () => {
    const w = make({ secrets });
    const res = await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec)]), OTHER_SECRET);
    expect(res.status).toBe(403);
    expect(body(res).error).toBe("secret_not_allowed_for_tenant");
    expect(w.store.countEvents()).toBe(0);
  });

  it("lets a secret without a tenant list speak for any tenant", async () => {
    const w = make({ secrets: [{ secret: APP_SECRET }] });
    expect((await w.post(statusPayload(esEnv, []), APP_SECRET)).status).toBe(200);
    expect((await w.post(statusPayload(arEnv, []), APP_SECRET)).status).toBe(200);
  });
});

describe("delivery lifecycle through the mock Graph API", () => {
  it("follows sent, delivered, read delivered as webhooks", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const wamid = sent.send!.wamid!;
    const t = w.clock.sec;
    await w.mock.emitStatus(wamid, "sent", { ts: t + 1 });
    await w.mock.emitStatus(wamid, "delivered", { ts: t + 2 });
    await w.mock.emitStatus(wamid, "read", { ts: t + 3 });
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("read");
    expect([row.sentAt, row.deliveredAt, row.readAt]).toEqual([t + 1, t + 2, t + 3]);
  });

  it("ends in the same state when the mock delivers the statuses in reverse", async () => {
    const w = make();
    w.mock.autoStatus = { sequence: ["sent", "delivered", "read"], order: "reversed" };
    const sent = await sendBudget(w);
    await w.mock.flush();
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("read");
    expect(row.sentAt).not.toBeNull();
    expect(row.deliveredAt).not.toBeNull();
    expect(row.deliveredImplied).toBe(false);
  });

  it("ends in the same state when every status is delivered twice", async () => {
    const w = make();
    w.mock.autoStatus = { sequence: ["sent", "delivered", "read"], duplicate: true };
    const sent = await sendBudget(w);
    await w.mock.flush();
    expect(w.store.getSend(sent.send!.id)!.status).toBe("read");
    expect(w.store.countEvents()).toBe(3);
  });

  it("handles statuses that arrive before the HTTP answer reaches the sender", async () => {
    const w = make();
    w.mock.autoStatus = { sequence: ["sent", "delivered", "read"], beforeResponse: true };
    const sent = await sendBudget(w);
    expect(sent.outcome).toBe("sent");
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("read");
    expect(w.store.orphanEvents(AR.tenantId, row.wamid!)).toHaveLength(0);
  });

  it("records a read without a delivered as an implied delivery", async () => {
    const w = make();
    w.mock.autoStatus = { sequence: ["sent", "read"] };
    const sent = await sendBudget(w);
    await w.mock.flush();
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("read");
    expect(row.deliveredImplied).toBe(true);
  });

  it("records a failed status with the plain-language error", async () => {
    const w = make();
    const sent = await sendBudget(w);
    await w.mock.emitStatus(sent.send!.wamid!, "failed", { errorCode: 131026, errorDetails: "Message Undeliverable." });
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("failed");
    expect(row.errorEs).toContain("no tiene WhatsApp");
    const entry = w.documents.history(AR.tenantId, DOC.arBudget)[0]!;
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe(row.errorEs);
  });

  it("learns that a number is unreachable from a later failed webhook", async () => {
    const w = make();
    w.mock.notOnWhatsAppMode = "async";
    w.mock.notOnWhatsApp.add(MARIA);
    const sent = await sendBudget(w);
    expect(sent.outcome).toBe("sent");
    await w.mock.flush();
    const row = w.store.getSend(sent.send!.id)!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe(131026);
  });

  it("gives an unknown error code a generic text that includes the code", async () => {
    const w = make();
    const sent = await sendBudget(w);
    await w.mock.emitStatus(sent.send!.wamid!, "failed", { errorCode: 777777, errorTitle: "Something new" });
    expect(w.store.getSend(sent.send!.id)!.errorEs).toContain("777777");
  });
});

describe("shape tolerance", () => {
  it("counts a status without an id as malformed and still processes the rest", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const payload = statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec)]) as { entry: Array<{ changes: Array<{ value: { statuses: unknown[] } }> }> };
    payload.entry[0]!.changes[0]!.value.statuses.unshift({ status: "sent", timestamp: String(w.clock.sec) }, "garbage", { id: "wamid.Q", status: "sent" });
    const res = await w.post(payload);
    expect(res.status).toBe(200);
    expect(body(res).counts).toMatchObject({ malformed: 3, statuses: 1 });
    expect(w.store.getSend(sent.send!.id)!.status).toBe("delivered");
  });

  it("acknowledges fields it does not handle (template status updates)", async () => {
    const w = make();
    const res = await w.post({ object: "whatsapp_business_account", entry: [{ id: AR.wabaId, changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] }] });
    expect(res.status).toBe(200);
    expect(body(res).counts!["ignoredFields"]).toBe(1);
  });

  it("counts account-level errors without failing", async () => {
    const w = make();
    const payload = statusPayload(arEnv, []) as { entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }> };
    payload.entry[0]!.changes[0]!.value["errors"] = [{ code: 131000, title: "x" }];
    const res = await w.post(payload);
    expect(body(res).counts!["accountErrors"]).toBe(1);
  });

  it("accepts an empty entry list and an entry without changes", async () => {
    const w = make();
    expect((await w.post({ object: "whatsapp_business_account", entry: [] })).status).toBe(200);
    expect((await w.post({ object: "whatsapp_business_account", entry: [{ id: "1" }, "x", { changes: "nope" }] })).status).toBe(200);
    expect((await w.post({ object: "whatsapp_business_account" })).status).toBe(200);
  });

  it("links a wa_id to a business-scoped user id from contacts[]", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    const payload = inboundPayload(arEnv, { from: MARIA, fromUserId: "AR.777", wamid: "wamid.IN2", ts: w.clock.sec, text: "hola" });
    await w.post(payload);
    expect(w.store.linkedContactKey(AR.tenantId, "AR.777")).toBe("541155500101");
  });

  it("learns the link from a status that carries recipient_user_id", async () => {
    const w = make();
    const sent = await sendBudget(w);
    await w.post(statusPayload(arEnv, [status(sent.send!.wamid!, "delivered", w.clock.sec, { recipientUserId: "AR.888" })]));
    expect(w.store.linkedContactKey(AR.tenantId, "AR.888")).toBe("541155500101");
  });

  it("processes a large batch in one request", async () => {
    const w = make();
    const sent = await sendBudget(w);
    const t = w.clock.sec;
    const batch: StatusInput[] = Array.from({ length: 300 }, (_, i) => status(i === 0 ? sent.send!.wamid! : `wamid.BATCH${i}`, "sent", t - i));
    const res = await w.post(statusPayload(arEnv, batch));
    expect(res.status).toBe(200);
    expect(body(res).counts!["statuses"]).toBe(300);
    expect(MAX_WEBHOOK_BYTES).toBe(3 * 1024 * 1024);
  });

  it("answers 500 when storage fails, so Meta retries", async () => {
    const w = make();
    w.store.db.exec("DROP TABLE status_events");
    const res = await w.post(statusPayload(arEnv, [status("wamid.X", "sent", w.clock.sec)]));
    expect(res.status).toBe(500);
    expect(body(res).error).toBe("processing_failed");
  });
});

describe("inbound messages, STOP and START", () => {
  it("records an opt-out, replies with a confirmation in the customer's language, and blocks later sends", async () => {
    const w = make();
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "BAJA");
    expect(w.store.isOptedOut(AR.tenantId, "541155500101")).toBe(true);
    expect(w.mock.messages).toHaveLength(1);
    const ack = w.mock.messages[0]!;
    expect(ack.type).toBe("text");
    expect((ack.body["text"] as { body: string }).body).toBe(FREEFORM.es.optOutConfirmation);
    expect((await sendBudget(w)).outcome).toBe("blocked_opt_out");
  });

  it("confirms START too and allows sending again", async () => {
    const w = make();
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "BAJA");
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "ALTA");
    expect(w.mock.messages.map((m) => (m.body["text"] as { body: string }).body)).toEqual([FREEFORM.es.optOutConfirmation, FREEFORM.es.optInConfirmation]);
    expect((await sendBudget(w)).outcome).toBe("sent");
  });

  it("counts opt-outs and opt-ins in the response", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    const r1 = await w.post(inboundPayload(arEnv, { from: MARIA, wamid: "wamid.IN1", ts: w.clock.sec, text: "STOP" }));
    const r2 = await w.post(inboundPayload(arEnv, { from: MARIA, wamid: "wamid.IN2", ts: w.clock.sec, text: "START" }));
    expect(body(r1).counts).toMatchObject({ inbound: 1, optOuts: 1, optIns: 0 });
    expect(body(r2).counts).toMatchObject({ inbound: 1, optOuts: 0, optIns: 1 });
  });

  it("does not send a confirmation when that is turned off", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "BAJA");
    expect(w.mock.messages).toHaveLength(0);
    expect(w.store.isOptedOut(AR.tenantId, "541155500101")).toBe(true);
  });

  it("sends one confirmation even if the same webhook is delivered twice", async () => {
    const w = make();
    w.mock.userMessaged(AR.phoneNumberId, MARIA); // the platform side of the window; the kit learns it from the webhook
    const signed = sign(APP_SECRET, inboundPayload(arEnv, { from: MARIA, wamid: "wamid.INDUP", ts: w.clock.sec, text: "BAJA" }));
    const a = await w.postRaw(signed);
    await a.pending;
    const b = await w.postRaw(signed);
    await b.pending;
    expect(body(b).counts).toMatchObject({ inboundDuplicates: 1, inbound: 0 });
    expect(w.mock.messages).toHaveLength(1);
  });

  it("does not treat a sentence that contains the keyword as an opt-out", async () => {
    const w = make();
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "no quiero dar de baja el presupuesto");
    expect(w.store.isOptedOut(AR.tenantId, "541155500101")).toBe(false);
    expect(w.mock.messages).toHaveLength(0);
  });

  it("opens the 24-hour window for an ordinary message", async () => {
    const w = make();
    await w.mock.emitInbound(AR.phoneNumberId, MARIA, "hola, ¿está el presupuesto?");
    const r = await sendBudget(w);
    expect(r.send!.kind).toBe("document");
  });

  it("still answers 200 when the confirmation cannot be sent", async () => {
    const w = make();
    w.mock.failNext({ status: 400, code: 131009, message: "(#131009) bad" }, 5, "messages");
    const res = await w.post(inboundPayload(arEnv, { from: MARIA, wamid: "wamid.IN9", ts: w.clock.sec, text: "BAJA" }));
    await res.pending;
    expect(res.status).toBe(200);
    expect(w.store.isOptedOut(AR.tenantId, "541155500101")).toBe(true);
  });

  it("handles a message that only carries a business-scoped user id", async () => {
    const w = make({ webhook: { confirmOptChanges: false } });
    await w.post(inboundPayload(arEnv, { fromUserId: "AR.55", wamid: "wamid.IN5", ts: w.clock.sec, text: "BAJA" }));
    expect(w.store.isOptedOut(AR.tenantId, "bsuid:AR.55")).toBe(true);
  });

  it("sends the confirmation to the user id when there is no phone number", async () => {
    const w = make();
    const res = await w.post(inboundPayload(arEnv, { fromUserId: "AR.56", wamid: "wamid.IN6", ts: w.clock.sec, text: "BAJA" }));
    await res.pending;
    expect(w.mock.messages[0]!.body["recipient"]).toBe("AR.56");
  });

  it("verifies that the signature header uses the computeSignature format", () => {
    expect(computeSignature(APP_SECRET, "x")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
