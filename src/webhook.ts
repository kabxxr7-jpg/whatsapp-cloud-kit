// Framework-agnostic webhook handling: GET verification, POST signature check on the raw body, routing to the tenant by
// metadata.phone_number_id, status events into the send log, inbound messages into the window / opt-out state.
//
// Response policy (docs: "respond with HTTP status 200 ... otherwise a 400-level status or anything other than 200",
// failures are retried for up to 7 days):
//   no signature header or a malformed one   401
//   signature does not match any secret      403
//   signed, but not JSON                     400
//   signed, but a payload timestamp is outside the age window (replay or clock problem)   400
//   signed with a secret that is not allowed to speak for that tenant                      403
//   signed, valid, but for a phone_number_id we do not know, or a field we do not handle    200 (counted, never retried)
//   storage error while processing           500 (Meta retries; every step is idempotent)

import { type Clock, type Store, nowSec } from "./db.ts";
import { DEFAULT_KEYWORDS, processInbound, type KeywordConfig } from "./inbound.ts";
import { matchKey } from "./phone.ts";
import type { WhatsAppSender } from "./sender.ts";
import { verifySignature, safeEqualStrings, type SecretEntry } from "./signature.ts";
import { applyStatusEvent } from "./statuses.ts";
import { FREEFORM } from "./templates.ts";
import type { WhatsAppApiError } from "./whatsapp-errors.ts";

export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024; // docs: "Webhook payloads can be up to 3 MB"
export const DEFAULT_MAX_EVENT_AGE_SECONDS = 8 * 24 * 3600; // docs say retries run 7 days (an older page says 36 hours)
export const DEFAULT_MAX_FUTURE_SECONDS = 300;

export interface WebhookConfig {
  store: Store;
  secrets: readonly SecretEntry[];
  verifyToken: string | readonly string[];
  /** If set, STOP and START are answered with a confirmation (free-form text, allowed because the user just wrote). */
  sender?: WhatsAppSender | undefined;
  confirmOptChanges?: boolean | undefined;
  keywords?: KeywordConfig | undefined;
  maxEventAgeSeconds?: number | undefined;
  maxFutureSeconds?: number | undefined;
  clock?: Clock | undefined;
}

export interface WebhookResponse {
  status: number;
  contentType: "application/json" | "text/plain";
  body: unknown;
  /** Work started after the answer (confirmation messages). Await it in tests; never block the HTTP answer on it. */
  pending?: Promise<unknown>;
}

export interface EventCounts {
  statuses: number;
  statusDuplicates: number;
  statusOrphans: number;
  statusOtherTenant: number;
  statusExtraMessages: number;
  inbound: number;
  inboundDuplicates: number;
  optOuts: number;
  optIns: number;
  unrouted: number;
  ignoredFields: number;
  accountErrors: number;
  malformed: number;
}

function emptyCounts(): EventCounts {
  return {
    statuses: 0,
    statusDuplicates: 0,
    statusOrphans: 0,
    statusOtherTenant: 0,
    statusExtraMessages: 0,
    inbound: 0,
    inboundDuplicates: 0,
    optOuts: 0,
    optIns: 0,
    unrouted: 0,
    ignoredFields: 0,
    accountErrors: 0,
    malformed: 0,
  };
}

// ---- GET: verification -------------------------------------------------------------------------------------------
export function handleVerification(query: URLSearchParams, config: Pick<WebhookConfig, "verifyToken">): WebhookResponse {
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (mode !== "subscribe" || token === null || challenge === null) {
    return { status: 400, contentType: "application/json", body: { error: "bad_verification_request" } };
  }
  const accepted = Array.isArray(config.verifyToken) ? config.verifyToken : [config.verifyToken as string];
  let match = false;
  for (const t of accepted) if (safeEqualStrings(t, token)) match = true;
  if (!match) return { status: 403, contentType: "application/json", body: { error: "verify_token_mismatch" } };
  // The docs: respond with HTTP 200 and the hub.challenge value. Echoed verbatim as plain text, not wrapped in JSON.
  return { status: 200, contentType: "text/plain", body: challenge };
}

// ---- POST: events ------------------------------------------------------------------------------------------------
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function seconds(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface Routed {
  tenantId: string;
  value: Json;
}

export async function handleEvent(
  input: { rawBody: Uint8Array; headers: Record<string, string | string[] | undefined> },
  config: WebhookConfig,
): Promise<WebhookResponse> {
  const store = config.store;
  const clock = config.clock ?? store.clock;

  // 1. signature, over the raw bytes
  const sig = verifySignature({ rawBody: input.rawBody, header: header(input.headers, "x-hub-signature-256"), secrets: config.secrets });
  if (!sig.ok) {
    const status = sig.reason === "missing_header" || sig.reason === "malformed_header" ? 401 : 403;
    return { status, contentType: "application/json", body: { error: "invalid_signature", reason: sig.reason } };
  }

  // 2. JSON
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
  } catch {
    return { status: 400, contentType: "application/json", body: { error: "invalid_json" } };
  }
  if (!isObj(payload) || payload["object"] !== "whatsapp_business_account") {
    return { status: 200, contentType: "application/json", body: { received: true, ignored: "unexpected_object" } };
  }

  // 3. collect the changes of the `messages` field, route them to tenants, check timestamps
  const counts = emptyCounts();
  const routed: Routed[] = [];
  const now = nowSec(clock);
  const maxAge = config.maxEventAgeSeconds ?? DEFAULT_MAX_EVENT_AGE_SECONDS;
  const maxFuture = config.maxFutureSeconds ?? DEFAULT_MAX_FUTURE_SECONDS;

  for (const entry of arr(payload["entry"])) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry["changes"])) {
      if (!isObj(change)) continue;
      if (change["field"] !== "messages" || !isObj(change["value"])) {
        counts.ignoredFields++;
        continue;
      }
      const value = change["value"];
      const metadata = isObj(value["metadata"]) ? value["metadata"] : {};
      const phoneNumberId = str(metadata["phone_number_id"]);
      const tenant = phoneNumberId ? store.tenantByPhoneNumberId(phoneNumberId) : undefined;
      if (!tenant) {
        counts.unrouted++;
        continue;
      }
      if (sig.entry.tenants !== undefined && !sig.entry.tenants.includes(tenant.id)) {
        return { status: 403, contentType: "application/json", body: { error: "secret_not_allowed_for_tenant" } };
      }
      for (const item of [...arr(value["statuses"]), ...arr(value["messages"])]) {
        if (!isObj(item)) continue;
        const ts = seconds(item["timestamp"]);
        if (ts !== null && (now - ts > maxAge || ts - now > maxFuture)) {
          return { status: 400, contentType: "application/json", body: { error: "stale_event", timestamp: ts } };
        }
      }
      routed.push({ tenantId: tenant.id, value });
    }
  }

  // 4. process
  const pending: Promise<unknown>[] = [];
  try {
    for (const { tenantId, value } of routed) processValue(config, tenantId, value, counts, pending);
  } catch {
    return { status: 500, contentType: "application/json", body: { error: "processing_failed" } };
  }
  const response: WebhookResponse = { status: 200, contentType: "application/json", body: { received: true, counts } };
  if (pending.length > 0) response.pending = Promise.allSettled(pending);
  return response;
}

function processValue(config: WebhookConfig, tenantId: string, value: Json, counts: EventCounts, pending: Promise<unknown>[]): void {
  const store = config.store;

  // contacts[] pair a wa_id with a business-scoped user id: remember it so a later message with only the id still matches
  for (const c of arr(value["contacts"])) {
    if (!isObj(c)) continue;
    const waId = str(c["wa_id"]);
    const userId = str(c["user_id"]);
    if (waId && userId) store.linkIdentity(tenantId, userId, matchKey(waId));
  }

  if (arr(value["errors"]).length > 0) counts.accountErrors += arr(value["errors"]).length;

  for (const s of arr(value["statuses"])) {
    if (!isObj(s)) {
      counts.malformed++;
      continue;
    }
    const wamid = str(s["id"]);
    const status = str(s["status"]);
    const ts = seconds(s["timestamp"]);
    if (!wamid || !status || ts === null) {
      counts.malformed++;
      continue;
    }
    const recipientId = str(s["recipient_id"]);
    const recipientUserId = str(s["recipient_user_id"]);
    if (recipientId && recipientUserId) store.linkIdentity(tenantId, recipientUserId, matchKey(recipientId));
    const result = applyStatusEvent(store, {
      tenantId,
      wamid,
      status,
      ts,
      recipientId,
      ref: str(s["biz_opaque_callback_data"]),
      errors: arr(s["errors"]).filter(isObj) as WhatsAppApiError[],
      raw: s,
    });
    switch (result.result) {
      case "duplicate":
        counts.statusDuplicates++;
        break;
      case "orphan":
        counts.statusOrphans++;
        counts.statuses++;
        break;
      case "other_tenant":
        counts.statusOtherTenant++;
        break;
      case "extra_message":
        counts.statusExtraMessages++;
        counts.statuses++;
        break;
      default:
        counts.statuses++;
    }
  }

  for (const m of arr(value["messages"])) {
    if (!isObj(m)) {
      counts.malformed++;
      continue;
    }
    const wamid = str(m["id"]);
    const ts = seconds(m["timestamp"]);
    const type = str(m["type"]) ?? "unknown";
    if (!wamid || ts === null) {
      counts.malformed++;
      continue;
    }
    const text = type === "text" && isObj(m["text"]) ? str(m["text"]["body"]) : null;
    const from = str(m["from"]);
    const fromUserId = str(m["from_user_id"]);
    const result = processInbound(store, tenantId, { wamid, ts, type, from, fromUserId, text }, config.keywords ?? DEFAULT_KEYWORDS);
    if (result.duplicate) {
      counts.inboundDuplicates++;
      continue;
    }
    counts.inbound++;
    if (result.action === "opt_out") counts.optOuts++;
    if (result.action === "opt_in") counts.optIns++;

    if (result.action && config.sender && config.confirmOptChanges !== false) {
      const tenant = store.getTenant(tenantId)!;
      const copy = FREEFORM[tenant.locale];
      const body = result.action === "opt_out" ? copy.optOutConfirmation : copy.optInConfirmation;
      const target = from ? { to: "+" + from } : { bsuid: fromUserId ?? undefined };
      pending.push(
        config.sender
          .sendText({ tenantId, ...target, body, key: `ack:${wamid}`, purpose: result.action === "opt_out" ? "optout_ack" : "optin_ack" })
          .catch(() => undefined),
      );
    }
  }
}

