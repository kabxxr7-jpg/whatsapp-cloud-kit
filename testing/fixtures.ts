// Signed webhook fixtures. The JSON shapes follow Meta's "webhooks/reference/messages" and ".../messages/status" pages
// (docs/SOURCES.md). They are hand-built from the documentation, NOT recorded from a real WhatsApp account.

import { computeSignature } from "../src/signature.ts";

export type StatusName = "sent" | "delivered" | "read" | "failed" | "played";

export interface StatusInput {
  wamid: string;
  status: StatusName;
  /** unix seconds */
  ts: number;
  recipientId?: string | undefined;
  recipientUserId?: string | undefined;
  ref?: string | undefined;
  errorCode?: number | undefined;
  errorTitle?: string | undefined;
  errorDetails?: string | undefined;
  /** add the `pricing` object the docs show on sent and delivered/read statuses */
  pricing?: boolean | undefined;
}

export function statusEntry(s: StatusInput): Record<string, unknown> {
  const out: Record<string, unknown> = { id: s.wamid, status: s.status, timestamp: String(s.ts) };
  if (s.recipientId !== undefined) out["recipient_id"] = s.recipientId;
  if (s.recipientUserId !== undefined) out["recipient_user_id"] = s.recipientUserId;
  if (s.ref !== undefined) out["biz_opaque_callback_data"] = s.ref;
  if (s.pricing) out["pricing"] = { billable: true, pricing_model: "PMP", type: "regular", category: "utility" };
  if (s.status === "failed") {
    const title = s.errorTitle ?? "Message undeliverable";
    out["errors"] = [
      {
        code: s.errorCode ?? 131026,
        title,
        message: title,
        error_data: { details: s.errorDetails ?? "Message Undeliverable." },
        href: "/documentation/business-messaging/whatsapp/support/error-codes",
      },
    ];
  }
  return out;
}

export interface Envelope {
  phoneNumberId: string;
  displayPhone?: string | undefined;
  wabaId?: string | undefined;
}

function envelope(e: Envelope, value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: e.wabaId ?? "200000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: e.displayPhone ?? "5491155550000", phone_number_id: e.phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(e: Envelope, statuses: StatusInput[]): Record<string, unknown> {
  return envelope(e, { statuses: statuses.map(statusEntry) });
}

export interface InboundInput {
  from?: string | undefined;
  fromUserId?: string | undefined;
  name?: string | undefined;
  wamid: string;
  ts: number;
  type?: string | undefined;
  text?: string | undefined;
}

export function inboundPayload(e: Envelope, m: InboundInput): Record<string, unknown> {
  const type = m.type ?? "text";
  const message: Record<string, unknown> = { id: m.wamid, timestamp: String(m.ts), type };
  if (m.from !== undefined) message["from"] = m.from;
  if (m.fromUserId !== undefined) message["from_user_id"] = m.fromUserId;
  if (type === "text") message["text"] = { body: m.text ?? "" };
  const contact: Record<string, unknown> = { profile: { name: m.name ?? "Cliente" } };
  if (m.from !== undefined) contact["wa_id"] = m.from;
  if (m.fromUserId !== undefined) contact["user_id"] = m.fromUserId;
  return envelope(e, { contacts: [contact], messages: [message] });
}

export interface SignedRequest {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** Serialise and sign. The signature covers exactly these bytes, as Meta's does. */
export function sign(secret: string, payload: unknown, options: { pretty?: boolean } = {}): SignedRequest {
  const text = typeof payload === "string" ? payload : options.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const rawBody = Buffer.from(text, "utf8");
  return {
    rawBody,
    headers: { "content-type": "application/json", "x-hub-signature-256": computeSignature(secret, rawBody) },
  };
}

export function verifyQuery(token: string, challenge = "1158201444"): URLSearchParams {
  return new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": challenge });
}
