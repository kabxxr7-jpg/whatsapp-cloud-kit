// Delivery status rules: out-of-order and duplicate status webhooks must leave the same final state.
//
// From the docs (status messages webhook): a message has up to three status webhooks (sent, delivered, read); when a
// message is read at the moment it arrives, the `delivered` webhook is NOT sent; failures arrive as `failed` with an
// `errors` array; `played` exists for voice messages only. Webhooks are retried and can arrive twice or late.
//
// Rules implemented here:
//   * rank: sent < delivered < read. A lower-ranked event never lowers the status.
//   * `read` without `delivered` implies delivery (delivered_at = read time, flagged as implied).
//   * `failed` replaces accepted/sent, but never replaces delivered/read (a message that reached the phone did not fail).
//   * after `failed`, a late `sent` is ignored, but a late `delivered`/`read` wins (evidence the message arrived).
//   * the per-status timestamps keep the EARLIEST time seen for that status, whatever the arrival order.
//   * the same (message id, status, timestamp) stored twice is a duplicate and changes nothing.

import type { SendRow, SendStatus, Store } from "./db.ts";
import { errorDetails, mapWhatsAppError, type WhatsAppApiError } from "./whatsapp-errors.ts";

export interface IncomingStatus {
  tenantId: string;
  wamid: string;
  status: string;
  ts: number;
  recipientId: string | null;
  /** `biz_opaque_callback_data`: the correlation reference the kit put in the send request. */
  ref: string | null;
  errors: WhatsAppApiError[];
  raw: unknown;
}

export type StatusResult =
  | { result: "duplicate" }
  | { result: "applied"; send: SendRow }
  | { result: "no_change"; send: SendRow }
  | { result: "adopted"; send: SendRow }
  | { result: "extra_message"; send: SendRow }
  | { result: "orphan" }
  | { result: "other_tenant" };

const RANK: Record<string, number> = { pending: 0, unknown: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };

const earliest = (current: number | null, next: number): number => (current === null ? next : Math.min(current, next));

interface Decision {
  status: SendStatus;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
  deliveredImplied: boolean;
  error: { code: number | null; details: string; es: string; en: string } | null | undefined; // undefined = keep
}

/** Pure: what a send should look like after one more status event. */
export function decideDelivery(cur: SendRow, ev: { status: string; ts: number; errors: WhatsAppApiError[] }): Decision {
  const d: Decision = {
    status: cur.status,
    sentAt: cur.sentAt,
    deliveredAt: cur.deliveredAt,
    readAt: cur.readAt,
    failedAt: cur.failedAt,
    deliveredImplied: cur.deliveredImplied,
    error: undefined,
  };

  switch (ev.status) {
    case "sent":
      d.sentAt = earliest(d.sentAt, ev.ts);
      break;
    case "delivered":
      d.deliveredAt = earliest(d.deliveredAt, ev.ts);
      d.deliveredImplied = false;
      break;
    case "read":
      d.readAt = earliest(d.readAt, ev.ts);
      if (d.deliveredAt === null) {
        d.deliveredAt = ev.ts;
        d.deliveredImplied = true;
      }
      break;
    default:
      break;
  }

  if (ev.status === "sent" || ev.status === "delivered" || ev.status === "read") {
    if (cur.status === "failed") {
      if (ev.status !== "sent") {
        d.status = ev.status;
        d.failedAt = null;
        d.error = null;
      }
    } else if ((RANK[ev.status] ?? 0) > (RANK[cur.status] ?? 0)) {
      d.status = ev.status;
    }
  } else if (ev.status === "failed") {
    if ((RANK[cur.status] ?? 0) >= RANK["delivered"]!) {
      // delivered or read already: keep it
    } else {
      d.status = "failed";
      d.failedAt = earliest(d.failedAt, ev.ts);
      const first = ev.errors[0];
      const info = mapWhatsAppError(first?.code);
      d.error = { code: first?.code ?? null, details: errorDetails(first), es: info.es, en: info.en };
    }
  }
  return d;
}

function isChanged(cur: SendRow, d: Decision): boolean {
  return (
    cur.status !== d.status ||
    cur.sentAt !== d.sentAt ||
    cur.deliveredAt !== d.deliveredAt ||
    cur.readAt !== d.readAt ||
    cur.failedAt !== d.failedAt ||
    cur.deliveredImplied !== d.deliveredImplied ||
    d.error !== undefined
  );
}

function applyToSend(store: Store, send: SendRow, ev: IncomingStatus): { send: SendRow; changed: boolean } {
  const d = decideDelivery(send, ev);
  const changed = isChanged(send, d);
  if (changed) {
    store.updateDelivery(send.id, {
      status: d.status,
      sentAt: d.sentAt,
      deliveredAt: d.deliveredAt,
      readAt: d.readAt,
      failedAt: d.failedAt,
      deliveredImplied: d.deliveredImplied,
      error: d.error,
    });
  }
  return { send: store.getSend(send.id)!, changed };
}

/** Store one status event and apply it. Safe to call twice with the same event. */
export function applyStatusEvent(store: Store, ev: IncomingStatus): StatusResult {
  const first = ev.errors[0];
  const eventId = store.insertStatusEvent({
    tenantId: ev.tenantId,
    wamid: ev.wamid,
    status: ev.status,
    ts: ev.ts,
    recipientId: ev.recipientId,
    ref: ev.ref,
    errorCode: first?.code ?? null,
    errorTitle: first?.title ?? null,
    errorDetails: first ? errorDetails(first) : null,
    rawJson: JSON.stringify(ev.raw),
    sendId: null,
  });
  if (eventId === null) return { result: "duplicate" };

  let send = store.getSendByWamid(ev.tenantId, ev.wamid);

  if (!send) {
    const other = store.getSendByWamidAnyTenant(ev.wamid);
    if (other && other.tenantId !== ev.tenantId) return { result: "other_tenant" };
  }

  if (!send && ev.ref) {
    const byRef = store.getSendByRef(ev.tenantId, ev.ref);
    if (byRef) {
      if (byRef.wamid === null) {
        send = store.adoptWamid(byRef.id, ev.wamid);
        const applied = applyToSend(store, send, ev);
        store.markEvent(eventId, send.id, applied.changed);
        applyOrphans(store, applied.send);
        return { result: "adopted", send: store.getSend(send.id)! };
      }
      // The send already has a different message id: WhatsApp created a second message for the same send.
      store.addExtraWamid(byRef.id, ev.wamid);
      store.markEvent(eventId, byRef.id, false);
      return { result: "extra_message", send: store.getSend(byRef.id)! };
    }
  }

  if (!send) return { result: "orphan" };

  const applied = applyToSend(store, send, ev);
  store.markEvent(eventId, send.id, applied.changed);
  return applied.changed ? { result: "applied", send: applied.send } : { result: "no_change", send: applied.send };
}

/** Replay events that arrived before the send knew its message id. */
export function applyOrphans(store: Store, send: SendRow): number {
  if (send.wamid === null) return 0;
  let applied = 0;
  for (const row of store.orphanEvents(send.tenantId, send.wamid)) {
    const current = store.getSend(send.id)!;
    const d = decideDelivery(current, { status: row.status, ts: row.ts, errors: row.errorCode !== null ? [{ code: row.errorCode, title: row.errorTitle ?? "", error_data: { details: row.errorDetails ?? "" } }] : [] });
    const changed = isChanged(current, d);
    if (changed) {
      store.updateDelivery(send.id, {
        status: d.status,
        sentAt: d.sentAt,
        deliveredAt: d.deliveredAt,
        readAt: d.readAt,
        failedAt: d.failedAt,
        deliveredImplied: d.deliveredImplied,
        error: d.error,
      });
      applied++;
    }
    store.markEvent(row.id, send.id, changed);
  }
  return applied;
}
