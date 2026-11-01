// How the pieces plug into YOUR app. Reads the environment variables listed in docs/SETUP-GUIDE.md.
//
// The kit does not own an HTTP framework: mount the two webhook functions on your own routes (the GET verification and
// the POST with the RAW body: do not run a JSON body parser in front of it, the signature is over the exact bytes) and
// call `sender.sendDocument(...)` from your own "Send by WhatsApp" action, after your own login / permission check.
//
// Never run against Meta. The functions are covered by test/wiring.test.ts with a fake fetch.

import { Store } from "../../src/db.ts";
import { WhatsAppSender, type SenderOptions } from "../../src/sender.ts";
import type { SecretEntry } from "../../src/signature.ts";
import { handleEvent, handleVerification, type WebhookConfig, type WebhookResponse } from "../../src/webhook.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new ConfigError(`${name} is not set (see docs/SETUP-GUIDE.md)`);
  return v;
}

export interface WhatsAppIntegration {
  store: Store;
  sender: WhatsAppSender;
  webhook: WebhookConfig;
  /** GET /webhooks/whatsapp */
  verify(query: URLSearchParams): WebhookResponse;
  /** POST /webhooks/whatsapp, with the body exactly as received */
  receive(rawBody: Uint8Array, headers: Record<string, string | string[] | undefined>): Promise<WebhookResponse>;
}

export function createWhatsAppIntegration(env: Env, overrides: { fetch?: typeof fetch; store?: Store } = {}): WhatsAppIntegration {
  const secrets: SecretEntry[] = [{ secret: required(env, "WHATSAPP_APP_SECRET") }];
  // while rotating the app secret, both the new and the previous one are accepted
  const previous = env["WHATSAPP_APP_SECRET_PREVIOUS"];
  if (previous !== undefined && previous.trim() !== "") secrets.push({ secret: previous });
  const verifyToken = required(env, "WHATSAPP_VERIFY_TOKEN");

  const store = overrides.store ?? new Store(env["WHATSAPP_DB_PATH"] ?? "data/whatsapp.db");

  const senderOptions: SenderOptions = { store };
  const version = env["WHATSAPP_GRAPH_VERSION"];
  if (version !== undefined && version !== "") senderOptions.graphVersion = version;
  // only for pointing the kit at a mock or a proxy; the default is https://graph.facebook.com
  const baseUrl = env["WHATSAPP_GRAPH_BASE_URL"];
  if (baseUrl !== undefined && baseUrl !== "") senderOptions.baseUrl = baseUrl;
  if (overrides.fetch) senderOptions.fetch = overrides.fetch;
  const sender = new WhatsAppSender(senderOptions);

  const webhook: WebhookConfig = {
    store,
    secrets,
    verifyToken,
    sender,
    confirmOptChanges: env["WHATSAPP_CONFIRM_OPT_CHANGES"] === "true",
  };

  return {
    store,
    sender,
    webhook,
    verify: (query) => handleVerification(query, webhook),
    receive: (rawBody, headers) => handleEvent({ rawBody, headers }, webhook),
  };
}
