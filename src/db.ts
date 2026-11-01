// SQLite storage (node:sqlite, no native build). All timestamps are unix SECONDS.

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type Clock = () => number; // milliseconds, like Date.now
export const systemClock: Clock = () => Date.now();
export function nowSec(clock: Clock): number {
  return Math.floor(clock() / 1000);
}

export type DocType = "budget" | "invoice" | "purchase_order";
export type SendKind = "template" | "document" | "text";
/**
 * pending   - request being made (or a worker died mid-request)
 * unknown   - the request failed in a way that does not tell us whether WhatsApp created the message
 * accepted  - the API answered with a message id; no status webhook yet
 * sent / delivered / read - from status webhooks
 * failed    - rejected by the API (no message id) or reported failed by a webhook
 */
export type SendStatus = "pending" | "unknown" | "accepted" | "sent" | "delivered" | "read" | "failed";

export interface TemplateChoice {
  name: string;
  language: string;
}

export interface Tenant {
  id: string;
  name: string;
  phoneNumberId: string;
  accessToken: string;
  wabaId: string | null;
  defaultCountry: string | null;
  locale: "es" | "en";
  /** per document type; falls back to the kit's default template names */
  templates: Partial<Record<DocType, TemplateChoice>>;
}

export interface SendRow {
  id: number;
  ref: string;
  tenantId: string;
  documentId: string | null;
  docType: string | null;
  recipientKey: string;
  recipientE164: string;
  baseKey: string;
  idempotencyKey: string;
  seq: number;
  kind: SendKind;
  templateName: string | null;
  language: string | null;
  filename: string | null;
  mediaId: string | null;
  status: SendStatus;
  wamid: string | null;
  waId: string | null;
  attempts: number;
  errorCode: number | null;
  errorDetails: string | null;
  errorEs: string | null;
  errorEn: string | null;
  doubleSendSuspected: boolean;
  deliveredImplied: boolean;
  createdAt: number;
  updatedAt: number;
  acceptedAt: number | null;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
}

export interface StatusEventRow {
  id: number;
  tenantId: string;
  wamid: string;
  status: string;
  ts: number;
  recipientId: string | null;
  ref: string | null;
  errorCode: number | null;
  errorTitle: string | null;
  errorDetails: string | null;
  sendId: number | null;
  applied: boolean;
  receivedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  waba_id TEXT,
  default_country TEXT,
  locale TEXT NOT NULL DEFAULT 'es',
  templates_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  document_id TEXT,
  doc_type TEXT,
  recipient_key TEXT NOT NULL,
  recipient_e164 TEXT NOT NULL,
  base_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  template_name TEXT,
  language TEXT,
  filename TEXT,
  media_id TEXT,
  status TEXT NOT NULL,
  wamid TEXT UNIQUE,
  wa_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code INTEGER,
  error_details TEXT,
  error_es TEXT,
  error_en TEXT,
  double_send_suspected INTEGER NOT NULL DEFAULT 0,
  delivered_implied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  sent_at INTEGER,
  delivered_at INTEGER,
  read_at INTEGER,
  failed_at INTEGER
);
CREATE INDEX IF NOT EXISTS sends_by_document ON sends (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS sends_by_base ON sends (base_key, seq);

CREATE TABLE IF NOT EXISTS send_extras (
  send_id INTEGER NOT NULL REFERENCES sends(id),
  wamid TEXT NOT NULL,
  PRIMARY KEY (send_id, wamid)
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  wamid TEXT NOT NULL,
  status TEXT NOT NULL,
  ts INTEGER NOT NULL,
  recipient_id TEXT,
  ref TEXT,
  error_code INTEGER,
  error_title TEXT,
  error_details TEXT,
  raw_json TEXT NOT NULL,
  send_id INTEGER,
  applied INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  UNIQUE (tenant_id, wamid, status, ts)
);
CREATE INDEX IF NOT EXISTS status_events_by_wamid ON status_events (wamid);

CREATE TABLE IF NOT EXISTS conversations (
  tenant_id TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  last_inbound_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, contact_key)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  tenant_id TEXT NOT NULL,
  wamid TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  keyword TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, wamid)
);

CREATE TABLE IF NOT EXISTS opt_outs (
  tenant_id TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  opted_out_at INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  source_wamid TEXT,
  PRIMARY KEY (tenant_id, contact_key)
);

CREATE TABLE IF NOT EXISTS opt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  event TEXT NOT NULL,
  keyword TEXT,
  wamid TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_links (
  tenant_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bsuid)
);

CREATE TABLE IF NOT EXISTS media_cache (
  tenant_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, sha256, filename)
);
`;

type Row = Record<string, unknown>;

function mapSend(r: Row): SendRow {
  return {
    id: r["id"] as number,
    ref: r["ref"] as string,
    tenantId: r["tenant_id"] as string,
    documentId: (r["document_id"] as string | null) ?? null,
    docType: (r["doc_type"] as string | null) ?? null,
    recipientKey: r["recipient_key"] as string,
    recipientE164: r["recipient_e164"] as string,
    baseKey: r["base_key"] as string,
    idempotencyKey: r["idempotency_key"] as string,
    seq: r["seq"] as number,
    kind: r["kind"] as SendKind,
    templateName: (r["template_name"] as string | null) ?? null,
    language: (r["language"] as string | null) ?? null,
    filename: (r["filename"] as string | null) ?? null,
    mediaId: (r["media_id"] as string | null) ?? null,
    status: r["status"] as SendStatus,
    wamid: (r["wamid"] as string | null) ?? null,
    waId: (r["wa_id"] as string | null) ?? null,
    attempts: r["attempts"] as number,
    errorCode: (r["error_code"] as number | null) ?? null,
    errorDetails: (r["error_details"] as string | null) ?? null,
    errorEs: (r["error_es"] as string | null) ?? null,
    errorEn: (r["error_en"] as string | null) ?? null,
    doubleSendSuspected: r["double_send_suspected"] === 1,
    deliveredImplied: r["delivered_implied"] === 1,
    createdAt: r["created_at"] as number,
    updatedAt: r["updated_at"] as number,
    acceptedAt: (r["accepted_at"] as number | null) ?? null,
    sentAt: (r["sent_at"] as number | null) ?? null,
    deliveredAt: (r["delivered_at"] as number | null) ?? null,
    readAt: (r["read_at"] as number | null) ?? null,
    failedAt: (r["failed_at"] as number | null) ?? null,
  };
}

function mapTenant(r: Row): Tenant {
  const templates = r["templates_json"] ? (JSON.parse(r["templates_json"] as string) as Tenant["templates"]) : {};
  return {
    id: r["id"] as string,
    name: r["name"] as string,
    phoneNumberId: r["phone_number_id"] as string,
    accessToken: r["access_token"] as string,
    wabaId: (r["waba_id"] as string | null) ?? null,
    defaultCountry: (r["default_country"] as string | null) ?? null,
    locale: r["locale"] === "en" ? "en" : "es",
    templates,
  };
}

function mapEvent(r: Row): StatusEventRow {
  return {
    id: r["id"] as number,
    tenantId: r["tenant_id"] as string,
    wamid: r["wamid"] as string,
    status: r["status"] as string,
    ts: r["ts"] as number,
    recipientId: (r["recipient_id"] as string | null) ?? null,
    ref: (r["ref"] as string | null) ?? null,
    errorCode: (r["error_code"] as number | null) ?? null,
    errorTitle: (r["error_title"] as string | null) ?? null,
    errorDetails: (r["error_details"] as string | null) ?? null,
    sendId: (r["send_id"] as number | null) ?? null,
    applied: r["applied"] === 1,
    receivedAt: r["received_at"] as number,
  };
}

export interface NewSend {
  tenantId: string;
  documentId: string | null;
  docType: string | null;
  recipientKey: string;
  recipientE164: string;
  /** Idempotency key base, e.g. "tenant|document|recipient". */
  baseKey: string;
  kind: SendKind;
  templateName: string | null;
  language: string | null;
  filename: string | null;
  /** Allow a new send when the latest one for this key already has a message id (or failed). */
  resend: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  readonly clock: Clock;

  constructor(path = ":memory:", clock: Clock = systemClock) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return nowSec(this.clock);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- tenants ------------------------------------------------------------------------------------------------
  upsertTenant(t: {
    id: string;
    name: string;
    phoneNumberId: string;
    accessToken: string;
    wabaId?: string | null | undefined;
    defaultCountry?: string | null | undefined;
    locale?: "es" | "en" | undefined;
    templates?: Tenant["templates"] | undefined;
  }): Tenant {
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, phone_number_id, access_token, waba_id, default_country, locale, templates_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, phone_number_id = excluded.phone_number_id,
           access_token = excluded.access_token, waba_id = excluded.waba_id, default_country = excluded.default_country,
           locale = excluded.locale, templates_json = excluded.templates_json`,
      )
      .run(
        t.id,
        t.name,
        t.phoneNumberId,
        t.accessToken,
        t.wabaId ?? null,
        t.defaultCountry ?? null,
        t.locale ?? "es",
        t.templates ? JSON.stringify(t.templates) : null,
        this.now(),
      );
    return this.getTenant(t.id)!;
  }

  getTenant(id: string): Tenant | undefined {
    const r = this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Row | undefined;
    return r ? mapTenant(r) : undefined;
  }

  tenantByPhoneNumberId(phoneNumberId: string): Tenant | undefined {
    const r = this.db.prepare("SELECT * FROM tenants WHERE phone_number_id = ?").get(phoneNumberId) as Row | undefined;
    return r ? mapTenant(r) : undefined;
  }

  listTenants(): Tenant[] {
    return (this.db.prepare("SELECT * FROM tenants ORDER BY id").all() as Row[]).map(mapTenant);
  }

  // ---- sends --------------------------------------------------------------------------------------------------
  getSend(id: number): SendRow | undefined {
    const r = this.db.prepare("SELECT * FROM sends WHERE id = ?").get(id) as Row | undefined;
    return r ? mapSend(r) : undefined;
  }

  getSendByWamid(tenantId: string, wamid: string): SendRow | undefined {
    const r = this.db.prepare("SELECT * FROM sends WHERE tenant_id = ? AND wamid = ?").get(tenantId, wamid) as Row | undefined;
    return r ? mapSend(r) : undefined;
  }

  /** Any tenant: used only to detect a message id that belongs to somebody else. */
  getSendByWamidAnyTenant(wamid: string): SendRow | undefined {
    const r = this.db.prepare("SELECT * FROM sends WHERE wamid = ?").get(wamid) as Row | undefined;
    return r ? mapSend(r) : undefined;
  }

  getSendByRef(tenantId: string, ref: string): SendRow | undefined {
    const r = this.db.prepare("SELECT * FROM sends WHERE tenant_id = ? AND ref = ?").get(tenantId, ref) as Row | undefined;
    return r ? mapSend(r) : undefined;
  }

  listSendsForDocument(tenantId: string, documentId: string): SendRow[] {
    return (
      this.db.prepare("SELECT * FROM sends WHERE tenant_id = ? AND document_id = ? ORDER BY id").all(tenantId, documentId) as Row[]
    ).map(mapSend);
  }

  listSends(tenantId: string): SendRow[] {
    return (this.db.prepare("SELECT * FROM sends WHERE tenant_id = ? ORDER BY id").all(tenantId) as Row[]).map(mapSend);
  }

  /**
   * Reserve the right to send. Exactly one caller gets `created` for a given (tenant, document, recipient) unless
   * `resend` is set and the latest send is already finished; everybody else gets the existing row back.
   */
  reserveSend(n: NewSend): { kind: "created" | "existing"; send: SendRow } {
    return this.tx(() => {
      const latest = this.db
        .prepare("SELECT * FROM sends WHERE base_key = ? ORDER BY seq DESC LIMIT 1")
        .get(n.baseKey) as Row | undefined;
      if (latest) {
        const row = mapSend(latest);
        const finished = row.wamid !== null || row.status === "failed";
        if (!(n.resend && finished)) return { kind: "existing" as const, send: row };
      }
      const seq = latest ? (latest["seq"] as number) + 1 : 1;
      const key = seq === 1 ? n.baseKey : `${n.baseKey}#${seq}`;
      const ts = this.now();
      const ref = "ws_" + randomBytes(12).toString("hex");
      const info = this.db
        .prepare(
          `INSERT INTO sends (ref, tenant_id, document_id, doc_type, recipient_key, recipient_e164, base_key, idempotency_key,
             seq, kind, template_name, language, filename, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(ref, n.tenantId, n.documentId, n.docType, n.recipientKey, n.recipientE164, n.baseKey, key, seq, n.kind, n.templateName, n.language, n.filename, ts, ts);
      return { kind: "created" as const, send: this.getSend(Number(info.lastInsertRowid))! };
    });
  }

  /**
   * Take over a send that is not running: a failed one (no message id), an unknown one, or a pending one whose worker
   * apparently died. Returns false if somebody else got there first or the row does not qualify.
   */
  claimForAttempt(id: number, opts: { allowUnknown: boolean; stalePendingBefore: number }): boolean {
    const ts = this.now();
    const info = this.db
      .prepare(
        `UPDATE sends SET status = 'pending', updated_at = ?
         WHERE id = ? AND wamid IS NULL AND (
           status = 'failed' OR (status = 'unknown' AND ? = 1) OR (status = 'pending' AND updated_at <= ?)
         )`,
      )
      .run(ts, id, opts.allowUnknown ? 1 : 0, opts.stalePendingBefore);
    return Number(info.changes) === 1;
  }

  touchAttempt(id: number): void {
    this.db.prepare("UPDATE sends SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** A retried send may take a different route than the first try (template instead of free-form): keep the row truthful. */
  setRoute(id: number, route: { kind: SendKind; templateName: string | null; language: string | null }): void {
    this.db.prepare("UPDATE sends SET kind = ?, template_name = ?, language = ?, updated_at = ? WHERE id = ?").run(route.kind, route.templateName, route.language, this.now(), id);
  }

  setMediaId(id: number, mediaId: string): void {
    this.db.prepare("UPDATE sends SET media_id = ?, updated_at = ? WHERE id = ?").run(mediaId, this.now(), id);
  }

  markAccepted(id: number, wamid: string, waId: string | null): SendRow {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE sends SET status = CASE WHEN status IN ('sent','delivered','read') THEN status ELSE 'accepted' END,
           wamid = ?, wa_id = ?, accepted_at = ?, updated_at = ?, error_code = NULL, error_details = NULL, error_es = NULL, error_en = NULL
         WHERE id = ?`,
      )
      .run(wamid, waId, ts, ts, id);
    return this.getSend(id)!;
  }

  markFailedBeforeAccept(id: number, err: { code: number | null; details: string; es: string; en: string }): SendRow {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE sends SET status = 'failed', failed_at = ?, updated_at = ?, error_code = ?, error_details = ?, error_es = ?, error_en = ?
         WHERE id = ?`,
      )
      .run(ts, ts, err.code, err.details, err.es, err.en, id);
    return this.getSend(id)!;
  }

  markUnknown(id: number, err: { details: string; es: string; en: string }): SendRow {
    const ts = this.now();
    this.db
      .prepare("UPDATE sends SET status = 'unknown', updated_at = ?, error_code = NULL, error_details = ?, error_es = ?, error_en = ? WHERE id = ?")
      .run(ts, err.details, err.es, err.en, id);
    return this.getSend(id)!;
  }

  /** Give a send a message id that arrived by webhook (the HTTP answer was lost). */
  adoptWamid(id: number, wamid: string): SendRow {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE sends SET wamid = ?, accepted_at = COALESCE(accepted_at, ?), updated_at = ?,
           status = CASE WHEN status IN ('pending','unknown') OR (status = 'failed' AND wamid IS NULL) THEN 'accepted' ELSE status END,
           error_code = CASE WHEN status IN ('pending','unknown','failed') THEN NULL ELSE error_code END,
           error_details = CASE WHEN status IN ('pending','unknown','failed') THEN NULL ELSE error_details END,
           error_es = CASE WHEN status IN ('pending','unknown','failed') THEN NULL ELSE error_es END,
           error_en = CASE WHEN status IN ('pending','unknown','failed') THEN NULL ELSE error_en END
         WHERE id = ? AND wamid IS NULL`,
      )
      .run(wamid, ts, ts, id);
    return this.getSend(id)!;
  }

  addExtraWamid(sendId: number, wamid: string): boolean {
    const info = this.db.prepare("INSERT OR IGNORE INTO send_extras (send_id, wamid) VALUES (?, ?)").run(sendId, wamid);
    if (Number(info.changes) === 1) {
      this.db.prepare("UPDATE sends SET double_send_suspected = 1, updated_at = ? WHERE id = ?").run(this.now(), sendId);
      return true;
    }
    return false;
  }

  listExtraWamids(sendId: number): string[] {
    return (this.db.prepare("SELECT wamid FROM send_extras WHERE send_id = ? ORDER BY wamid").all(sendId) as Row[]).map((r) => r["wamid"] as string);
  }

  /** Overwrite the delivery columns after the status rules have decided. */
  updateDelivery(
    id: number,
    f: {
      status: SendStatus;
      sentAt?: number | null | undefined;
      deliveredAt?: number | null | undefined;
      readAt?: number | null | undefined;
      failedAt?: number | null | undefined;
      deliveredImplied?: boolean | undefined;
      error?: { code: number | null; details: string; es: string; en: string } | null | undefined;
      waId?: string | null | undefined;
    },
  ): void {
    const cur = this.getSend(id)!;
    const pick = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);
    const error = f.error === undefined ? { code: cur.errorCode, details: cur.errorDetails, es: cur.errorEs, en: cur.errorEn } : f.error;
    this.db
      .prepare(
        `UPDATE sends SET status = ?, sent_at = ?, delivered_at = ?, read_at = ?, failed_at = ?, delivered_implied = ?,
           error_code = ?, error_details = ?, error_es = ?, error_en = ?, wa_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        f.status,
        pick(f.sentAt, cur.sentAt),
        pick(f.deliveredAt, cur.deliveredAt),
        pick(f.readAt, cur.readAt),
        pick(f.failedAt, cur.failedAt),
        pick(f.deliveredImplied, cur.deliveredImplied) ? 1 : 0,
        error?.code ?? null,
        error?.details ?? null,
        error?.es ?? null,
        error?.en ?? null,
        pick(f.waId, cur.waId),
        this.now(),
        id,
      );
  }

  // ---- status events ------------------------------------------------------------------------------------------
  /** Returns the new row id, or null if this exact event was already stored (duplicate delivery). */
  insertStatusEvent(e: {
    tenantId: string;
    wamid: string;
    status: string;
    ts: number;
    recipientId: string | null;
    ref: string | null;
    errorCode: number | null;
    errorTitle: string | null;
    errorDetails: string | null;
    rawJson: string;
    sendId: number | null;
  }): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO status_events (tenant_id, wamid, status, ts, recipient_id, ref, error_code, error_title, error_details,
           raw_json, send_id, applied, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(e.tenantId, e.wamid, e.status, e.ts, e.recipientId, e.ref, e.errorCode, e.errorTitle, e.errorDetails, e.rawJson, e.sendId, this.now());
    return Number(info.changes) === 1 ? Number(info.lastInsertRowid) : null;
  }

  markEvent(id: number, sendId: number | null, applied: boolean): void {
    this.db.prepare("UPDATE status_events SET send_id = ?, applied = ? WHERE id = ?").run(sendId, applied ? 1 : 0, id);
  }

  orphanEvents(tenantId: string, wamid: string): StatusEventRow[] {
    return (
      this.db
        .prepare("SELECT * FROM status_events WHERE tenant_id = ? AND wamid = ? AND send_id IS NULL ORDER BY ts, id")
        .all(tenantId, wamid) as Row[]
    ).map(mapEvent);
  }

  eventsForSend(sendId: number): StatusEventRow[] {
    return (this.db.prepare("SELECT * FROM status_events WHERE send_id = ? ORDER BY ts, id").all(sendId) as Row[]).map(mapEvent);
  }

  countEvents(tenantId?: string): number {
    const r = (tenantId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM status_events WHERE tenant_id = ?").get(tenantId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM status_events").get()) as Row;
    return r["n"] as number;
  }

  // ---- conversations, inbound, opt-out ------------------------------------------------------------------------
  touchConversation(tenantId: string, contactKey: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO conversations (tenant_id, contact_key, last_inbound_at) VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, contact_key) DO UPDATE SET last_inbound_at = MAX(last_inbound_at, excluded.last_inbound_at)`,
      )
      .run(tenantId, contactKey, ts);
  }

  lastInboundAt(tenantId: string, contactKey: string): number | null {
    const r = this.db.prepare("SELECT last_inbound_at FROM conversations WHERE tenant_id = ? AND contact_key = ?").get(tenantId, contactKey) as Row | undefined;
    return r ? (r["last_inbound_at"] as number) : null;
  }

  insertInbound(m: { tenantId: string; wamid: string; contactKey: string; ts: number; type: string; text: string | null; keyword: string | null }): boolean {
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO inbound_messages (tenant_id, wamid, contact_key, ts, type, text, keyword, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.tenantId, m.wamid, m.contactKey, m.ts, m.type, m.text, m.keyword, this.now());
    return Number(info.changes) === 1;
  }

  listInbound(tenantId: string): Array<{ wamid: string; contactKey: string; ts: number; type: string; text: string | null; keyword: string | null }> {
    return (this.db.prepare("SELECT * FROM inbound_messages WHERE tenant_id = ? ORDER BY ts, wamid").all(tenantId) as Row[]).map((r) => ({
      wamid: r["wamid"] as string,
      contactKey: r["contact_key"] as string,
      ts: r["ts"] as number,
      type: r["type"] as string,
      text: (r["text"] as string | null) ?? null,
      keyword: (r["keyword"] as string | null) ?? null,
    }));
  }

  optOut(tenantId: string, contactKey: string, keyword: string, wamid: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO opt_outs (tenant_id, contact_key, opted_out_at, keyword, source_wamid) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, contact_key) DO NOTHING`,
      )
      .run(tenantId, contactKey, ts, keyword, wamid);
    this.db.prepare("INSERT INTO opt_events (tenant_id, contact_key, event, keyword, wamid, ts) VALUES (?, ?, 'opt_out', ?, ?, ?)").run(tenantId, contactKey, keyword, wamid, ts);
  }

  optIn(tenantId: string, contactKey: string, keyword: string, wamid: string | null, ts: number): boolean {
    const info = this.db.prepare("DELETE FROM opt_outs WHERE tenant_id = ? AND contact_key = ?").run(tenantId, contactKey);
    this.db.prepare("INSERT INTO opt_events (tenant_id, contact_key, event, keyword, wamid, ts) VALUES (?, ?, 'opt_in', ?, ?, ?)").run(tenantId, contactKey, keyword, wamid, ts);
    return Number(info.changes) === 1;
  }

  isOptedOut(tenantId: string, contactKey: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM opt_outs WHERE tenant_id = ? AND contact_key = ?").get(tenantId, contactKey) !== undefined;
  }

  listOptEvents(tenantId: string): Array<{ contactKey: string; event: string; keyword: string | null; ts: number }> {
    return (this.db.prepare("SELECT * FROM opt_events WHERE tenant_id = ? ORDER BY id").all(tenantId) as Row[]).map((r) => ({
      contactKey: r["contact_key"] as string,
      event: r["event"] as string,
      keyword: (r["keyword"] as string | null) ?? null,
      ts: r["ts"] as number,
    }));
  }

  // ---- identities (phone number <-> business-scoped user id) -------------------------------------------------
  linkedContactKey(tenantId: string, bsuid: string): string | null {
    const r = this.db.prepare("SELECT contact_key FROM identity_links WHERE tenant_id = ? AND bsuid = ?").get(tenantId, bsuid) as Row | undefined;
    return r ? (r["contact_key"] as string) : null;
  }

  /** Record that a BSUID belongs to a phone-number key and fold anything stored under "bsuid:<id>" into it. */
  linkIdentity(tenantId: string, bsuid: string, phoneKey: string): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO identity_links (tenant_id, bsuid, contact_key) VALUES (?, ?, ?) ON CONFLICT(tenant_id, bsuid) DO UPDATE SET contact_key = excluded.contact_key")
        .run(tenantId, bsuid, phoneKey);
      const provisional = "bsuid:" + bsuid;
      const conv = this.db.prepare("SELECT last_inbound_at FROM conversations WHERE tenant_id = ? AND contact_key = ?").get(tenantId, provisional) as Row | undefined;
      if (conv) {
        this.touchConversation(tenantId, phoneKey, conv["last_inbound_at"] as number);
        this.db.prepare("DELETE FROM conversations WHERE tenant_id = ? AND contact_key = ?").run(tenantId, provisional);
      }
      const out = this.db.prepare("SELECT * FROM opt_outs WHERE tenant_id = ? AND contact_key = ?").get(tenantId, provisional) as Row | undefined;
      if (out) {
        this.db
          .prepare("INSERT INTO opt_outs (tenant_id, contact_key, opted_out_at, keyword, source_wamid) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, contact_key) DO NOTHING")
          .run(tenantId, phoneKey, out["opted_out_at"] as number, out["keyword"] as string, (out["source_wamid"] as string | null) ?? null);
        this.db.prepare("DELETE FROM opt_outs WHERE tenant_id = ? AND contact_key = ?").run(tenantId, provisional);
      }
    });
  }

  // ---- media cache --------------------------------------------------------------------------------------------
  getCachedMedia(tenantId: string, sha256: string, filename: string, now: number): string | null {
    const r = this.db.prepare("SELECT media_id, expires_at FROM media_cache WHERE tenant_id = ? AND sha256 = ? AND filename = ?").get(tenantId, sha256, filename) as Row | undefined;
    if (!r) return null;
    return (r["expires_at"] as number) > now ? (r["media_id"] as string) : null;
  }

  putCachedMedia(tenantId: string, sha256: string, filename: string, mediaId: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO media_cache (tenant_id, sha256, filename, media_id, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, sha256, filename) DO UPDATE SET media_id = excluded.media_id, expires_at = excluded.expires_at`,
      )
      .run(tenantId, sha256, filename, mediaId, expiresAt);
  }

  dropCachedMedia(tenantId: string, mediaId: string): void {
    this.db.prepare("DELETE FROM media_cache WHERE tenant_id = ? AND media_id = ?").run(tenantId, mediaId);
  }
}
