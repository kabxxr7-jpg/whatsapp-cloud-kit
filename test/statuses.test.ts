import { afterEach, describe, expect, it } from "vitest";
import { Store, type SendRow } from "../src/db.ts";
import { applyOrphans, applyStatusEvent, decideDelivery, type IncomingStatus } from "../src/statuses.ts";
import { START_MS, TestClock } from "../testing/harness.ts";

const T0 = Math.floor(START_MS / 1000);
const stores: Store[] = [];

function freshStore(): Store {
  const store = new Store(":memory:", new TestClock().now);
  stores.push(store);
  for (const [id, pn] of [["taller-ar", "100000000000001"], ["estudio-es", "100000000000002"]] as const) {
    store.upsertTenant({ id, name: id, phoneNumberId: pn, accessToken: "t", locale: "es" });
  }
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

let counter = 0;
function acceptedSend(store: Store, wamid: string | null = "wamid.A", tenantId = "taller-ar"): SendRow {
  counter++;
  const r = store.reserveSend({
    tenantId,
    documentId: "doc-" + counter,
    docType: "budget",
    recipientKey: "541155500101",
    recipientE164: "+5491155500101",
    baseKey: `${tenantId}|doc-${counter}|541155500101`,
    kind: "template",
    templateName: "presupuesto_adjunto",
    language: "es",
    filename: "f.pdf",
    resend: false,
  });
  if (wamid) store.markAccepted(r.send.id, wamid, "5491155500101");
  return store.getSend(r.send.id)!;
}

function ev(wamid: string, status: string, ts: number, extra: Partial<IncomingStatus> = {}): IncomingStatus {
  return { tenantId: "taller-ar", wamid, status, ts, recipientId: null, ref: null, errors: [], raw: { id: wamid, status }, ...extra };
}

const err131026 = [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "Message Undeliverable." } }];

describe("decideDelivery (pure)", () => {
  const base = (): SendRow => ({ ...acceptedSend(freshStore()) });

  it("moves accepted to sent and records the time", () => {
    const d = decideDelivery(base(), { status: "sent", ts: T0 + 1, errors: [] });
    expect(d.status).toBe("sent");
    expect(d.sentAt).toBe(T0 + 1);
  });

  it("never lowers the status", () => {
    const cur: SendRow = { ...base(), status: "read", readAt: T0 + 5, deliveredAt: T0 + 3, sentAt: null };
    const d = decideDelivery(cur, { status: "sent", ts: T0 + 1, errors: [] });
    expect(d.status).toBe("read");
    expect(d.sentAt).toBe(T0 + 1);
  });

  it("keeps the earliest time seen for a status", () => {
    const cur: SendRow = { ...base(), status: "sent", sentAt: T0 + 10 };
    expect(decideDelivery(cur, { status: "sent", ts: T0 + 20, errors: [] }).sentAt).toBe(T0 + 10);
    expect(decideDelivery(cur, { status: "sent", ts: T0 + 4, errors: [] }).sentAt).toBe(T0 + 4);
  });

  it("does not change the input row", () => {
    const cur = base();
    const copy = { ...cur };
    decideDelivery(cur, { status: "failed", ts: T0, errors: err131026 });
    expect(cur).toEqual(copy);
  });

  it("ignores statuses it does not track", () => {
    const cur = base();
    for (const status of ["played", "deleted", "weird", ""]) {
      const d = decideDelivery(cur, { status, ts: T0, errors: [] });
      expect(d.status).toBe(cur.status);
      expect(d.error).toBeUndefined();
    }
  });
});

describe("status events", () => {
  it("applies sent, delivered and read in order", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    expect(applyStatusEvent(store, ev("wamid.A", "sent", T0 + 1)).result).toBe("applied");
    expect(applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 2)).result).toBe("applied");
    expect(applyStatusEvent(store, ev("wamid.A", "read", T0 + 3)).result).toBe("applied");
    const row = store.getSend(send.id)!;
    expect(row.status).toBe("read");
    expect([row.sentAt, row.deliveredAt, row.readAt]).toEqual([T0 + 1, T0 + 2, T0 + 3]);
    expect(row.deliveredImplied).toBe(false);
  });

  it("reaches the same state when the events arrive in any order", () => {
    const events = [ev("wamid.A", "sent", T0 + 1), ev("wamid.A", "delivered", T0 + 2), ev("wamid.A", "read", T0 + 3)];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1], [1, 0, 2], [0, 2, 1]];
    const finals = orders.map((order) => {
      const store = freshStore();
      const send = acceptedSend(store);
      for (const i of order) applyStatusEvent(store, events[i]!);
      const r = store.getSend(send.id)!;
      return { status: r.status, sentAt: r.sentAt, deliveredAt: r.deliveredAt, readAt: r.readAt, implied: r.deliveredImplied };
    });
    for (const f of finals) expect(f).toEqual({ status: "read", sentAt: T0 + 1, deliveredAt: T0 + 2, readAt: T0 + 3, implied: false });
  });

  it("treats a read with no delivered as delivered, and says so", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "sent", T0 + 1));
    applyStatusEvent(store, ev("wamid.A", "read", T0 + 5));
    const row = store.getSend(send.id)!;
    expect(row.status).toBe("read");
    expect(row.deliveredAt).toBe(T0 + 5);
    expect(row.deliveredImplied).toBe(true);
  });

  it("replaces an implied delivery when the real delivered event shows up later", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "read", T0 + 5));
    applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 4));
    const row = store.getSend(send.id)!;
    expect(row.deliveredAt).toBe(T0 + 4);
    expect(row.deliveredImplied).toBe(false);
  });

  it("reports an identical event delivered twice as a duplicate and changes nothing", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 2));
    const before = store.getSend(send.id)!;
    expect(applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 2)).result).toBe("duplicate");
    expect(store.getSend(send.id)).toEqual(before);
    expect(store.countEvents()).toBe(1);
  });

  it("reports a later repeat of a status with another timestamp as no change", () => {
    const store = freshStore();
    acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 2));
    expect(applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 9)).result).toBe("no_change");
  });

  it("records a failure with the plain-language text in both languages", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    const r = applyStatusEvent(store, ev("wamid.A", "failed", T0 + 3, { errors: err131026 }));
    expect(r.result).toBe("applied");
    const row = store.getSend(send.id)!;
    expect(row.status).toBe("failed");
    expect(row.failedAt).toBe(T0 + 3);
    expect(row.errorCode).toBe(131026);
    expect(row.errorDetails).toBe("Message Undeliverable.");
    expect(row.errorEs).toContain("no tiene WhatsApp");
    expect(row.errorEn).toContain("not on WhatsApp");
  });

  it("gives a failure without an error list a generic text", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "failed", T0 + 3));
    const row = store.getSend(send.id)!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBeNull();
    expect(row.errorEs).toContain("sin código");
  });

  it("does not let a failure overwrite a message that was delivered or read", () => {
    for (const reached of ["delivered", "read"]) {
      const store = freshStore();
      const send = acceptedSend(store);
      applyStatusEvent(store, ev("wamid.A", reached, T0 + 2));
      expect(applyStatusEvent(store, ev("wamid.A", "failed", T0 + 3, { errors: err131026 })).result).toBe("no_change");
      const row = store.getSend(send.id)!;
      expect(row.status).toBe(reached);
      expect(row.errorCode).toBeNull();
    }
  });

  it("lets a failure replace sent", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "sent", T0 + 1));
    applyStatusEvent(store, ev("wamid.A", "failed", T0 + 2, { errors: err131026 }));
    expect(store.getSend(send.id)!.status).toBe("failed");
  });

  it("ignores a late sent after a failure, but a late delivered clears the failure", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "failed", T0 + 3, { errors: err131026 }));
    applyStatusEvent(store, ev("wamid.A", "sent", T0 + 1));
    let row = store.getSend(send.id)!;
    expect(row.status).toBe("failed");
    expect(row.sentAt).toBe(T0 + 1);
    applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 4));
    row = store.getSend(send.id)!;
    expect(row.status).toBe("delivered");
    expect(row.failedAt).toBeNull();
    expect(row.errorCode).toBeNull();
    expect(row.errorEs).toBeNull();
  });

  it("stores events it does not act on (played) without changing the send", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    const before = store.getSend(send.id)!;
    expect(applyStatusEvent(store, ev("wamid.A", "played", T0 + 2)).result).toBe("no_change");
    expect(store.getSend(send.id)).toEqual(before);
    expect(store.countEvents()).toBe(1);
  });

  it("links each stored event to its send", () => {
    const store = freshStore();
    const send = acceptedSend(store);
    applyStatusEvent(store, ev("wamid.A", "sent", T0 + 1));
    applyStatusEvent(store, ev("wamid.A", "delivered", T0 + 2));
    const events = store.eventsForSend(send.id);
    expect(events.map((e) => e.status)).toEqual(["sent", "delivered"]);
    expect(events.every((e) => e.applied)).toBe(true);
  });
});

describe("events that arrive before the send knows its message id", () => {
  it("keeps them as orphans and replays them in time order when the id is known", () => {
    const store = freshStore();
    const send = acceptedSend(store, null);
    expect(applyStatusEvent(store, ev("wamid.LATE", "read", T0 + 3)).result).toBe("orphan");
    expect(applyStatusEvent(store, ev("wamid.LATE", "sent", T0 + 1)).result).toBe("orphan");
    expect(applyStatusEvent(store, ev("wamid.LATE", "delivered", T0 + 2)).result).toBe("orphan");
    const accepted = store.markAccepted(send.id, "wamid.LATE", "5491155500101");
    expect(applyOrphans(store, accepted)).toBe(3);
    const row = store.getSend(send.id)!;
    expect(row.status).toBe("read");
    expect([row.sentAt, row.deliveredAt, row.readAt]).toEqual([T0 + 1, T0 + 2, T0 + 3]);
    expect(store.orphanEvents("taller-ar", "wamid.LATE")).toHaveLength(0);
  });

  it("does nothing for a send without a message id", () => {
    const store = freshStore();
    expect(applyOrphans(store, acceptedSend(store, null))).toBe(0);
  });

  it("does not replay another tenant's orphans", () => {
    const store = freshStore();
    applyStatusEvent(store, ev("wamid.X", "delivered", T0 + 2, { tenantId: "estudio-es" }));
    const send = acceptedSend(store, null);
    const accepted = store.markAccepted(send.id, "wamid.X", null);
    expect(applyOrphans(store, accepted)).toBe(0);
    expect(store.getSend(send.id)!.status).toBe("accepted");
  });

  it("matches an unknown message id to a send by its reference and adopts the id", () => {
    const store = freshStore();
    const send = acceptedSend(store, null);
    const r = applyStatusEvent(store, ev("wamid.ADOPTED", "sent", T0 + 1, { ref: send.ref }));
    expect(r.result).toBe("adopted");
    const row = store.getSend(send.id)!;
    expect(row.wamid).toBe("wamid.ADOPTED");
    expect(row.status).toBe("sent");
  });

  it("flags a second message for the same send as a suspected double send", () => {
    const store = freshStore();
    const send = acceptedSend(store, "wamid.FIRST");
    const r = applyStatusEvent(store, ev("wamid.SECOND", "sent", T0 + 1, { ref: send.ref }));
    expect(r.result).toBe("extra_message");
    const row = store.getSend(send.id)!;
    expect(row.doubleSendSuspected).toBe(true);
    expect(row.wamid).toBe("wamid.FIRST");
    expect(row.status).toBe("accepted");
    // more events of the same extra message do not add a second extra
    applyStatusEvent(store, ev("wamid.SECOND", "delivered", T0 + 2, { ref: send.ref }));
    expect(store.listExtraWamids(send.id)).toEqual(["wamid.SECOND"]);
  });

  it("does not apply an event to another tenant's send that happens to share a reference", () => {
    const store = freshStore();
    const send = acceptedSend(store, null, "estudio-es");
    const r = applyStatusEvent(store, ev("wamid.Z", "sent", T0 + 1, { ref: send.ref }));
    expect(r.result).toBe("orphan");
    expect(store.getSend(send.id)!.wamid).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("does not let tenant B's webhook change tenant A's send", () => {
    const store = freshStore();
    const send = acceptedSend(store, "wamid.A", "taller-ar");
    const r = applyStatusEvent(store, ev("wamid.A", "read", T0 + 3, { tenantId: "estudio-es" }));
    expect(r.result).toBe("other_tenant");
    expect(store.getSend(send.id)!.status).toBe("accepted");
  });

  it("applies the same message id for the right tenant normally", () => {
    const store = freshStore();
    const send = acceptedSend(store, "wamid.A", "taller-ar");
    expect(applyStatusEvent(store, ev("wamid.A", "read", T0 + 3)).result).toBe("applied");
    expect(store.getSend(send.id)!.status).toBe("read");
  });
});
