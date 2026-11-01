// A tiny example "documents" integration: budgets, invoices and purchase orders that can be sent by WhatsApp, and a
// per-document send history built from the send log. This stands in for the host application's own documents module.

import { readFileSync } from "node:fs";
import type { DocType, SendRow, Store, Tenant } from "./db.ts";
import { makePdf } from "./pdf.ts";
import { DOC_LABEL } from "./templates.ts";
import type { SendResult, WhatsAppSender } from "./sender.ts";

export interface DocumentLine {
  description: string;
  quantity: number;
  unitCents: number;
}

export interface DocumentRecord {
  tenantId: string;
  id: string;
  type: DocType;
  number: string;
  customerName: string;
  customerPhone: string;
  currency: string;
  issuedOn: string;
  lines: DocumentLine[];
}

export function totalCents(doc: Pick<DocumentRecord, "lines">): number {
  return doc.lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0);
}

export function formatMoney(cents: number, currency: string, locale: "es" | "en" = "es"): string {
  const tag = locale === "es" ? "es-ES" : "en-US";
  return new Intl.NumberFormat(tag, { style: "currency", currency }).format(cents / 100);
}

const DDL = `
CREATE TABLE IF NOT EXISTS documents (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  currency TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);`;

export class Documents {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(DDL);
  }

  upsert(d: DocumentRecord): void {
    this.store.db
      .prepare(
        `INSERT INTO documents (tenant_id, id, type, number, customer_name, customer_phone, currency, issued_on, lines_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET type = excluded.type, number = excluded.number, customer_name = excluded.customer_name,
           customer_phone = excluded.customer_phone, currency = excluded.currency, issued_on = excluded.issued_on, lines_json = excluded.lines_json`,
      )
      .run(d.tenantId, d.id, d.type, d.number, d.customerName, d.customerPhone, d.currency, d.issuedOn, JSON.stringify(d.lines));
  }

  private map(r: Record<string, unknown>): DocumentRecord {
    return {
      tenantId: r["tenant_id"] as string,
      id: r["id"] as string,
      type: r["type"] as DocType,
      number: r["number"] as string,
      customerName: r["customer_name"] as string,
      customerPhone: r["customer_phone"] as string,
      currency: r["currency"] as string,
      issuedOn: r["issued_on"] as string,
      lines: JSON.parse(r["lines_json"] as string) as DocumentLine[],
    };
  }

  list(tenantId: string): DocumentRecord[] {
    return (this.store.db.prepare("SELECT * FROM documents WHERE tenant_id = ? ORDER BY issued_on, id").all(tenantId) as Record<string, unknown>[]).map((r) => this.map(r));
  }

  get(tenantId: string, id: string): DocumentRecord | undefined {
    const r = this.store.db.prepare("SELECT * FROM documents WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
    return r ? this.map(r) : undefined;
  }

  pdf(doc: DocumentRecord, businessName: string, locale: "es" | "en" = "es"): Uint8Array {
    const label = DOC_LABEL[locale][doc.type];
    const lines = [
      `${businessName}`,
      `${locale === "es" ? "Cliente" : "Customer"}: ${doc.customerName}`,
      `${locale === "es" ? "Fecha" : "Date"}: ${doc.issuedOn}`,
      "",
      ...doc.lines.map((l) => `${l.quantity} x ${l.description}  ${formatMoney(l.quantity * l.unitCents, doc.currency, locale)}`),
      "",
      `Total: ${formatMoney(totalCents(doc), doc.currency, locale)}`,
    ];
    return makePdf(`${label.charAt(0).toUpperCase()}${label.slice(1)} ${doc.number}`, lines);
  }

  filename(doc: DocumentRecord, locale: "es" | "en" = "es"): string {
    const safe = `${DOC_LABEL[locale][doc.type]}-${doc.number}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
    return `${safe}.pdf`;
  }

  /** The "Send by WhatsApp" action: same document, same recipient, same result however many times it is pressed. */
  async sendByWhatsApp(
    sender: WhatsAppSender,
    tenantId: string,
    documentId: string,
    options: { to?: string | undefined; resend?: boolean | undefined; retryInDoubt?: boolean | undefined; mode?: "auto" | "template" | "freeform" | undefined } = {},
  ): Promise<SendResult | { notFound: true }> {
    const tenant = this.store.getTenant(tenantId);
    const doc = this.get(tenantId, documentId);
    if (!tenant || !doc) return { notFound: true };
    return sender.sendDocument({
      tenantId,
      documentId,
      docType: doc.type,
      to: options.to ?? doc.customerPhone,
      document: { kind: "bytes", bytes: this.pdf(doc, tenant.name, tenant.locale), filename: this.filename(doc, tenant.locale) },
      recipientName: doc.customerName,
      documentNumber: doc.number,
      resend: options.resend,
      retryInDoubt: options.retryInDoubt,
      mode: options.mode,
    });
  }

  /** What the document row shows: one entry per WhatsApp send, with its status timeline and plain-language error. */
  history(tenantId: string, documentId: string): HistoryEntry[] {
    const tenant = this.store.getTenant(tenantId);
    const lang = tenant?.locale ?? "es";
    return this.store.listSendsForDocument(tenantId, documentId).map((s) => toHistory(s, lang, this.store));
  }
}

interface FixtureFile {
  tenants: Array<{ id: string; name: string; phoneNumberId: string; accessToken: string; wabaId?: string; defaultCountry?: string; locale?: "es" | "en" }>;
  documents: DocumentRecord[];
}

/** Load the demo tenants and documents (examples/documents/fixtures.json) into a store. */
export function loadFixtures(store: Store, documents: Documents, file: URL | string = new URL("../examples/documents/fixtures.json", import.meta.url)): { tenants: number; documents: number } {
  const data = JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
  for (const t of data.tenants) store.upsertTenant(t);
  for (const d of data.documents) documents.upsert(d);
  return { tenants: data.tenants.length, documents: data.documents.length };
}

export interface HistoryEntry {
  sendId: number;
  recipient: string;
  how: "template" | "document" | "text";
  status: SendRow["status"];
  statusText: string;
  createdAt: number;
  acceptedAt: number | null;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
  deliveredImplied: boolean;
  attempts: number;
  error: string | null;
  errorCode: number | null;
  warnings: string[];
}

const STATUS_TEXT: Record<"es" | "en", Record<SendRow["status"], string>> = {
  es: { pending: "Enviando", unknown: "Sin confirmar", accepted: "Aceptado por WhatsApp", sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "Falló" },
  en: { pending: "Sending", unknown: "Unconfirmed", accepted: "Accepted by WhatsApp", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" },
};

function toHistory(s: SendRow, lang: "es" | "en", store: Store): HistoryEntry {
  const warnings: string[] = [];
  if (s.doubleSendSuspected) {
    const n = store.listExtraWamids(s.id).length;
    warnings.push(
      lang === "es"
        ? `WhatsApp creó ${n + 1} mensajes para este envío (un reintento tras un error del servidor). Puede que la persona haya recibido el documento dos veces.`
        : `WhatsApp created ${n + 1} messages for this send (a retry after a server error). The person may have received the document twice.`,
    );
  }
  if (s.deliveredImplied) {
    warnings.push(lang === "es" ? "Entrega deducida de la lectura (WhatsApp no envió el aviso de entrega)." : "Delivery inferred from the read receipt (WhatsApp did not send a delivered notice).");
  }
  return {
    sendId: s.id,
    recipient: s.recipientE164,
    how: s.kind,
    status: s.status,
    statusText: STATUS_TEXT[lang][s.status],
    createdAt: s.createdAt,
    acceptedAt: s.acceptedAt,
    sentAt: s.sentAt,
    deliveredAt: s.deliveredAt,
    readAt: s.readAt,
    failedAt: s.failedAt,
    deliveredImplied: s.deliveredImplied,
    attempts: s.attempts,
    error: (lang === "es" ? s.errorEs : s.errorEn) ?? null,
    errorCode: s.errorCode,
    warnings,
  };
}

// ---- tiny HTML views (escaped; for the local demo only) ---------------------------------------------------------
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const fmtTime = (ts: number | null): string => (ts === null ? "" : new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z");

export function renderDocumentList(tenant: Tenant, docs: DocumentRecord[], documents: Documents): string {
  const rows = docs
    .map((d) => {
      const hist = documents.history(tenant.id, d.id);
      const last = hist[hist.length - 1];
      return `<tr><td><a href="/t/${encodeURIComponent(tenant.id)}/documents/${encodeURIComponent(d.id)}?format=html">${escapeHtml(d.number)}</a></td>
<td>${escapeHtml(DOC_LABEL[tenant.locale][d.type])}</td><td>${escapeHtml(d.customerName)}</td>
<td>${escapeHtml(formatMoney(totalCents(d), d.currency, tenant.locale))}</td><td>${last ? escapeHtml(last.statusText) : "-"}</td></tr>`;
    })
    .join("\n");
  return page(
    tenant.name,
    `<h1>${escapeHtml(tenant.name)}</h1><table><thead><tr><th>N.º</th><th>Tipo</th><th>Cliente</th><th>Total</th><th>WhatsApp</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

export function renderDocument(tenant: Tenant, doc: DocumentRecord, history: HistoryEntry[]): string {
  const rows = history
    .map(
      (h) => `<tr><td>${escapeHtml(h.recipient)}</td><td>${escapeHtml(h.how)}</td><td><strong>${escapeHtml(h.statusText)}</strong></td>
<td>${escapeHtml(fmtTime(h.sentAt))}</td><td>${escapeHtml(fmtTime(h.deliveredAt))}${h.deliveredImplied ? " *" : ""}</td><td>${escapeHtml(fmtTime(h.readAt))}</td>
<td>${h.error ? escapeHtml(h.error) : ""}${h.warnings.map((w) => `<br><em>${escapeHtml(w)}</em>`).join("")}</td></tr>`,
    )
    .join("\n");
  const actions = `<p><button disabled title="Not part of this kit">Enviar por email</button>
<button id="wa" data-url="/t/${encodeURIComponent(tenant.id)}/documents/${encodeURIComponent(doc.id)}/send-whatsapp">Enviar por WhatsApp</button></p>`;
  return page(
    `${doc.number}`,
    `<h1>${escapeHtml(DOC_LABEL[tenant.locale][doc.type])} ${escapeHtml(doc.number)}</h1>
<p>${escapeHtml(doc.customerName)} - ${escapeHtml(doc.customerPhone)} - ${escapeHtml(formatMoney(totalCents(doc), doc.currency, tenant.locale))}</p>${actions}
<h2>WhatsApp</h2><table><thead><tr><th>Destino</th><th>Cómo</th><th>Estado</th><th>Enviado</th><th>Entregado</th><th>Leído</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table>
<script>document.getElementById("wa").addEventListener("click",async e=>{const r=await fetch(e.target.dataset.url,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const j=await r.json();alert(j.message&&j.message.es||JSON.stringify(j));location.reload();});</script>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style></head><body>${body}</body></html>`;
}
