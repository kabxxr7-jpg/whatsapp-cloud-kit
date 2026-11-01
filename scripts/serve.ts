// Local demo: the kit's server, a mock Graph API and the demo documents, all on 127.0.0.1 in ports 4750-4769.
//
//   npm run serve                  start both servers; sends are accepted by the MOCK, nothing leaves this machine
//   npm run serve -- --manual      do not make the mock send status webhooks by itself (use curl, see the README)
//   npm run serve -- --db data/x.db
//
// This is NOT WhatsApp. The mock is the kit's reading of Meta's public documentation (docs/SOURCES.md).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Documents, loadFixtures } from "../src/documents.ts";
import { Store } from "../src/db.ts";
import { WhatsAppSender } from "../src/sender.ts";
import { closeServer, createApp, listenInRange } from "../src/server.ts";
import { MockGraph } from "../testing/mock-graph.ts";

export const DEMO_APP_SECRET = "demo-app-secret-not-a-real-secret";
export const DEMO_VERIFY_TOKEN = "demo-verify-token";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};

const dbPath = opt("--db", ":memory:");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const store = new Store(dbPath);
const documents = new Documents(store);
const loaded = loadFixtures(store, documents);

const mock = new MockGraph();
for (const t of store.listTenants()) {
  mock.addNumber({ phoneNumberId: t.phoneNumberId, token: t.accessToken, wabaId: t.wabaId ?? "200000000000000", displayPhone: "5491100000000" });
  if (t.wabaId) mock.addDefaultTemplates(t.wabaId);
}
if (!flag("--manual")) mock.autoStatus = { sequence: ["sent", "delivered", "read"], stepSec: 2 };
await mock.listen();

const sender = new WhatsAppSender({ store, baseUrl: mock.baseUrl });
const app = createApp({ store, documents, sender, secrets: [{ secret: DEMO_APP_SECRET }], verifyToken: DEMO_VERIFY_TOKEN });
const port = await listenInRange(app.server);
const base = `http://127.0.0.1:${port}`;
mock.connectWebhook(DEMO_APP_SECRET, (req) => fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: req.headers, body: req.rawBody }));

console.log("Local demo only: the 'WhatsApp' behind this is a mock. Nothing is sent to anyone.");
console.log(`  loaded ${loaded.tenants} tenants and ${loaded.documents} documents (database: ${dbPath})`);
console.log(`  kit server  ${base}`);
console.log(`  mock Graph  ${mock.baseUrl}`);
console.log(`  webhook     ${base}/webhooks/whatsapp   (verify token: ${DEMO_VERIFY_TOKEN}; app secret: ${DEMO_APP_SECRET})`);
for (const t of store.listTenants()) {
  console.log(`  ${t.id}: ${base}/t/${t.id}/documents?format=html`);
}
console.log("Press Ctrl+C to stop.");

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await closeServer(app.server);
  await mock.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
