# whatsapp-cloud-kit

> **Status:** a proof project. @@TESTS@@ tests in @@FILES@@ files pass locally on Node @@NODE@@ (typecheck clean), and a mutation check breaks `src/` in @@MUT_TOTAL@@ deliberate ways, of which @@MUT_KILLED@@ are caught by the tests (see "Tests and the mutation check" for the rest). **Nothing here has ever run on WhatsApp or Meta.** There was no Meta account, no business verification, no approved template and no real phone number behind it. Every test talks to a **local mock of the Graph API** or to **signed fixture events** written from the field names in Meta's public documentation. The mock, the fixtures and the code were written by the same person from the same reading of the same pages, so a misreading would be shared by all three. [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md) lists what only a live run can settle; its "ran on Meta on" line is blank.

A tested starting point for the job "add **Send by WhatsApp** next to **Send by email** for the PDF documents (quotes, invoices, purchase orders) my multi-tenant Node app already generates, show delivery and read status from webhooks, use Spanish templates, and make it work for Argentine numbers".

| Piece | File | What it does |
|---|---|---|
| Phone numbers | `src/phone.ts` | Turns what a person typed (`011 15 5550-0101`, `+54 9 11 ...`, `612 34 56 78`, `+52 1 55 ...`) into E.164 with a reason in Spanish and English when it cannot. Argentina, Spain, Mexico, Brazil, India, US/Canada and a generic rule; a comparison key (`matchKey`) so the same person in two spellings is one recipient |
| Sender | `src/sender.ts` | `sendDocument(...)`: uploads the PDF (`/media`), sends a **free-form document** inside the 24-hour window or a **utility template with a PDF header** outside it, per-tenant `phone_number_id` and token, one message per tenant+document+recipient, retries with backoff and `Retry-After`, plain-language errors, an explicit "in doubt" state when the outcome is unknowable |
| Webhook | `src/webhook.ts`, `src/signature.ts` | GET challenge; POST `X-Hub-Signature-256` checked over the **raw bytes** in constant time (several secrets for rotation, optional secret-per-tenant); stale, future-dated, unsigned and tampered events refused with distinct statuses; routing by `metadata.phone_number_id` |
| Send log | `src/db.ts`, `src/statuses.ts` | `node:sqlite`. Status events applied in rank order (`sent` < `delivered` < `read`), duplicates and out-of-order delivery harmless, `read` without `delivered` accepted, `failed` never overwrites a delivery, events that arrive before the send is recorded are parked and applied later |
| Window and opt-out | `src/inbound.ts` | Inbound messages open and reset the 24-hour window; `STOP`, `BAJA`, `PARAR`, `DESUSCRIBIR` ... opt a number out (whole-message match, accent- and case-insensitive); `START`, `ALTA` opt it back in; optional confirmation message |
| Errors | `src/whatsapp-errors.ts` | 44 documented error codes mapped to Spanish and English text, an action ("send a template", "fix the number", "contact support") and a `retryable` flag |
| Templates | `src/templates.ts`, `src/payloads.ts` | Example Spanish and English utility templates for budget / invoice / purchase order, the creation payload, the send payloads, document checks (type, size, caption length) |
| Example integration | `src/documents.ts`, `src/server.ts`, `examples/documents/` | A small documents table, PDF generator, HTML list with a "Send by WhatsApp" button and status badge, JSON API, and a `node:http` server that wires everything together |
| Mock Graph API | `testing/mock-graph.ts` | Local stand-in for `/media` and `/messages` with scripted failures (rate limit, 5xx, dropped connection, hang, failure after accept), automatic status webhooks (also reversed or duplicated), wa_id rewriting, expiring media. Listens on ports 4750-4769 only |
| Fixtures | `testing/fixtures.ts`, `scripts/generate-fixtures.ts` | Builders for status and inbound payloads in the documented shape, and a signer. `npm run fixtures:generate` writes signed examples for `curl` |
| Wiring example | `examples/own-app/wiring.ts` | How to read the environment variables and mount the two webhook functions in your own framework |
| Mutation check | `scripts/mutation-check.mjs` | @@MUT_TOTAL@@ deliberate breakages of `src/`, run one at a time on a throwaway copy, each with a hard timeout that kills the whole process tree; a self-test with a planted hang |

Runtime code uses only Node built-ins (`node:crypto`, `node:http`, `node:sqlite`, global `fetch`, `FormData`). Dev dependencies: `vitest`, `typescript`, `@types/node`. Nothing here is on npm; copy `src/` or import it by path. Needs Node 25 or newer (`node:sqlite`, running `.ts` files directly); `node:sqlite` still prints one experimental warning.

Guides: [SETUP-GUIDE](docs/SETUP-GUIDE.md) (verification, number, token, webhook, Spanish template, environment variables) · [COSTS](docs/COSTS.md) · [GO-LIVE-CHECKLIST](docs/GO-LIVE-CHECKLIST.md) · [SOURCES](docs/SOURCES.md) (every Meta page used, with the date it was read, and where the docs were unclear).

## Quickstart

```bash
npm ci
npm test                  # vitest run
npm run typecheck         # tsc --noEmit
npm run mutation-selftest # proves the mutation harness itself, including a planted hang
npm run mutation-check    # slow: one mutant at a time; waits for the machine to be quiet
```

### Try it locally (nothing leaves your machine)

```bash
npm run serve             # kit server + mock Graph API + two demo tenants, on 127.0.0.1 in ports 4750-4769
```

It prints the ports. The mock takes the first free port and the kit's server the next one (usually `4751`):

```bash
BASE=http://127.0.0.1:4751

# the list, in a browser or as JSON
echo "$BASE/t/taller-ar/documents?format=html"   # open this in a browser
curl -s "$BASE/t/taller-ar/documents" | head -c 600

# "Send by WhatsApp" for a budget; the argentine customer's number is stored as typed: 011 15 5550-0101
curl -s -X POST "$BASE/t/taller-ar/documents/doc-ar-budget-1/send-whatsapp" -d '{}'
#   {"outcome":"sent", ... "status":"accepted"}
# the mock then sends signed sent / delivered / read webhooks to the kit by itself, two seconds apart
curl -s "$BASE/t/taller-ar/documents/doc-ar-budget-1" | head -c 800

# the same click again: no second message
curl -s -X POST "$BASE/t/taller-ar/documents/doc-ar-budget-1/send-whatsapp" -d '{}'
#   {"outcome":"duplicate", ...}   (HTTP 200)
```

Manual mode: the mock stays silent and you play Meta with signed files.

```bash
npm run serve -- --manual          # terminal 1
npm run fixtures:generate          # terminal 2: writes fixtures/*.body.json and *.signature.txt (git-ignored)
curl -i -X POST "$BASE/webhooks/whatsapp" \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: $(cat fixtures/inbound-stop.signature.txt)" \
  --data-binary @fixtures/inbound-stop.body.json     # the customer wrote BAJA: sends are now refused
curl -s -X POST "$BASE/t/taller-ar/documents/doc-ar-budget-1/send-whatsapp" -d '{"resend":true}'   # HTTP 422 blocked_opt_out
# GET verification, as Meta does it
curl -i "$BASE/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=demo-verify-token&hub.challenge=1158201444"
```

The demo secrets (`demo-app-secret-not-a-real-secret`, `demo-verify-token`) and tokens (`fake-token-...`) are fictional. The generated fixtures are stamped "now", and the webhook refuses events older than about 8 days, so generate them again when they go stale.

## How it works

### Phone numbers, and the Argentine problem

`normalizePhone(input, { defaultCountry })` returns `{ ok: true, e164, digits, ... }` or `{ ok: false, code, message: { es, en } }`. For Argentina it accepts the ways people really write mobiles (`011 15 5550-0101`, `0351 15 555-0102`, `+54 11 5550 0103`, `+5491155500101`, `549...`) and produces `+54 9 <area><number>`, the conventional international form of an Argentine mobile. **Whether Meta wants the 9, rejects it, or silently fixes it is not in the documentation read** (Argentina appears only on the pricing pages); the docs mention rewriting only for Brazil and Mexico. So the kit does three defensive things: it sends the canonical form, it **stores the `wa_id` the API answers with** (the documented "may not match `input`"), and it compares numbers (`matchKey`) with a key that ignores the Argentine 9 after `54`, the historic Mexican `1` after `52` and the Brazilian ninth digit, so a webhook whose `recipient_id` or `from` has a different spelling still lands on the right send, opt-out and window. Messages are linked to their status by message id and by a correlation reference, not by number. Which of these assumptions is true is item D of the go-live checklist.

### Sending

```ts
const result = await sender.sendDocument({
  tenantId: "taller-ar", documentId: "doc-ar-budget-1", docType: "budget",
  to: "011 15 5550-0101",                          // as typed
  document: { kind: "bytes", bytes: pdfBytes, filename: "presupuesto-P-2026-0042.pdf" },
  recipientName: "María Gómez", documentNumber: "P-2026-0042",
});
// result.outcome: sent | duplicate | in_flight | in_doubt | blocked_opt_out | invalid_number | invalid_document | outside_window | failed
// result.message.es / .en: text for the button's toast
```

- **Free-form or template.** `mode: "auto"` sends the PDF as an ordinary `document` message with a caption when this customer wrote in the last 24 hours, and as the tenant's approved utility template with the PDF in the header otherwise. `"template"` and `"freeform"` force one path (a forced free-form outside the window is refused locally as `outside_window`).
- **One message per document and recipient.** A row is **reserved in the database before the request**, keyed by tenant, document and the recipient's match key. The Messages API has no idempotency key in the pages read, so protection is local. A second click, a double submit, two workers: `duplicate` or `in_flight`. `resend: true` is the deliberate "send again".
- **When the outcome is unknowable.** A timeout, a dropped connection or a 5xx without an error body might have created the message. The request carries `biz_opaque_callback_data` with a reference (`ws_...`); if the status webhook later shows that reference, the kit adopts the message id (so a "failed" send that actually went out becomes visible instead of being sent twice). With `retryAmbiguous: false` the kit stops at `in_doubt` instead of retrying, and only `retryInDoubt: true` goes again.
- **Retries.** 429, 5xx, network errors and the documented throttling codes (`4`, `80007`, `130429`, `131056`, ...) are retried with exponential backoff and jitter, honouring `Retry-After` up to a cap. Client errors (`131026` not on WhatsApp, `132001` template missing, `131047` window, token errors) are not.
- **Per tenant.** Each tenant row carries its own `phone_number_id`, token, country, language and optional template names. The URL and the bearer token always come from the tenant of the send.
- **Media.** The PDF is uploaded once per tenant and content hash; the media id is cached for 29 days (the docs give 30) and dropped when the API refuses a message that used it.

### Webhook

`handleVerification(query, config)` and `handleEvent({ rawBody, headers }, config)` are framework-agnostic; `src/server.ts` shows them on `node:http`. Answers:

| Case | Answer |
|---|---|
| GET with the right token | `200`, the challenge as plain text |
| GET with a wrong token | `403` |
| POST without a signature header / malformed header | `401` |
| POST whose signature matches no secret | `403` |
| Signed but not JSON | `400` |
| Signed, but an event is older than the age window (default 8 days) or more than 5 minutes in the future | `400` |
| Signed by a secret not allowed to speak for that tenant | `403` |
| Valid, for a number or field the kit does not know | `200`, counted, never retried |
| Storage error | `500` (Meta retries; every step is idempotent) |
| Body over 3 MB | `413` |

The signature is over the raw bytes, compared in constant time against every configured secret. Meta's scheme has **no timestamp**, so the signature alone does not stop replay of an old genuine request; the kit adds the age window on the payload's own timestamps and a `UNIQUE(tenant, wamid, status, timestamp)` table so a replay or a Meta retry changes nothing.

### Statuses

`sent` -> `delivered` -> `read` only moves forward. The docs say `delivered` is not sent when a message is delivered and read at once, so `read` implies delivered. `failed` is recorded with the error code, a plain-language text in both languages, and the technical `details`, but never replaces a `delivered` or `read`. The earliest time seen for each status is kept. A status for a message id the kit has not recorded yet (the webhook can overtake the HTTP response) is parked and applied when the send is recorded. A status for another tenant's message is ignored.

### 24-hour window, STOP and START

Every inbound message (of any type) opens or extends the tenant's window with that person by the message's own timestamp. A text that is **exactly** a keyword (`stop`, `baja`, `parar`, `desuscribir`, `dar de baja`, `unsubscribe`, ...) opts the number out for that tenant; sends and free-form replies to it are then refused locally, before any request. `start` / `alta` opts it back in. Both are configurable per deployment; Meta itself defines no keywords. The kit never infers an opt-out from sentences ("quiero la baja de ese presupuesto" is not an opt-out). It also does not collect opt-in: Meta requires the business to obtain it.

## What the docs said, and what the kit does

All pages were read on 2026-11-01; see [docs/SOURCES.md](docs/SOURCES.md) for the list and the exact fields.

| Topic | The docs said | The kit |
|---|---|---|
| GET verification | `hub.mode`, `hub.challenge`, `hub.verify_token`; answer `200` with the challenge on a match | Same; `403` on a mismatch; the token is compared in constant time |
| Signature | `X-Hub-Signature-256: sha256=` + HMAC-SHA256 of the body with the app secret | Same, over the raw bytes; several secrets for rotation |
| Replay | Retried up to 7 days; "your server should handle deduplication"; no timestamp in the signature. An older Graph page says 36 hours | Dedupe table; age window of 8 days (covers both) and 5 minutes into the future |
| Statuses | `sent`, `delivered`, `read`, `failed`, `played`; no ordering guarantee; `delivered` may be skipped | Rank order; read implies delivered; `played` (voice messages only) is stored and has no effect |
| Window | 24 hours from the user's last message; free-form inside it, templates outside | Same, measured from the inbound message timestamp |
| Template send | Body parameters are positional; a media header takes `id` or `link`. **Shown for images only** | The document header is built by analogy (**unverified**) |
| Argentina | Not mentioned | Canonical `+54 9`, store `wa_id`, compare with `matchKey` (**unverified**) |
| Brazil, Mexico | "The extra added prefix ... may be modified by the Cloud API" | Handled in `matchKey` and the normaliser |
| Idempotency | None found for the Messages API | Local reservation + `biz_opaque_callback_data` reference |
| `biz_opaque_callback_data` | Documented in the status webhook; **absent from the Messages API schema excerpt read** | Sent on every message (**unverified** that the API accepts and echoes it) |
| Error handling | Build it around `code` and `details`; HTTP status per code is not documented | Decisions by code first, HTTP status second; unknown codes are not retried |
| Usernames (BSUID) | `wa_id`/`from`/`recipient_id` may be omitted; `user_id` instead; "subject to change" | Read defensively; identity links kept; not tested against any real username account |
| Pricing | Per delivered message by category and country; rates in CSV/PDF files | [COSTS.md](docs/COSTS.md); numbers not read, so none quoted |

## Tests and the mutation check

`npm test` runs @@TESTS@@ vitest tests in @@FILES@@ files (see the table), two workers, no network except the loopback mock. The ones that matter most for the claims above: the webhook tests post signed, tampered, replayed, reordered, duplicated and cross-tenant events to the real handler and then through a real HTTP server; the sender tests drive the real sender against the mock with scripted rate limits, 5xx, dropped connections, hangs and a failure after the message was accepted; the phone tests carry a table of real-world spellings per country.

@@TEST_TABLE@@

`npm run mutation-check` applies each of the @@MUT_TOTAL@@ mutants to a **throwaway copy** of the repository (`.mutation-<pid>/`, deleted afterwards), typechecks it (a mutant that does not typecheck is reported INVALID and does not count), runs the suite with `--bail 1` and records KILLED (a test failed), SURVIVED (all passed), TIMEOUT or ERROR. Rules it enforces on itself: one mutant at a time; a hard per-mutant timeout that kills the **whole process group**, and a timeout is reported as TIMEOUT, never as a kill; it waits until the 1-minute load average is under 6 before each run and gives up after 20 minutes of waiting rather than running on a loaded machine; `npm run mutation-selftest` plants a hang (and a grandchild process) and asserts it is reported TIMEOUT and that nothing is left running. Areas covered: signature, webhook, idempotency, retry, 24-hour window, opt-out, error mapping, status ordering, tenant routing, phone normalisation, server.

@@MUTATION_RESULT@@

## Limits

Read these before relying on anything.

1. **Never run on WhatsApp or Meta.** No account, no verified business, no approved template, no real number. All evidence is from the local mock and from fixtures.
2. **The mock is the kit's reading of the docs.** It rejects what the kit believes Meta rejects (the places where it had to choose are marked `mock rule:` in its messages). Real Meta can differ, and the tests would not show it.
3. **The template document-header JSON is inferred** from the documented image header and the documented document message (SOURCES.md, "Gap"). If Meta wants another shape, every template send fails until `buildTemplateMessage` is changed.
4. **Argentine numbers are a documented guess** (above). Mexican and Brazilian handling follows one sentence of the docs.
5. **A retry after a timeout or 5xx can in theory send twice** if Meta created the message anyway. The correlation reference catches it after the fact; `retryAmbiguous: false` trades that risk for manual follow-up. No idempotency key exists on the Messages API in the pages read.
6. **The demo HTTP routes (`/t/...`) have no authentication.** Bind them to 127.0.0.1, or, in a real product, call `sendDocument` from your own authenticated route. Only the webhook is meant to face the internet.
7. **Access tokens are stored in plain text in SQLite.** Encrypt the volume or swap the column for a secret-store lookup.
8. **SQLite is single-node.** Several app instances sharing one database file is not designed or tested; use a server database and port `src/db.ts` for that.
9. **Only `text` messages are matched against STOP/START keywords.** Buttons, replies to templates and voice notes are not interpreted. Keywords are a list; a language you did not add is not recognised.
10. **Template status webhooks are acknowledged and ignored.** A template that gets paused or disabled shows up only as send errors `132015` / `132016`. No client for template creation or for the resumable upload of the header example is included (the creation JSON is built, not sent).
11. **The `pricing` object of status webhooks is not stored**, so there is no per-tenant cost report.
12. **A batch with one stale event is rejected as a whole (`400`)**, so Meta will retry it until it ages out of its own window. This favours not accepting replays over leniency; change it if you prefer to drop only the stale event.
13. **HTTP status per error code is not documented**, so the retry decision uses the code and falls back to the HTTP class. An unknown code is treated as permanent.
14. **BSUID / username handling** is written from a page marked "subject to change" and is the least tested part.
15. **Not included:** Embedded Signup, inbound media download, interactive and list messages, calls, group messaging, a UI beyond the demo list, rate limiting of your own users, GDPR deletion tooling, an admin screen for tenants.
16. **Fixtures go stale** after about 8 days because the webhook enforces its age window; regenerate them.

## What this does not prove

- That Meta accepts these payloads, approves these templates, keeps them utility, or delivers to a real handset.
- That an Argentine, Mexican or Brazilian number behaves as assumed.
- That real webhooks look exactly like the fixtures: field names were copied from the docs, not from traffic.
- That Meta's signature is computed over the bytes the kit receives behind your proxy, with non-ASCII text, at your batch sizes.
- Throughput, latency or behaviour under Meta's real rate limits; the mock does not model them beyond scripted errors.
- Compliance: opt-in evidence, data retention, a business's own legal duties.
- That the mutation score measures anything beyond the listed mutants: a mutant is a specific breakage I thought of, not a sample of all bugs.

## Layout

```
src/            the kit (phone, sender, webhook, signature, statuses, inbound, errors, templates, payloads, db, documents, server)
testing/        mock Graph API, fixture builders, test harness (not part of the kit's runtime)
test/           vitest tests
examples/       demo tenants and documents; wiring for your own app
scripts/        serve.ts (local demo), generate-fixtures.ts, mutation-check.mjs
docs/           SOURCES, SETUP-GUIDE, COSTS, GO-LIVE-CHECKLIST
```

## Licence

MIT, see [LICENSE](LICENSE). Not affiliated with Meta or WhatsApp; "WhatsApp" and "Meta" are used to name the services the code talks to.
