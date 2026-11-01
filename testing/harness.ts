// Shared test world: an in-memory store with a movable clock, the mock Graph API, a sender wired to it, the demo
// documents and a webhook configuration. Nothing here touches the network unless a test calls `mock.listen()`.

import { Documents, loadFixtures } from "../src/documents.ts";
import { Store } from "../src/db.ts";
import { WhatsAppSender, type SenderOptions } from "../src/sender.ts";
import type { SecretEntry } from "../src/signature.ts";
import { handleEvent, type WebhookConfig, type WebhookResponse } from "../src/webhook.ts";
import { MockGraph } from "./mock-graph.ts";
import { sign, type SignedRequest } from "./fixtures.ts";

export const APP_SECRET = "test-app-secret-AAAA";
export const OTHER_SECRET = "test-app-secret-BBBB";
export const VERIFY_TOKEN = "test-verify-token";

export const AR = { tenantId: "taller-ar", phoneNumberId: "100000000000001", token: "fake-token-taller-ar", wabaId: "200000000000001", display: "5491155550000" };
export const ES = { tenantId: "estudio-es", phoneNumberId: "100000000000002", token: "fake-token-estudio-es", wabaId: "200000000000002", display: "34910000000" };

export const START_MS = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01 12:00:00Z

export class TestClock {
  ms = START_MS;
  readonly now = (): number => this.ms;
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
  get sec(): number {
    return Math.floor(this.ms / 1000);
  }
}

export interface World {
  clock: TestClock;
  store: Store;
  mock: MockGraph;
  sender: WhatsAppSender;
  documents: Documents;
  webhook: WebhookConfig;
  sleeps: number[];
  /** post a signed payload straight to the webhook handler */
  post(payload: unknown, secret?: string): Promise<WebhookResponse>;
  postRaw(req: SignedRequest): Promise<WebhookResponse>;
  close(): void;
}

export interface WorldOptions {
  sender?: Partial<SenderOptions>;
  webhook?: Partial<WebhookConfig>;
  secrets?: SecretEntry[];
  /** default true: approve the kit's example templates on both WABAs */
  templates?: boolean;
  /** default true: connect the mock's webhook sink to the handler */
  connect?: boolean;
}

export function makeWorld(options: WorldOptions = {}): World {
  const clock = new TestClock();
  const store = new Store(":memory:", clock.now);
  const documents = new Documents(store);
  loadFixtures(store, documents);

  const mock = new MockGraph({ clock: clock.now });
  mock.addNumber({ phoneNumberId: AR.phoneNumberId, token: AR.token, wabaId: AR.wabaId, displayPhone: AR.display });
  mock.addNumber({ phoneNumberId: ES.phoneNumberId, token: ES.token, wabaId: ES.wabaId, displayPhone: ES.display });
  if (options.templates !== false) {
    mock.addDefaultTemplates(AR.wabaId);
    mock.addDefaultTemplates(ES.wabaId);
  }

  const sleeps: number[] = [];
  const sender = new WhatsAppSender({
    store,
    fetch: mock.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0
    requestTimeoutMs: 2000,
    ...options.sender,
  });

  const webhook: WebhookConfig = {
    store,
    secrets: options.secrets ?? [{ secret: APP_SECRET }],
    verifyToken: VERIFY_TOKEN,
    sender,
    clock: clock.now,
    ...options.webhook,
  };

  const postRaw = (req: SignedRequest) => handleEvent(req, webhook);
  const world: World = {
    clock,
    store,
    mock,
    sender,
    documents,
    webhook,
    sleeps,
    post: (payload, secret = APP_SECRET) => postRaw(sign(secret, payload)),
    postRaw,
    close: () => {
      void mock.close();
      store.close();
    },
  };
  if (options.connect !== false) {
    mock.connectWebhook(APP_SECRET, async (req) => {
      const res = await handleEvent(req, webhook);
      if (res.pending) await res.pending;
      return res;
    });
  }
  return world;
}

/** A document row's send, by id in the demo fixtures. */
export const DOC = {
  arBudget: "doc-ar-budget-1", // "011 15 5550-0101"  -> +54 9 11 5550 0101
  arInvoice: "doc-ar-invoice-1", // "+54 9 351 555-0102"
  arPo: "doc-ar-po-1", // "+54 11 5550 0103"
};
