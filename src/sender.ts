// The sender: document sends by WhatsApp template or document message, idempotent per (tenant, document, recipient),
// with per-tenant phone_number_id and token, retry with backoff, and plain-language errors.
//
// What the docs do NOT give us (see README Limits): an idempotency key on the Messages API. The idempotency here is
// local: a row is reserved in the database BEFORE the request, keyed by (tenant, document, recipient). A request whose
// outcome is unknown (timeout, 5xx without an error body) cannot be proven not to have created a message; the kit
// sends `biz_opaque_callback_data` with a reference so that a later status webhook can link the message back.

import { createHash } from "node:crypto";
import { isWindowOpen } from "./inbound.ts";
import { contactKeyFor } from "./inbound.ts";
import {
  nowSec,
  type DocType,
  type SendRow,
  type Store,
  type Tenant,
} from "./db.ts";
import {
  buildDocumentMessage,
  buildTemplateMessage,
  buildTextMessage,
  checkDocument,
  documentProblem,
  type DocumentSource,
  type MediaRef,
} from "./payloads.ts";
import { asCountryCode, matchKey, normalizePhone, type Bilingual, type PhoneError } from "./phone.ts";
import { applyOrphans } from "./statuses.ts";
import { FREEFORM, templateFor } from "./templates.ts";
import { errorDetails, mapWhatsAppError, type ErrorAction, type WhatsAppApiError } from "./whatsapp-errors.ts";

export type SendOutcome =
  | "sent" // the API accepted the request in this call
  | "duplicate" // this (tenant, document, recipient) already has a WhatsApp message id
  | "in_flight" // another call is making the request right now
  | "in_doubt" // an earlier request may or may not have created a message
  | "blocked_opt_out"
  | "invalid_number"
  | "invalid_document"
  | "outside_window"
  | "failed";

export interface SendResult {
  outcome: SendOutcome;
  send: SendRow | null;
  /** Plain-language text for a button toast or a log line. */
  message: Bilingual;
  error?: { code: number | null; key: string; retryable: boolean; action: ErrorAction } | undefined;
  phoneError?: PhoneError | undefined;
}

export interface SenderOptions {
  store: Store;
  fetch?: typeof fetch;
  baseUrl?: string;
  graphVersion?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Retries after the first attempt (default 3, so at most 4 requests). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * After a timeout, a dropped connection or a 5xx without a parseable error, WhatsApp may or may not have created the
   * message. true (default): retry anyway, as for 429/5xx in general. false: stop and mark the send "unknown".
   */
  retryAmbiguous?: boolean;
  requestTimeoutMs?: number;
  /** A pending send older than this is treated as a dead worker (default 300 s). */
  pendingStaleSeconds?: number;
  /** Uploaded media ids expire after 30 days (docs); cache them for less (default 29 days). */
  mediaTtlSeconds?: number;
}

export interface SendDocumentInput {
  tenantId: string;
  documentId: string;
  docType: DocType;
  /** as typed by a person: "+54 9 11 5555-1234", "011 15 5555 1234", ... */
  to: string;
  document: DocumentSource;
  recipientName: string;
  documentNumber: string;
  businessName?: string | undefined;
  caption?: string | undefined;
  /** auto: free-form document inside the 24 h window, template otherwise. */
  mode?: "auto" | "template" | "freeform" | undefined;
  /** Allow a second message for the same document and recipient (a deliberate "send again"). */
  resend?: boolean | undefined;
  /** Allow retrying a send whose earlier outcome is unknown. */
  retryInDoubt?: boolean | undefined;
  defaultCountry?: string | undefined;
}

const MSG = {
  sent: { es: "Enviado a WhatsApp. El estado de entrega se actualizará solo.", en: "Sent to WhatsApp. The delivery status will update by itself." },
  duplicate: {
    es: "Este documento ya se envió a ese número por WhatsApp; no se envió de nuevo.",
    en: "This document was already sent to that number by WhatsApp; it was not sent again.",
  },
  in_flight: { es: "Ya hay un envío en curso para este documento y este número.", en: "A send is already in progress for this document and number." },
  in_doubt: {
    es: "Un intento anterior no confirmó si el mensaje salió. Revise el estado antes de reenviar para no duplicarlo.",
    en: "An earlier attempt did not confirm whether the message went out. Check its status before sending again to avoid a duplicate.",
  },
  blocked_opt_out: {
    es: "Este número pidió no recibir mensajes por WhatsApp (BAJA). No se envió.",
    en: "This number asked not to receive WhatsApp messages (STOP). Nothing was sent.",
  },
  outside_window: {
    es: "Pasaron más de 24 horas desde el último mensaje de la persona: solo puede enviarse una plantilla aprobada.",
    en: "More than 24 hours have passed since the person last wrote: only an approved template can be sent.",
  },
  network: {
    es: "No se pudo comunicar con WhatsApp (red o tiempo de espera agotado).",
    en: "Could not reach WhatsApp (network error or timeout).",
  },
  unexpected: {
    es: "WhatsApp respondió de una forma inesperada.",
    en: "WhatsApp answered in an unexpected way.",
  },
  throttled: {
    es: "WhatsApp pidió reducir la velocidad de envío (HTTP 429).",
    en: "WhatsApp asked to slow down (HTTP 429).",
  },
} satisfies Record<string, Bilingual>;

type Reply =
  | { kind: "ok"; status: number; json: Record<string, unknown> }
  | { kind: "api_error"; status: number; error: WhatsAppApiError; retryAfterMs: number | null }
  | { kind: "unparseable"; status: number; text: string; retryAfterMs: number | null }
  | { kind: "network"; message: string };

interface Classified {
  retry: boolean;
  /** the message may exist even though the call failed */
  ambiguous: boolean;
  error: { code: number | null; key: string; retryable: boolean; action: ErrorAction; details: string; es: string; en: string };
}

function classify(reply: Exclude<Reply, { kind: "ok" }>): Classified {
  if (reply.kind === "network") {
    return {
      retry: true,
      ambiguous: true,
      error: { code: null, key: "network", retryable: true, action: "retry_later", details: reply.message, ...MSG.network },
    };
  }
  if (reply.kind === "api_error") {
    const info = mapWhatsAppError(reply.error.code);
    const retry = reply.status === 429 || reply.status >= 500 || info.retryable;
    return {
      retry,
      ambiguous: false,
      error: { code: info.code === -1 ? null : info.code, key: info.key, retryable: retry, action: info.action, details: errorDetails(reply.error), es: info.es, en: info.en },
    };
  }
  // no parseable error body
  const throttled = reply.status === 429;
  const serverSide = reply.status >= 500;
  const accepted2xx = reply.status >= 200 && reply.status < 300;
  return {
    retry: !accepted2xx && (throttled || serverSide),
    ambiguous: accepted2xx || serverSide,
    error: {
      code: null,
      key: throttled ? "throttled" : "unexpected_response",
      retryable: throttled || serverSide,
      action: throttled || serverSide ? "retry_later" : "contact_support",
      details: `HTTP ${reply.status} ${reply.text.slice(0, 200)}`.trim(),
      ...(throttled ? MSG.throttled : MSG.unexpected),
    },
  };
}

export function unknownTenantError(id: string): Error {
  const err = new Error(`unknown tenant: ${id}`);
  err.name = "UnknownTenantError";
  return err;
}

export class WhatsAppSender {
  readonly store: Store;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly retryAmbiguous: boolean;
  private readonly timeoutMs: number;
  private readonly staleSeconds: number;
  private readonly mediaTtl: number;

  constructor(o: SenderOptions) {
    this.store = o.store;
    this.fetchFn = o.fetch ?? fetch;
    this.baseUrl = (o.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.version = o.graphVersion ?? "v26.0";
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.maxRetries = o.maxRetries ?? 3;
    this.baseDelayMs = o.baseDelayMs ?? 500;
    this.maxDelayMs = o.maxDelayMs ?? 8000;
    this.retryAmbiguous = o.retryAmbiguous ?? true;
    this.timeoutMs = o.requestTimeoutMs ?? 15_000;
    this.staleSeconds = o.pendingStaleSeconds ?? 300;
    this.mediaTtl = o.mediaTtlSeconds ?? 29 * 24 * 3600;
  }

  private requireTenant(id: string): Tenant {
    const t = this.store.getTenant(id);
    if (!t) throw unknownTenantError(id);
    return t;
  }

  /** delay before retry number `attempt` (1 = after the first failure), exponential with +-20 % jitter */
  backoffMs(attempt: number, retryAfterMs: number | null): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exp * (0.8 + 0.4 * this.random()));
    return retryAfterMs !== null ? Math.max(jittered, Math.min(retryAfterMs, 60_000)) : jittered;
  }

  private async graph(tenant: Tenant, path: string, init: { body: NonNullable<RequestInit["body"]>; headers?: Record<string, string> }): Promise<Reply> {
    const url = `${this.baseUrl}/${this.version}/${tenant.phoneNumberId}/${path}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${tenant.accessToken}`, ...(init.headers ?? {}) },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { kind: "network", message: err instanceof Error ? err.message : String(err) };
    }
    const text = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
    if (res.ok && obj) return { kind: "ok", status: res.status, json: obj };
    const err = obj && typeof obj["error"] === "object" && obj["error"] !== null ? (obj["error"] as WhatsAppApiError) : undefined;
    if (err && typeof err.code === "number") return { kind: "api_error", status: res.status, error: err, retryAfterMs };
    return { kind: "unparseable", status: res.status, text, retryAfterMs };
  }

  /** Run a request, retrying as the policy says. Returns the last reply and why it stopped. */
  private async withRetries(
    run: () => Promise<Reply>,
    onAttempt: () => void,
    ambiguousRetryable: boolean,
  ): Promise<{ reply: Reply; classified: Classified | null }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      onAttempt();
      const reply = await run();
      if (reply.kind === "ok") return { reply, classified: null };
      const c = classify(reply);
      if (!c.retry) return { reply, classified: c };
      if (c.ambiguous && !ambiguousRetryable) return { reply, classified: c };
      if (attempt > this.maxRetries) return { reply, classified: c };
      await this.sleep(this.backoffMs(attempt, reply.kind === "api_error" || reply.kind === "unparseable" ? reply.retryAfterMs : null));
    }
  }

  // ---- media ---------------------------------------------------------------------------------------------------
  private async ensureMedia(
    tenant: Tenant,
    file: { bytes: Uint8Array; filename: string; mime: string },
    onAttempt: () => void,
  ): Promise<{ ok: true; id: string } | { ok: false; classified: Classified }> {
    const sha = createHash("sha256").update(file.bytes).digest("hex");
    const now = nowSec(this.store.clock);
    const cached = this.store.getCachedMedia(tenant.id, sha, file.filename, now);
    if (cached) return { ok: true, id: cached };

    const run = () => {
      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("type", file.mime);
      form.set("file", new Blob([Uint8Array.from(file.bytes)], { type: file.mime }), file.filename);
      return this.graph(tenant, "media", { body: form });
    };
    // an upload creates no message, so even an ambiguous failure is safe to repeat
    const { reply, classified } = await this.withRetries(run, onAttempt, true);
    if (reply.kind === "ok") {
      const id = reply.json["id"];
      if (typeof id === "string" && id !== "") {
        this.store.putCachedMedia(tenant.id, sha, file.filename, id, now + this.mediaTtl);
        return { ok: true, id };
      }
      return {
        ok: false,
        classified: { retry: false, ambiguous: false, error: { code: null, key: "unexpected_response", retryable: false, action: "contact_support", details: "upload answered without a media id", ...MSG.unexpected } },
      };
    }
    return { ok: false, classified: classified! };
  }

  // ---- document sends ------------------------------------------------------------------------------------------
  async sendDocument(input: SendDocumentInput): Promise<SendResult> {
    const tenant = this.requireTenant(input.tenantId);
    const store = this.store;

    const phone = normalizePhone(input.to, { defaultCountry: asCountryCode(input.defaultCountry ?? tenant.defaultCountry) });
    if (!phone.ok) return { outcome: "invalid_number", send: null, message: phone.message, phoneError: phone };

    const checked = checkDocument(input.document);
    if (!checked.ok) return { outcome: "invalid_document", send: null, message: checked.message };
    if (input.caption !== undefined && input.caption.length > 1024) {
      return { outcome: "invalid_document", send: null, message: documentProblem("caption_too_long").message };
    }

    const contactKey = matchKey(phone.digits);
    if (store.isOptedOut(tenant.id, contactKey)) return { outcome: "blocked_opt_out", send: null, message: MSG.blocked_opt_out };

    const nowS = nowSec(store.clock);
    const windowOpen = isWindowOpen(store, tenant.id, contactKey, nowS);
    const mode = input.mode ?? "auto";
    if (mode === "freeform" && !windowOpen) return { outcome: "outside_window", send: null, message: MSG.outside_window };
    const kind = mode === "template" ? "template" : windowOpen ? "document" : "template";

    const choice = templateFor(tenant, input.docType);
    const reserved = store.reserveSend({
      tenantId: tenant.id,
      documentId: input.documentId,
      docType: input.docType,
      recipientKey: contactKey,
      recipientE164: phone.e164,
      baseKey: `${tenant.id}|${input.documentId}|${contactKey}`,
      kind,
      templateName: kind === "template" ? choice.name : null,
      language: kind === "template" ? choice.language : null,
      filename: checked.filename,
      resend: input.resend === true,
    });

    let row = reserved.send;
    if (reserved.kind === "existing") {
      if (row.wamid !== null) return { outcome: "duplicate", send: row, message: MSG.duplicate };
      const stale = nowS - row.updatedAt >= this.staleSeconds;
      if (row.status === "pending" && !stale) return { outcome: "in_flight", send: row, message: MSG.in_flight };
      const inDoubt = row.status === "unknown" || (row.status === "pending" && stale);
      if (inDoubt && input.retryInDoubt !== true) return { outcome: "in_doubt", send: row, message: MSG.in_doubt };
      const claimed = store.claimForAttempt(row.id, { allowUnknown: input.retryInDoubt === true, stalePendingBefore: input.retryInDoubt === true ? nowS : nowS - this.staleSeconds });
      if (!claimed) return { outcome: "in_flight", send: store.getSend(row.id)!, message: MSG.in_flight };
      store.setRoute(row.id, { kind, templateName: kind === "template" ? choice.name : null, language: kind === "template" ? choice.language : null });
      row = store.getSend(row.id)!;
    }

    // ---- the media for the document -----------------------------------------------------------------------------
    const onAttempt = () => store.touchAttempt(row.id);
    let media: MediaRef;
    if (checked.source.kind === "link") {
      media = { link: checked.source.url };
    } else {
      const up = await this.ensureMedia(tenant, { bytes: checked.source.bytes, filename: checked.filename, mime: checked.mime }, onAttempt);
      if (!up.ok) {
        const failed = store.markFailedBeforeAccept(row.id, { code: up.classified.error.code, details: up.classified.error.details, es: up.classified.error.es, en: up.classified.error.en });
        return { outcome: "failed", send: failed, message: { es: up.classified.error.es, en: up.classified.error.en }, error: publicError(up.classified) };
      }
      media = { id: up.id };
      store.setMediaId(row.id, up.id);
    }

    // ---- the message ---------------------------------------------------------------------------------------------
    const business = input.businessName ?? tenant.name;
    const body =
      kind === "document"
        ? buildDocumentMessage({
            to: phone.e164,
            media,
            filename: checked.filename,
            caption: input.caption ?? FREEFORM[tenant.locale].caption(input.docType, input.documentNumber, business),
            ref: row.ref,
          })
        : buildTemplateMessage({
            to: phone.e164,
            name: choice.name,
            languageCode: choice.language,
            bodyParams: [oneLine(input.recipientName), oneLine(input.documentNumber), oneLine(business)],
            headerDocument: { media, filename: checked.filename },
            ref: row.ref,
          });

    return this.postMessage(tenant, row, body);
  }

  /** POST the message with retries and record the outcome. */
  private async postMessage(tenant: Tenant, row: SendRow, body: Record<string, unknown>): Promise<SendResult> {
    const store = this.store;
    const run = () => this.graph(tenant, "messages", { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const { reply, classified } = await this.withRetries(run, () => store.touchAttempt(row.id), this.retryAmbiguous);

    if (reply.kind === "ok") {
      const messages = reply.json["messages"];
      const first = Array.isArray(messages) ? (messages[0] as { id?: unknown } | undefined) : undefined;
      const contacts = reply.json["contacts"];
      const firstContact = Array.isArray(contacts) ? (contacts[0] as { wa_id?: unknown } | undefined) : undefined;
      if (first && typeof first.id === "string" && first.id !== "") {
        const waId = typeof firstContact?.wa_id === "string" ? firstContact.wa_id : null;
        const accepted = store.markAccepted(row.id, first.id, waId);
        applyOrphans(store, accepted);
        return { outcome: "sent", send: store.getSend(row.id)!, message: MSG.sent };
      }
      // 2xx but no message id: we cannot tell what happened
      const unknown = store.markUnknown(row.id, { details: "HTTP 2xx without a message id", ...MSG.unexpected });
      return { outcome: "in_doubt", send: unknown, message: MSG.in_doubt };
    }

    const c = classified!;
    if (c.ambiguous) {
      const unknown = store.markUnknown(row.id, { details: c.error.details, es: c.error.es, en: c.error.en });
      return { outcome: "in_doubt", send: unknown, message: MSG.in_doubt, error: publicError(c) };
    }
    const failed = store.markFailedBeforeAccept(row.id, { code: c.error.code, details: c.error.details, es: c.error.es, en: c.error.en });
    return { outcome: "failed", send: failed, message: { es: c.error.es, en: c.error.en }, error: publicError(c) };
  }

  // ---- free-form text (replies inside the 24 h window) ---------------------------------------------------------
  /**
   * Send a free-form text. Allowed only while the customer service window is open. `key` makes the send idempotent
   * (for example the id of the inbound message being answered).
   */
  async sendText(input: {
    tenantId: string;
    to?: string | undefined;
    bsuid?: string | undefined;
    body: string;
    key: string;
    /** confirmations of STOP / START are allowed to an opted-out number */
    purpose?: "reply" | "optout_ack" | "optin_ack" | undefined;
  }): Promise<SendResult> {
    const tenant = this.requireTenant(input.tenantId);
    const store = this.store;
    let e164: string | null = null;
    let phoneKey: string | null = null;
    if (input.to) {
      const phone = normalizePhone(input.to, { defaultCountry: asCountryCode(tenant.defaultCountry) });
      if (!phone.ok) return { outcome: "invalid_number", send: null, message: phone.message, phoneError: phone };
      e164 = phone.e164;
      phoneKey = matchKey(phone.digits);
    }
    const contactKey = contactKeyFor(store, tenant.id, { phone: phoneKey, bsuid: input.bsuid });
    if (contactKey === null) return { outcome: "invalid_number", send: null, message: { es: "Falta el destinatario.", en: "The recipient is missing." } };

    const purpose = input.purpose ?? "reply";
    if (purpose === "reply" && store.isOptedOut(tenant.id, contactKey)) return { outcome: "blocked_opt_out", send: null, message: MSG.blocked_opt_out };
    const nowS = nowSec(store.clock);
    if (!isWindowOpen(store, tenant.id, contactKey, nowS)) return { outcome: "outside_window", send: null, message: MSG.outside_window };

    const reserved = store.reserveSend({
      tenantId: tenant.id,
      documentId: null,
      docType: null,
      recipientKey: contactKey,
      recipientE164: e164 ?? "",
      baseKey: `${tenant.id}|text:${input.key}|${contactKey}`,
      kind: "text",
      templateName: null,
      language: null,
      filename: null,
      resend: false,
    });
    let row = reserved.send;
    if (reserved.kind === "existing") {
      if (row.wamid !== null) return { outcome: "duplicate", send: row, message: MSG.duplicate };
      if (row.status === "pending" && nowS - row.updatedAt < this.staleSeconds) return { outcome: "in_flight", send: row, message: MSG.in_flight };
      if (row.status === "unknown") return { outcome: "in_doubt", send: row, message: MSG.in_doubt };
      if (!store.claimForAttempt(row.id, { allowUnknown: false, stalePendingBefore: nowS - this.staleSeconds })) return { outcome: "in_flight", send: row, message: MSG.in_flight };
      row = store.getSend(row.id)!;
    }
    const body = buildTextMessage({ ...(e164 ? { to: e164 } : { recipient: input.bsuid! }), body: input.body, ref: row.ref });
    return this.postMessage(tenant, row, body);
  }
}

function publicError(c: Classified): NonNullable<SendResult["error"]> {
  return { code: c.error.code, key: c.error.key, retryable: c.error.retryable, action: c.error.action };
}

/** Template variables: collapse newlines, tabs and runs of spaces (conservative; the docs only say values must match the template format). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
