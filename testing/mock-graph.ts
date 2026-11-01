// A local stand-in for the parts of the WhatsApp Cloud API (Graph API) the kit calls. It is NOT Meta's service and it is
// not a recording of it: every rule below is this kit's reading of the public documentation (docs/SOURCES.md), and where
// the docs are silent the rule is marked "mock rule". Passing tests against it prove the kit follows the documented
// shapes; they do not prove WhatsApp accepts the same requests.
//
// Two ways to use it:
//   * in-process: pass `mock.fetch` as the sender's `fetch`;
//   * over HTTP:  `await mock.listen()` (ports 4750-4769 only) and use `mock.baseUrl`.
// Both go through the same request handler.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { statusPayload, inboundPayload, sign, type StatusInput, type StatusName, type Envelope } from "./fixtures.ts";

export interface MockNumber {
  phoneNumberId: string;
  wabaId: string;
  /** digits only */
  displayPhone: string;
  token: string;
}

export interface MockTemplate {
  name: string;
  language: string;
  status: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED";
  bodyParams: number;
  headerDocument: boolean;
}

export interface MockMessage {
  wamid: string;
  phoneNumberId: string;
  /** as sent (`to` or `recipient`) */
  input: string;
  /** what the API reports as the user's wa_id */
  waId: string | null;
  type: string;
  body: Record<string, unknown>;
  ref: string | null;
  createdAtSec: number;
}

export interface MockUpload {
  id: string;
  phoneNumberId: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
  createdAtSec: number;
  expired: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  target: "messages" | "media" | "other";
  phoneNumberId: string | null;
  authorization: string | null;
  at: number;
  status: number;
}

export type Failure =
  | {
      /** an error body in the documented shape */
      status: number;
      code: number;
      message?: string;
      details?: string;
      retryAfterSeconds?: number;
    }
  | { status: number; raw: string; retryAfterSeconds?: number }
  | { hang: true }
  | { drop: true };

interface FailureRule {
  match: "messages" | "media" | "any";
  remaining: number;
  failure: Failure;
  /** process the request normally, then answer with the failure (the message exists although the call "failed") */
  afterAccept: boolean;
}

export interface AutoStatus {
  sequence: StatusName[];
  /** deliver in the listed order, reversed, or each one twice */
  order?: "in_order" | "reversed";
  duplicate?: boolean;
  /** deliver before the HTTP answer reaches the caller (the "webhook faster than the response" race) */
  beforeResponse?: boolean;
  /** seconds between statuses (default 1) */
  stepSec?: number;
}

export type WebhookSink = (request: { rawBody: Buffer; headers: Record<string, string> }) => Promise<unknown>;

const SUPPORTED_MEDIA_TYPES = new Set<string>([
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "video/mp4",
  "audio/mpeg",
]);

const EXTENSION_OF_MIME: Record<string, string[]> = {
  "text/plain": ["txt"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "video/mp4": ["mp4"],
  "audio/mpeg": ["mp3"],
};

class DropConnection extends Error {}

/** Hypothetical rewriting of wa_id, because the docs do not say what happens to Argentine numbers. */
export const waIdTransforms = {
  identity: (digits: string): string => digits,
  /** "54 9 11 ..." comes back as "54 11 ..." */
  argentinaDropNine: (digits: string): string => (/^549\d{10}$/.test(digits) ? "54" + digits.slice(3) : digits),
  /** "52 1 55 ..." comes back as "52 55 ..." (the docs' Mexico note: the added prefix "may be modified") */
  mexicoDropOne: (digits: string): string => (/^521\d{10}$/.test(digits) ? "52" + digits.slice(3) : digits),
};

export class MockGraph {
  readonly numbers = new Map<string, MockNumber>();
  readonly templates = new Map<string, MockTemplate[]>(); // by wabaId
  readonly messages: MockMessage[] = [];
  readonly uploads: MockUpload[] = [];
  readonly requests: RecordedRequest[] = [];

  /** Date.now-style clock, shared with the kit's tests so the 24-hour window can be moved. */
  clock: () => number;
  latencyMs = 0;
  waIdTransform: (digits: string) => string = waIdTransforms.identity;
  /** mock rule: how an unreachable number is reported */
  notOnWhatsAppMode: "sync" | "async" = "sync";
  readonly notOnWhatsApp = new Set<string>();
  autoStatus: AutoStatus | null = null;
  maxDocumentBytes = 100 * 1024 * 1024;

  private readonly rules: FailureRule[] = [];
  private readonly lastUserMessage = new Map<string, number>(); // `${phoneNumberId}:${waId}` -> unix seconds
  private webhook: { deliver: WebhookSink; secret: string } | null = null;
  private pending: Promise<unknown>[] = [];
  private server: http.Server | null = null;
  private port = 0;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  // ---- configuration --------------------------------------------------------------------------------------------
  addNumber(n: Partial<MockNumber> & { phoneNumberId: string; token: string }): MockNumber {
    const full: MockNumber = { wabaId: "200000000000001", displayPhone: "5491155550000", ...n };
    this.numbers.set(full.phoneNumberId, full);
    return full;
  }

  addTemplate(wabaId: string, t: Partial<MockTemplate> & { name: string; language: string }): void {
    const list = this.templates.get(wabaId) ?? [];
    list.push({ status: "APPROVED", bodyParams: 3, headerDocument: true, ...t });
    this.templates.set(wabaId, list);
  }

  /** The kit's example templates, approved, on one WABA. */
  addDefaultTemplates(wabaId: string): void {
    for (const [name, language] of [
      ["presupuesto_adjunto", "es"],
      ["factura_adjunta", "es"],
      ["orden_de_compra_adjunta", "es"],
      ["quote_attached", "en"],
      ["invoice_attached", "en"],
      ["purchase_order_attached", "en"],
    ] as const) {
      this.addTemplate(wabaId, { name, language });
    }
  }

  connectWebhook(secret: string, deliver: WebhookSink): void {
    this.webhook = { secret, deliver };
  }

  nowSec(): number {
    return Math.floor(this.clock() / 1000);
  }

  // ---- scripted failures ----------------------------------------------------------------------------------------
  failNext(failure: Failure, count = 1, match: FailureRule["match"] = "any", afterAccept = false): void {
    this.rules.push({ match, remaining: count, failure, afterAccept });
  }

  rateLimitNext(count = 1, retryAfterSeconds?: number): void {
    this.failNext({ status: 429, code: 130429, message: "(#130429) Rate limit hit", details: "Cloud API message throughput has been reached.", ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, count, "any");
  }

  serverErrorNext(count = 1, match: FailureRule["match"] = "any"): void {
    this.failNext({ status: 500, code: 131000, message: "(#131000) Something went wrong", details: "Something went wrong." }, count, match);
  }

  /** The message is created, then the caller gets a 500: the "did it send or not" case. */
  failAfterAccept(count = 1, status = 500): void {
    this.failNext({ status, raw: "<html><body>Internal Server Error</body></html>" }, count, "messages", true);
  }

  hangNext(count = 1, match: FailureRule["match"] = "any"): void {
    this.failNext({ hang: true }, count, match);
  }

  dropNext(count = 1, match: FailureRule["match"] = "any"): void {
    this.failNext({ drop: true }, count, match);
  }

  clearFailures(): void {
    this.rules.length = 0;
  }

  // ---- the user side ---------------------------------------------------------------------------------------------
  /** The person writes to the business: opens (or resets) the 24-hour window. `waId` is as WhatsApp reports it. */
  userMessaged(phoneNumberId: string, waId: string, atSec = this.nowSec()): void {
    this.lastUserMessage.set(`${phoneNumberId}:${waId}`, atSec);
  }

  windowOpen(phoneNumberId: string, waId: string): boolean {
    const last = this.lastUserMessage.get(`${phoneNumberId}:${waId}`);
    return last !== undefined && this.nowSec() - last < 24 * 3600;
  }

  // ---- webhooks --------------------------------------------------------------------------------------------------
  private envelopeFor(phoneNumberId: string): Envelope {
    const n = this.numbers.get(phoneNumberId);
    return { phoneNumberId, displayPhone: n?.displayPhone, wabaId: n?.wabaId };
  }

  /** Deliver one signed status webhook for a message the mock created. Returns the sink's result. */
  async emitStatus(wamid: string, status: StatusName, options: Partial<StatusInput> & { times?: number } = {}): Promise<unknown> {
    const msg = this.messages.find((m) => m.wamid === wamid);
    if (!msg) throw new Error(`mock: unknown message ${wamid}`);
    const { times, ...overrides } = options;
    const input: StatusInput = {
      wamid,
      status,
      ts: overrides.ts ?? this.nowSec(),
      recipientId: msg.waId ?? undefined,
      ref: msg.ref ?? undefined,
      ...overrides,
    };
    let last: unknown;
    for (let i = 0; i < (times ?? 1); i++) last = await this.deliver(statusPayload(this.envelopeFor(msg.phoneNumberId), [input]));
    return last;
  }

  /** Deliver an inbound text message from a person and open their 24-hour window. */
  async emitInbound(phoneNumberId: string, from: string, text: string, options: { ts?: number; wamid?: string; type?: string; fromUserId?: string } = {}): Promise<unknown> {
    const ts = options.ts ?? this.nowSec();
    this.userMessaged(phoneNumberId, from, ts);
    return this.deliver(
      inboundPayload(this.envelopeFor(phoneNumberId), {
        from,
        wamid: options.wamid ?? "wamid.IN" + randomBytes(12).toString("hex"),
        ts,
        text,
        ...(options.type ? { type: options.type } : {}),
        ...(options.fromUserId ? { fromUserId: options.fromUserId } : {}),
      }),
    );
  }

  /** Deliver an arbitrary payload, signed with the connected secret. */
  async deliver(payload: unknown): Promise<unknown> {
    if (!this.webhook) throw new Error("mock: no webhook connected");
    return this.webhook.deliver(sign(this.webhook.secret, payload));
  }

  /** Wait for webhooks the mock started on its own (autoStatus, async failures). */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.allSettled(batch);
    }
  }

  /** Start work a few milliseconds from now, so it lands after the HTTP answer. */
  private later(work: () => Promise<unknown>): Promise<unknown> {
    return new Promise<void>((resolve) => setTimeout(resolve, 5)).then(work).catch(() => undefined);
  }

  private async runAutoStatus(msg: MockMessage): Promise<void> {
    const auto = this.autoStatus;
    if (!auto || !this.webhook) return;
    const step = auto.stepSec ?? 1;
    const base = this.nowSec();
    const events = auto.sequence.map((status, i) => ({ status, ts: base + (i + 1) * step }));
    const ordered = auto.order === "reversed" ? [...events].reverse() : events;
    for (const ev of ordered) {
      await this.emitStatus(msg.wamid, ev.status, { ts: ev.ts, times: auto.duplicate ? 2 : 1 });
    }
  }

  // ---- inspection -------------------------------------------------------------------------------------------------
  lastMessage(): MockMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  messagesTo(waIdOrInput: string): MockMessage[] {
    return this.messages.filter((m) => m.waId === waIdOrInput || m.input === waIdOrInput);
  }

  expireMedia(id: string): void {
    const u = this.uploads.find((x) => x.id === id);
    if (u) u.expired = true;
  }

  reset(): void {
    this.messages.length = 0;
    this.uploads.length = 0;
    this.requests.length = 0;
    this.rules.length = 0;
    this.lastUserMessage.clear();
    this.notOnWhatsApp.clear();
    this.pending = [];
    this.autoStatus = null;
    this.latencyMs = 0;
  }

  // ---- fetch and HTTP -----------------------------------------------------------------------------------------------
  /** Drop-in for `fetch` in the sender. */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    try {
      return await this.handle(req, req.signal);
    } catch (err) {
      if (err instanceof DropConnection) throw new TypeError("fetch failed");
      throw err;
    }
  };

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Listen on the first free port of 4750-4769. */
  async listen(): Promise<number> {
    const server = http.createServer((nodeReq, nodeRes) => {
      const chunks: Buffer[] = [];
      nodeReq.on("data", (c: Buffer) => chunks.push(c));
      nodeReq.on("end", () => {
        const controller = new AbortController();
        nodeRes.on("close", () => controller.abort());
        const method = nodeReq.method ?? "GET";
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) if (typeof v === "string") headers.set(k, v);
        const req = new Request("http://127.0.0.1" + (nodeReq.url ?? "/"), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        this.handle(req, controller.signal)
          .then(async (res) => {
            const headersOut: Record<string, string> = {};
            res.headers.forEach((v, k) => (headersOut[k] = v));
            headersOut["connection"] = "close"; // no keep-alive: the next test may reuse this port for another instance
            nodeRes.writeHead(res.status, headersOut);
            nodeRes.end(Buffer.from(await res.arrayBuffer()));
          })
          .catch((err: unknown) => {
            if (err instanceof DropConnection) nodeReq.socket.destroy();
            else if (!nodeRes.headersSent) {
              nodeRes.writeHead(500);
              nodeRes.end();
            }
          });
      });
    });
    for (let port = 4750; port <= 4769; port++) {
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
        server.listen(port, "127.0.0.1");
      });
      if (ok) {
        this.server = server;
        this.port = port;
        return port;
      }
    }
    throw new Error("mock: no free port in 4750-4769");
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // ---- the request handler -------------------------------------------------------------------------------------------
  private errorResponse(status: number, code: number, message: string, details: string, extraHeaders: Record<string, string> = {}): Response {
    const body = {
      error: {
        message,
        type: code === 190 || code === 0 ? "OAuthException" : "GraphMethodException",
        code,
        error_data: { messaging_product: "whatsapp", details },
        fbtrace_id: "MOCK" + randomBytes(6).toString("hex"),
      },
    };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extraHeaders } });
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  private takeRule(target: "messages" | "media" | "other"): FailureRule | undefined {
    const rule = this.rules.find((r) => r.remaining > 0 && (r.match === "any" || r.match === target));
    if (rule) rule.remaining--;
    return rule;
  }

  private failureResponse(f: Failure): Response {
    if ("raw" in f) {
      return new Response(f.raw, { status: f.status, headers: { "content-type": "text/html", ...(f.retryAfterSeconds ? { "retry-after": String(f.retryAfterSeconds) } : {}) } });
    }
    if ("code" in f) {
      return this.errorResponse(f.status, f.code, f.message ?? `(#${f.code}) error`, f.details ?? "mock failure", f.retryAfterSeconds ? { "retry-after": String(f.retryAfterSeconds) } : {});
    }
    throw new Error("not an error response");
  }

  async handle(req: Request, signal: AbortSignal): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/(v\d+\.\d+)\/(\d+)\/(messages|media)$/.exec(url.pathname);
    const target: "messages" | "media" | "other" = m ? (m[3] as "messages" | "media") : "other";
    const phoneNumberId = m ? m[2]! : null;
    const record: RecordedRequest = {
      method: req.method,
      path: url.pathname,
      target,
      phoneNumberId,
      authorization: req.headers.get("authorization"),
      at: this.clock(),
      status: 0,
    };
    this.requests.push(record);

    await this.sleep(this.latencyMs, signal);

    const rule = this.takeRule(target);
    if (rule && !rule.afterAccept) {
      const f = rule.failure;
      if ("hang" in f) {
        await this.sleep(60_000, signal);
        throw new DropConnection();
      }
      if ("drop" in f) throw new DropConnection();
      const res = this.failureResponse(f);
      record.status = res.status;
      return res;
    }

    const res = await this.route(req, m ? { version: m[1]!, phoneNumberId: m[2]!, target: m[3] as "messages" | "media" } : null);
    if (rule && rule.afterAccept && "status" in rule.failure) {
      const replaced = this.failureResponse(rule.failure);
      record.status = replaced.status;
      return replaced;
    }
    record.status = res.status;
    return res;
  }

  private async route(req: Request, target: { version: string; phoneNumberId: string; target: "messages" | "media" } | null): Promise<Response> {
    if (!target) return this.errorResponse(404, 100, "Unknown path", "mock: unsupported path");
    if (req.method !== "POST") return this.errorResponse(400, 100, "Unsupported request", "mock: only POST is implemented");

    const auth = req.headers.get("authorization");
    if (!auth || !/^Bearer\s+\S+/.test(auth)) return this.errorResponse(401, 0, "(#0) Authentication error", "Missing access token.");
    const number = this.numbers.get(target.phoneNumberId);
    if (!number) return this.errorResponse(400, 100, "Unsupported post request. Object with ID does not exist", "mock: unknown phone number id");
    if (auth.replace(/^Bearer\s+/, "") !== number.token) return this.errorResponse(401, 190, "(#190) Invalid OAuth access token", "Access token is invalid or expired.");

    return target.target === "media" ? this.uploadMedia(req, number) : this.sendMessage(req, number);
  }

  // ---- POST /media --------------------------------------------------------------------------------------------------
  private async uploadMedia(req: Request, number: MockNumber): Promise<Response> {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return this.errorResponse(400, 100, "(#100) Invalid parameter", "Request body is not valid multipart/form-data.");
    }
    if (form.get("messaging_product") !== "whatsapp") return this.errorResponse(400, 100, "(#100) Invalid parameter", "messaging_product must be whatsapp.");
    const type = form.get("type");
    const file = form.get("file");
    if (typeof type !== "string" || type === "") return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "type is required.");
    if (typeof file === "string" || file === null) return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "file is required.");
    // mock rules: the type must be supported, must equal the part's own content type, and must fit the file extension
    if (!SUPPORTED_MEDIA_TYPES.has(type)) return this.errorResponse(400, 131053, "(#131053) Media upload error", `Unsupported media type ${type}.`);
    if (file.type !== "" && file.type !== type) return this.errorResponse(400, 131053, "(#131053) Media upload error", "File content type does not match the type field.");
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!(EXTENSION_OF_MIME[type] ?? []).includes(ext)) return this.errorResponse(400, 131053, "(#131053) Media upload error", "File extension does not match the media type.");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) return this.errorResponse(400, 131053, "(#131053) Media upload error", "Empty file.");
    if (bytes.length > this.maxDocumentBytes) return this.errorResponse(400, 131053, "(#131053) Media upload error", "File too large.");

    const id = String(1_000_000_000_000_000 + this.uploads.length * 7 + Math.floor(Math.random() * 6));
    this.uploads.push({
      id,
      phoneNumberId: number.phoneNumberId,
      filename: file.name,
      mime: type,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAtSec: this.nowSec(),
      expired: false,
    });
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  }

  // ---- POST /messages -----------------------------------------------------------------------------------------------
  private async sendMessage(req: Request, number: MockNumber): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return this.errorResponse(400, 100, "(#100) Invalid parameter", "Request body is not valid JSON.");
    }
    if (body["messaging_product"] !== "whatsapp") return this.errorResponse(400, 100, "(#100) Invalid parameter", "messaging_product must be whatsapp.");

    const type = body["type"];
    if (typeof type !== "string" || !["text", "document", "template"].includes(type)) {
      return this.errorResponse(400, 131051, "(#131051) Unsupported message type", `type ${String(type)} is not supported by the mock.`);
    }

    // recipient: `to` (phone number) or `recipient` (business-scoped user id)
    const to = body["to"];
    const recipient = body["recipient"];
    let input: string;
    let waId: string | null = null;
    if (typeof to === "string" && to !== "") {
      input = to;
      const digits = to.replace(/[+\-() ]/g, "");
      if (!/^\d{7,15}$/.test(digits)) return this.errorResponse(400, 131009, "(#131009) Parameter value is not valid", "to is not a valid phone number.");
      waId = this.waIdTransform(digits);
      if (waId === number.displayPhone) return this.errorResponse(400, 131021, "(#131021) Recipient cannot be sender", "Sender and recipient phone number is the same.");
    } else if (typeof recipient === "string" && recipient !== "") {
      if (type === "template") return this.errorResponse(400, 131062, "(#131062) Unsupported recipient", "mock rule: templates need a phone number.");
      input = recipient;
    } else {
      return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "to is required.");
    }

    // unreachable number
    if (waId !== null && this.notOnWhatsApp.has(waId) && this.notOnWhatsAppMode === "sync") {
      return this.errorResponse(400, 131026, "(#131026) Message undeliverable", "Message undeliverable.");
    }

    const ref = typeof body["biz_opaque_callback_data"] === "string" ? (body["biz_opaque_callback_data"] as string) : null;

    if (type === "text") {
      const t = body["text"] as { body?: unknown } | undefined;
      if (!t || typeof t.body !== "string" || t.body === "") return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "text.body is required.");
    }

    if (type === "document") {
      const d = body["document"] as { id?: unknown; link?: unknown; filename?: unknown } | undefined;
      if (!d || (typeof d.id !== "string" && typeof d.link !== "string")) return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "document.id or document.link is required.");
      if (typeof d.id === "string") {
        const up = this.uploads.find((u) => u.id === d.id && u.phoneNumberId === number.phoneNumberId);
        if (!up || up.expired) return this.errorResponse(400, 131009, "(#131009) Parameter value is not valid", "mock rule: media id not found or expired.");
      }
    }

    if (type === "template") {
      const tpl = body["template"] as { name?: unknown; language?: { code?: unknown }; components?: unknown } | undefined;
      if (!tpl || typeof tpl.name !== "string" || typeof tpl.language?.code !== "string") {
        return this.errorResponse(400, 131008, "(#131008) Required parameter is missing", "template.name and template.language.code are required.");
      }
      const registered = (this.templates.get(number.wabaId) ?? []).find((t) => t.name === tpl.name && t.language === tpl.language!.code);
      if (!registered) return this.errorResponse(404, 132001, "(#132001) Template name does not exist in the translation", `template name (${tpl.name}) does not exist in ${String(tpl.language.code)}`);
      if (registered.status === "PAUSED") return this.errorResponse(400, 132015, "(#132015) Template is paused", "Template is paused due to low quality.");
      if (registered.status === "DISABLED") return this.errorResponse(400, 132016, "(#132016) Template is permanently disabled", "Template is disabled.");
      if (registered.status !== "APPROVED") return this.errorResponse(404, 132001, "(#132001) Template name does not exist in the translation", "Template is not approved.");

      const components = Array.isArray(tpl.components) ? (tpl.components as Array<{ type?: string; parameters?: Array<{ type?: string }> }>) : [];
      const bodyParams = components.find((c) => c.type === "body")?.parameters ?? [];
      const headerParams = components.find((c) => c.type === "header")?.parameters ?? [];
      if (bodyParams.length !== registered.bodyParams) {
        return this.errorResponse(400, 132000, "(#132000) Number of parameters does not match the expected number of params", `body: expected ${registered.bodyParams} parameters, received ${bodyParams.length}`);
      }
      if (registered.headerDocument && !(headerParams.length === 1 && headerParams[0]!.type === "document")) {
        return this.errorResponse(400, 132000, "(#132000) Number of parameters does not match the expected number of params", "header: expected one document parameter");
      }
      if (!registered.headerDocument && headerParams.length > 0) {
        return this.errorResponse(400, 132000, "(#132000) Number of parameters does not match the expected number of params", "header: no parameters expected");
      }
      const headerDoc = (headerParams[0] as { document?: { id?: unknown } } | undefined)?.document;
      if (headerDoc && typeof headerDoc.id === "string") {
        const up = this.uploads.find((u) => u.id === headerDoc.id && u.phoneNumberId === number.phoneNumberId);
        if (!up || up.expired) return this.errorResponse(400, 131009, "(#131009) Parameter value is not valid", "mock rule: media id not found or expired.");
      }
    } else if (waId !== null && !this.windowOpen(number.phoneNumberId, waId)) {
      // free-form messages need an open customer service window
      return this.errorResponse(400, 131047, "(#131047) Re-engagement message", "Message failed to send because more than 24 hours have passed since the customer last replied to this number.");
    }

    // accepted
    const wamid = "wamid." + randomBytes(18).toString("base64url");
    const msg: MockMessage = { wamid, phoneNumberId: number.phoneNumberId, input, waId, type, body, ref, createdAtSec: this.nowSec() };
    this.messages.push(msg);

    const response: Record<string, unknown> = {
      messaging_product: "whatsapp",
      contacts: [waId !== null ? { input, wa_id: waId } : { input }],
      messages: [type === "template" ? { id: wamid, message_status: "accepted" } : { id: wamid }],
    };

    if (waId !== null && this.notOnWhatsApp.has(waId) && this.notOnWhatsAppMode === "async") {
      this.pending.push(this.later(() => this.emitStatus(wamid, "failed", { errorCode: 131026, errorTitle: "Message undeliverable", errorDetails: "Message Undeliverable." })));
    } else if (this.autoStatus && this.webhook) {
      if (this.autoStatus.beforeResponse) await this.runAutoStatus(msg);
      else this.pending.push(this.later(() => this.runAutoStatus(msg)));
    }

    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }
}
