// Inbound messages: the 24-hour customer service window clock and STOP / START (opt-out / opt-in) keywords.
//
// Docs (send-messages, getting-opt-in): a 24-hour window opens when a user messages the business and resets on each new
// message; inside it free-form messages are allowed, outside it only approved templates; businesses must honour
// opt-out requests. Meta defines no keywords: the list below is this kit's default and is configurable per deployment.

import type { Store } from "./db.ts";
import { matchKey } from "./phone.ts";

export const WINDOW_SECONDS = 24 * 60 * 60;

export function isWindowOpen(store: Store, tenantId: string, contactKey: string, nowSeconds: number): boolean {
  const last = store.lastInboundAt(tenantId, contactKey);
  return last !== null && nowSeconds - last < WINDOW_SECONDS;
}

export interface KeywordConfig {
  optOut: readonly string[];
  optIn: readonly string[];
}

export const DEFAULT_KEYWORDS: KeywordConfig = {
  optOut: ["stop", "stop all", "unsubscribe", "baja", "parar", "desuscribir", "dar de baja", "darme de baja", "no mas mensajes", "cancelar suscripcion"],
  optIn: ["start", "unstop", "alta", "suscribir", "volver a suscribir"],
};

/** lower case, no accents, punctuation removed, single spaces: "¡Baja!" -> "baja", "Dar de BAJA." -> "dar de baja" */
export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The whole message must be the keyword: "stop sending me spam" or "no pares" are NOT opt-outs. */
export function classifyKeyword(text: string | null | undefined, config: KeywordConfig = DEFAULT_KEYWORDS): "opt_out" | "opt_in" | null {
  if (!text) return null;
  const n = normalizeKeyword(text);
  if (n === "") return null;
  if (config.optOut.some((k) => normalizeKeyword(k) === n)) return "opt_out";
  if (config.optIn.some((k) => normalizeKeyword(k) === n)) return "opt_in";
  return null;
}

export interface IncomingMessage {
  wamid: string;
  ts: number;
  type: string;
  /** phone number (digits) as WhatsApp reports it; absent when the user hides it behind a username */
  from: string | null;
  fromUserId: string | null;
  text: string | null;
}

/** The key under which we track a person: their phone number match key, or a provisional "bsuid:<id>". */
export function contactKeyFor(store: Store, tenantId: string, who: { phone?: string | null | undefined; bsuid?: string | null | undefined }): string | null {
  const phoneKey = who.phone ? matchKey(who.phone) : null;
  if (phoneKey && who.bsuid) store.linkIdentity(tenantId, who.bsuid, phoneKey);
  if (phoneKey) return phoneKey;
  if (who.bsuid) return store.linkedContactKey(tenantId, who.bsuid) ?? "bsuid:" + who.bsuid;
  return null;
}

export type InboundResult =
  | { duplicate: true }
  | { duplicate: false; contactKey: string | null; action: "opt_out" | "opt_in" | null; keyword: string | null };

export function processInbound(store: Store, tenantId: string, msg: IncomingMessage, keywords: KeywordConfig = DEFAULT_KEYWORDS): InboundResult {
  const contactKey = contactKeyFor(store, tenantId, { phone: msg.from, bsuid: msg.fromUserId });
  if (contactKey === null) return { duplicate: false, contactKey: null, action: null, keyword: null };

  const action = msg.type === "text" ? classifyKeyword(msg.text, keywords) : null;
  const keyword = action && msg.text ? normalizeKeyword(msg.text) : null;
  const inserted = store.insertInbound({ tenantId, wamid: msg.wamid, contactKey, ts: msg.ts, type: msg.type, text: msg.text?.slice(0, 1000) ?? null, keyword });
  if (!inserted) return { duplicate: true };

  // any message from the user (including STOP) opens / resets the window
  store.touchConversation(tenantId, contactKey, msg.ts);

  if (action === "opt_out") store.optOut(tenantId, contactKey, keyword!, msg.wamid, msg.ts);
  if (action === "opt_in") store.optIn(tenantId, contactKey, keyword!, msg.wamid, msg.ts);
  return { duplicate: false, contactKey, action, keyword };
}
