// A small node:http server that wires the pieces together: the webhook endpoint and a demo "documents" API.
//
// The /t/... routes are a DEMO of the integration, with no authentication: bind to 127.0.0.1 only. In a real product the
// "send" action sits behind the host application's own login and permission checks.

import http from "node:http";
import type { Documents } from "./documents.ts";
import { renderDocument, renderDocumentList, totalCents } from "./documents.ts";
import type { Store } from "./db.ts";
import type { WhatsAppSender, SendOutcome } from "./sender.ts";
import type { SecretEntry } from "./signature.ts";
import { MAX_WEBHOOK_BYTES, handleEvent, handleVerification, type WebhookConfig, type WebhookResponse } from "./webhook.ts";
import type { KeywordConfig } from "./inbound.ts";

export const PORT_MIN = 4750;
export const PORT_MAX = 4769;

export interface AppConfig {
  store: Store;
  documents: Documents;
  sender: WhatsAppSender;
  secrets: readonly SecretEntry[];
  verifyToken: string | readonly string[];
  maxBodyBytes?: number | undefined;
  confirmOptChanges?: boolean | undefined;
  keywords?: KeywordConfig | undefined;
  maxEventAgeSeconds?: number | undefined;
}

export interface App {
  server: http.Server;
  /** Resolves when background work started by webhook answers (STOP / START confirmations) has finished. */
  whenIdle(): Promise<void>;
}

/** HTTP status for each send outcome. */
export const OUTCOME_STATUS: Record<SendOutcome, number> = {
  sent: 200,
  duplicate: 200,
  in_flight: 409,
  in_doubt: 409,
  blocked_opt_out: 422,
  invalid_number: 422,
  invalid_document: 422,
  outside_window: 409,
  failed: 502,
};

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string | Uint8Array, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function sendWebhook(res: http.ServerResponse, r: WebhookResponse): void {
  if (r.contentType === "text/plain") send(res, r.status, "text/plain; charset=utf-8", String(r.body));
  else sendJson(res, r.status, r.body);
}

function wantsHtml(url: URL, req: http.IncomingMessage): boolean {
  if (url.searchParams.get("format") === "html") return true;
  if (url.searchParams.get("format") === "json") return false;
  return (req.headers.accept ?? "").startsWith("text/html");
}

export function createApp(config: AppConfig): App {
  const maxBody = config.maxBodyBytes ?? MAX_WEBHOOK_BYTES;
  const background = new Set<Promise<unknown>>();
  const webhookConfig: WebhookConfig = {
    store: config.store,
    secrets: config.secrets,
    verifyToken: config.verifyToken,
    sender: config.sender,
    confirmOptChanges: config.confirmOptChanges,
    keywords: config.keywords,
    maxEventAgeSeconds: config.maxEventAgeSeconds,
  };

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      return sendJson(res, 400, { error: "bad_path" });
    }

    if (parts.length === 1 && parts[0] === "health") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      return sendJson(res, 200, { ok: true });
    }

    if (parts.length === 2 && parts[0] === "webhooks" && parts[1] === "whatsapp") {
      if (method === "GET") return sendWebhook(res, handleVerification(url.searchParams, webhookConfig));
      if (method !== "POST") return methodNotAllowed(res, "GET, POST");
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        if (err instanceof BodyTooLarge) return tooLarge(req, res);
        throw err;
      }
      const result = await handleEvent({ rawBody: raw, headers: req.headers }, webhookConfig);
      if (result.pending) {
        const p = result.pending.finally(() => background.delete(p));
        background.add(p);
      }
      return sendWebhook(res, result);
    }

    if (parts[0] === "t" && parts[2] === "documents" && parts.length >= 3) {
      const tenantId = parts[1]!;
      const tenant = config.store.getTenant(tenantId);
      if (!tenant) return sendJson(res, 404, { error: "unknown_tenant" });

      if (parts.length === 3) {
        if (method !== "GET") return methodNotAllowed(res, "GET");
        const docs = config.documents.list(tenantId);
        if (wantsHtml(url, req)) return send(res, 200, "text/html; charset=utf-8", renderDocumentList(tenant, docs, config.documents));
        return sendJson(res, 200, {
          documents: docs.map((d) => ({
            id: d.id,
            type: d.type,
            number: d.number,
            customerName: d.customerName,
            customerPhone: d.customerPhone,
            totalCents: totalCents(d),
            currency: d.currency,
            whatsapp: config.documents.history(tenantId, d.id),
          })),
        });
      }

      const docId = parts[3]!;
      const doc = config.documents.get(tenantId, docId);
      if (!doc) return sendJson(res, 404, { error: "unknown_document" });

      if (parts.length === 4) {
        if (method !== "GET") return methodNotAllowed(res, "GET");
        const history = config.documents.history(tenantId, docId);
        if (wantsHtml(url, req)) return send(res, 200, "text/html; charset=utf-8", renderDocument(tenant, doc, history));
        return sendJson(res, 200, { document: { ...doc, totalCents: totalCents(doc) }, whatsapp: history });
      }

      if (parts.length === 5 && parts[4] === "pdf") {
        if (method !== "GET") return methodNotAllowed(res, "GET");
        const pdf = config.documents.pdf(doc, tenant.name, tenant.locale);
        return send(res, 200, "application/pdf", pdf, { "content-disposition": `inline; filename="${config.documents.filename(doc, tenant.locale)}"` });
      }

      if (parts.length === 5 && parts[4] === "send-whatsapp") {
        if (method !== "POST") return methodNotAllowed(res, "POST");
        let raw: Buffer;
        try {
          raw = await readBody(req, 64 * 1024);
        } catch (err) {
          if (err instanceof BodyTooLarge) return tooLarge(req, res);
          throw err;
        }
        let options: Record<string, unknown> = {};
        if (raw.length > 0) {
          try {
            const parsed: unknown = JSON.parse(raw.toString("utf8"));
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
            options = parsed as Record<string, unknown>;
          } catch {
            return sendJson(res, 400, { error: "invalid_json" });
          }
        }
        const mode = options["mode"];
        if (mode !== undefined && mode !== "auto" && mode !== "template" && mode !== "freeform") return sendJson(res, 400, { error: "invalid_mode" });
        const to = options["to"];
        if (to !== undefined && typeof to !== "string") return sendJson(res, 400, { error: "invalid_to" });
        const result = await config.documents.sendByWhatsApp(config.sender, tenantId, docId, {
          to: to as string | undefined,
          resend: options["resend"] === true,
          retryInDoubt: options["retryInDoubt"] === true,
          mode: mode as "auto" | "template" | "freeform" | undefined,
        });
        if ("notFound" in result) return sendJson(res, 404, { error: "unknown_document" });
        return sendJson(res, OUTCOME_STATUS[result.outcome], {
          outcome: result.outcome,
          message: result.message,
          error: result.error ?? null,
          phoneError: result.phoneError ? { code: result.phoneError.code, message: result.phoneError.message } : null,
          sendId: result.send?.id ?? null,
          status: result.send?.status ?? null,
        });
      }
    }

    sendJson(res, 404, { error: "not_found" });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      // never leak internals; the message goes to the server log only
      process.stderr.write(`request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, err instanceof Error && err.name === "UnknownTenantError" ? 404 : 500, { error: "internal_error" });
      else res.end();
    });
  });
  // a hung client must not hold the process: webhook bodies are small
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return {
    server,
    async whenIdle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },
  };
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  send(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method_not_allowed" }), { allow });
}

function tooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  send(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: "payload_too_large" }), { connection: "close" });
  res.on("finish", () => req.destroy());
}

/** Listen on the first free port of the kit's range (4750-4769). Never outside it. */
export async function listenInRange(server: http.Server, host = "127.0.0.1", from = PORT_MIN, to = PORT_MAX): Promise<number> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < PORT_MIN || to > PORT_MAX || from > to) {
    throw new RangeError(`ports must stay within ${PORT_MIN}-${PORT_MAX}`);
  }
  for (let port = from; port <= to; port++) {
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${from}-${to}`);
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
