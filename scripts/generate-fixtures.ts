// Writes signed webhook examples to fixtures/ so they can be replayed with curl against `npm run serve`:
//
//   npm run fixtures:generate
//   curl -i -X POST http://127.0.0.1:4750/webhooks/whatsapp \
//     -H "content-type: application/json" \
//     -H "x-hub-signature-256: $(cat fixtures/status-failed-131026.signature.txt)" \
//     --data-binary @fixtures/status-failed-131026.body.json
//
// The files are built from the field names in Meta's public webhook reference (docs/SOURCES.md); they are not recordings
// of real WhatsApp traffic. Timestamps are "now", because the webhook rejects events older than about a week: generate
// them again when they go stale. The signing secret is the fictional demo secret of `npm run serve`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboundPayload, sign, statusPayload } from "../testing/fixtures.ts";

const SECRET = "demo-app-secret-not-a-real-secret";
const env = { phoneNumberId: "100000000000001", displayPhone: "5491100000000", wabaId: "200000000000001" };
const now = Math.floor(Date.now() / 1000);
const wamid = "wamid.FIXTURE" + "A".repeat(20);

const fixtures: Record<string, { note: string; payload: unknown }> = {
  "status-sent": { note: "outgoing message accepted by the platform", payload: statusPayload(env, [{ wamid, status: "sent", ts: now, recipientId: "5491155500101", pricing: true }]) },
  "status-delivered": { note: "message reached the phone", payload: statusPayload(env, [{ wamid, status: "delivered", ts: now + 1, recipientId: "5491155500101", pricing: true }]) },
  "status-read": { note: "message was read", payload: statusPayload(env, [{ wamid, status: "read", ts: now + 2, recipientId: "5491155500101" }]) },
  "status-failed-131026": { note: "number is not on WhatsApp (error 131026)", payload: statusPayload(env, [{ wamid, status: "failed", ts: now, recipientId: "5491155500101", errorCode: 131026 }]) },
  "status-failed-131047": { note: "outside the 24-hour window (error 131047)", payload: statusPayload(env, [{ wamid, status: "failed", ts: now, recipientId: "5491155500101", errorCode: 131047, errorTitle: "Re-engagement message", errorDetails: "More than 24 hours have passed since the customer last replied." }]) },
  "inbound-text": { note: "the customer writes: opens the 24-hour window", payload: inboundPayload(env, { from: "5491155500101", name: "María Gómez", wamid: "wamid.INBOUND" + "B".repeat(20), ts: now, text: "Hola, ¿pueden enviarme el presupuesto?" }) },
  "inbound-stop": { note: "the customer writes BAJA: opt-out", payload: inboundPayload(env, { from: "5491155500101", name: "María Gómez", wamid: "wamid.INBOUND" + "C".repeat(20), ts: now, text: "BAJA" }) },
  "inbound-start": { note: "the customer writes ALTA: opt back in", payload: inboundPayload(env, { from: "5491155500101", name: "María Gómez", wamid: "wamid.INBOUND" + "D".repeat(20), ts: now, text: "ALTA" }) },
};

mkdirSync("fixtures", { recursive: true });
const index: Array<{ name: string; note: string }> = [];
for (const [name, { note, payload }] of Object.entries(fixtures)) {
  const signed = sign(SECRET, payload);
  writeFileSync(join("fixtures", `${name}.body.json`), signed.rawBody);
  writeFileSync(join("fixtures", `${name}.signature.txt`), signed.headers["x-hub-signature-256"]! + "\n");
  index.push({ name, note });
}
writeFileSync(join("fixtures", "index.json"), JSON.stringify({ secret: SECRET, generatedAt: new Date(now * 1000).toISOString(), fixtures: index }, null, 2) + "\n");
console.log(`wrote ${index.length} signed fixtures to fixtures/ (secret: demo secret of 'npm run serve')`);
