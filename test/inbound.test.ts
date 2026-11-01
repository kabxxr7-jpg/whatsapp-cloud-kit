import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { DEFAULT_KEYWORDS, WINDOW_SECONDS, classifyKeyword, contactKeyFor, isWindowOpen, normalizeKeyword, processInbound } from "../src/inbound.ts";
import { START_MS, TestClock } from "../testing/harness.ts";

const T0 = Math.floor(START_MS / 1000);
const stores: Store[] = [];
function freshStore(): Store {
  const store = new Store(":memory:", new TestClock().now);
  stores.push(store);
  store.upsertTenant({ id: "taller-ar", name: "Taller", phoneNumberId: "100000000000001", accessToken: "t" });
  store.upsertTenant({ id: "estudio-es", name: "Estudio", phoneNumberId: "100000000000002", accessToken: "t" });
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const msg = (wamid: string, text: string | null, extra: Partial<Parameters<typeof processInbound>[2]> = {}) => ({
  wamid,
  ts: T0,
  type: "text",
  from: "5491155500101",
  fromUserId: null,
  text,
  ...extra,
});

describe("keywords", () => {
  it("normalises case, accents, punctuation and spaces", () => {
    expect(normalizeKeyword("¡Baja!")).toBe("baja");
    expect(normalizeKeyword("  DAR   de BAJA. ")).toBe("dar de baja");
    expect(normalizeKeyword("Cancelar suscripción")).toBe("cancelar suscripcion");
    expect(normalizeKeyword("STOP.")).toBe("stop");
    expect(normalizeKeyword("")).toBe("");
  });

  it("recognises every default opt-out and opt-in keyword", () => {
    for (const k of DEFAULT_KEYWORDS.optOut) expect(classifyKeyword(k), k).toBe("opt_out");
    for (const k of DEFAULT_KEYWORDS.optIn) expect(classifyKeyword(k), k).toBe("opt_in");
  });

  it("matches with different case, accents and punctuation", () => {
    expect(classifyKeyword("BAJA")).toBe("opt_out");
    expect(classifyKeyword("Stop!")).toBe("opt_out");
    expect(classifyKeyword("  baja  ")).toBe("opt_out");
    expect(classifyKeyword("Alta.")).toBe("opt_in");
    expect(classifyKeyword("START")).toBe("opt_in");
  });

  it("needs the whole message to be the keyword", () => {
    for (const text of ["stop sending me spam", "no pares", "baja por favor", "quiero el presupuesto", "alta temperatura", "estop", "hola"]) {
      expect(classifyKeyword(text), text).toBeNull();
    }
  });

  it("ignores empty and missing text", () => {
    expect(classifyKeyword("")).toBeNull();
    expect(classifyKeyword("   ")).toBeNull();
    expect(classifyKeyword("¡¡!!")).toBeNull();
    expect(classifyKeyword(null)).toBeNull();
    expect(classifyKeyword(undefined)).toBeNull();
  });

  it("supports a custom list", () => {
    const config = { optOut: ["arrêt"], optIn: ["reprise"] };
    expect(classifyKeyword("ARRET", config)).toBe("opt_out");
    expect(classifyKeyword("reprise", config)).toBe("opt_in");
    expect(classifyKeyword("stop", config)).toBeNull();
  });
});

describe("24-hour window", () => {
  it("is 24 hours", () => {
    expect(WINDOW_SECONDS).toBe(86400);
  });

  it("is closed until the customer writes, open for 24 hours, closed at 24 hours", () => {
    const store = freshStore();
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0)).toBe(false);
    store.touchConversation("taller-ar", "541155500101", T0);
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0)).toBe(true);
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0 + 86399)).toBe(true);
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0 + 86400)).toBe(false);
  });

  it("belongs to one tenant and one contact", () => {
    const store = freshStore();
    store.touchConversation("taller-ar", "541155500101", T0);
    expect(isWindowOpen(store, "estudio-es", "541155500101", T0)).toBe(false);
    expect(isWindowOpen(store, "taller-ar", "541155500102", T0)).toBe(false);
  });

  it("is extended by a newer message and not shortened by an older one", () => {
    const store = freshStore();
    store.touchConversation("taller-ar", "k", T0 + 100);
    store.touchConversation("taller-ar", "k", T0);
    expect(store.lastInboundAt("taller-ar", "k")).toBe(T0 + 100);
    store.touchConversation("taller-ar", "k", T0 + 200);
    expect(store.lastInboundAt("taller-ar", "k")).toBe(T0 + 200);
  });
});

describe("processInbound", () => {
  it("stores the message, opens the window and reports no action for ordinary text", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "Hola, quiero consultar"));
    expect(r).toEqual({ duplicate: false, contactKey: "541155500101", action: null, keyword: null });
    expect(store.lastInboundAt("taller-ar", "541155500101")).toBe(T0);
    expect(store.listInbound("taller-ar")).toHaveLength(1);
  });

  it("records an opt-out with the keyword and honours it from then on", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "BAJA"));
    expect(r).toMatchObject({ action: "opt_out", keyword: "baja" });
    expect(store.isOptedOut("taller-ar", "541155500101")).toBe(true);
    expect(store.isOptedOut("estudio-es", "541155500101")).toBe(false);
    expect(store.listOptEvents("taller-ar")).toEqual([{ contactKey: "541155500101", event: "opt_out", keyword: "baja", ts: T0 }]);
  });

  it("still opens the window when the message is STOP", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "STOP"));
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0)).toBe(true);
  });

  it("opts back in on START", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "STOP"));
    const r = processInbound(store, "taller-ar", msg("wamid.2", "ALTA", { ts: T0 + 60 }));
    expect(r).toMatchObject({ action: "opt_in" });
    expect(store.isOptedOut("taller-ar", "541155500101")).toBe(false);
    expect(store.listOptEvents("taller-ar").map((e) => e.event)).toEqual(["opt_out", "opt_in"]);
  });

  it("recognises the person whichever way WhatsApp writes their Argentine number", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "STOP", { from: "5491155500101" }));
    expect(store.isOptedOut("taller-ar", "541155500101")).toBe(true);
    const other = processInbound(store, "taller-ar", msg("wamid.2", "hola", { from: "541155500101" }));
    expect(other).toMatchObject({ contactKey: "541155500101" });
  });

  it("recognises a duplicate delivery and does nothing the second time", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "STOP"));
    const again = processInbound(store, "taller-ar", msg("wamid.1", "STOP"));
    expect(again).toEqual({ duplicate: true });
    expect(store.listOptEvents("taller-ar")).toHaveLength(1);
    expect(store.listInbound("taller-ar")).toHaveLength(1);
  });

  it("only treats text messages as keywords", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "STOP", { type: "image" }));
    expect(r).toMatchObject({ action: null });
    expect(store.isOptedOut("taller-ar", "541155500101")).toBe(false);
    expect(isWindowOpen(store, "taller-ar", "541155500101", T0)).toBe(true);
  });

  it("ignores a message with no sender at all", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "STOP", { from: null }));
    expect(r).toEqual({ duplicate: false, contactKey: null, action: null, keyword: null });
    expect(store.listInbound("taller-ar")).toHaveLength(0);
  });

  it("truncates a very long text before storing it", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "x".repeat(5000)));
    expect(store.listInbound("taller-ar")[0]!.text).toHaveLength(1000);
  });

  it("uses the configured keywords", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "arrêt"), { optOut: ["arret"], optIn: [] });
    expect(r).toMatchObject({ action: "opt_out" });
  });
});

describe("business-scoped user ids", () => {
  it("tracks a person who only has a user id under a provisional key", () => {
    const store = freshStore();
    const r = processInbound(store, "taller-ar", msg("wamid.1", "STOP", { from: null, fromUserId: "AR.123" }));
    expect(r).toMatchObject({ contactKey: "bsuid:AR.123", action: "opt_out" });
    expect(store.isOptedOut("taller-ar", "bsuid:AR.123")).toBe(true);
  });

  it("folds the window and the opt-out into the phone key once the number is learned", () => {
    const store = freshStore();
    processInbound(store, "taller-ar", msg("wamid.1", "STOP", { from: null, fromUserId: "AR.123" }));
    processInbound(store, "taller-ar", msg("wamid.2", "hola", { from: "5491155500101", fromUserId: "AR.123", ts: T0 + 10 }));
    expect(store.isOptedOut("taller-ar", "541155500101")).toBe(true);
    expect(store.isOptedOut("taller-ar", "bsuid:AR.123")).toBe(false);
    expect(store.lastInboundAt("taller-ar", "541155500101")).toBe(T0 + 10);
    expect(store.lastInboundAt("taller-ar", "bsuid:AR.123")).toBeNull();
    expect(store.linkedContactKey("taller-ar", "AR.123")).toBe("541155500101");
  });

  it("uses the linked phone key for later messages that only carry the user id", () => {
    const store = freshStore();
    store.linkIdentity("taller-ar", "AR.123", "541155500101");
    expect(contactKeyFor(store, "taller-ar", { bsuid: "AR.123" })).toBe("541155500101");
    expect(contactKeyFor(store, "taller-ar", { bsuid: "AR.999" })).toBe("bsuid:AR.999");
  });

  it("does not link across tenants", () => {
    const store = freshStore();
    store.linkIdentity("taller-ar", "AR.123", "541155500101");
    expect(contactKeyFor(store, "estudio-es", { bsuid: "AR.123" })).toBe("bsuid:AR.123");
  });

  it("returns null when there is neither a number nor a user id", () => {
    const store = freshStore();
    expect(contactKeyFor(store, "taller-ar", {})).toBeNull();
    expect(contactKeyFor(store, "taller-ar", { phone: null, bsuid: null })).toBeNull();
  });

  it("prefers the phone number and learns the link when both are present", () => {
    const store = freshStore();
    expect(contactKeyFor(store, "taller-ar", { phone: "5491155500101", bsuid: "AR.5" })).toBe("541155500101");
    expect(store.linkedContactKey("taller-ar", "AR.5")).toBe("541155500101");
  });
});
