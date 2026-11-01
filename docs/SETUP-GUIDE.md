# Setup guide: from nothing to "Send by WhatsApp" for generated PDFs

**Read this first.** This guide is written from Meta's public documentation (read on 2026-11-01, list in [SOURCES.md](SOURCES.md)). The kit was never run against WhatsApp or Meta: there was no Meta account, no business verification, no template approval and no real phone number behind it. Menu labels in Meta's tools move around (the docs themselves were mid-rename from "WhatsApp Business Account" to "Messaging account"), so treat each step as "what the docs said on that date" and check it against the screen in front of you. Items the docs did not make clear are marked **unverified**.

Who does what:

| Step | Who | Where |
|---|---|---|
| 1. Business portfolio and (later) business verification | The business that owns the customers (your client, or each of your clients if you are a platform) | Meta Business Suite / Business Support Home |
| 2. Meta app with the WhatsApp use case | The developer | Meta App Dashboard |
| 3. Phone number: add, verify, register | The business owner, with the developer for the API call | WhatsApp Manager, then the API |
| 4. Token | The developer | Business settings, System users |
| 5. Webhook | The developer | App Dashboard |
| 6. Templates | The developer submits, Meta approves | Message Templates API / WhatsApp Manager |
| 7. Environment variables and tenant rows | The developer | Your deployment |
| 8. First live test | Both | [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) |

## 1. Business verification

What the docs say: a new account can message a limited number of unique people per rolling 24 hours outside a customer service window (250), and the limit rises (2,000, then more automatically) after **business verification**, or by sending enough good-quality volume. The docs point to "Verify your business" in Meta's business help pages and, for businesses onboarded by a partner, to partner-led verification.

What this means in practice:

- Start verification early. It needs the legal entity's documents, and it is the part you cannot rush (no timing is given in the pages read; ask Meta's current help page).
- You can build and test with the 250 limit and a test number before verification. You cannot do a real roll-out to hundreds of customers without it.
- Meta also requires a **display name** that is checked against the business, and the name matters again when the limit is raised.

Unverified: the exact documents Meta asks for in a given country (Argentina or Spain) and the time it takes. Ask the client to start the process while you build.

## 2. Meta app

From the "Get started" page: open the Meta App Dashboard, create an app with the **Connect with customers through WhatsApp** use case, pick (or create) the business portfolio, then use **Start using the API** to connect a Messaging account (the WhatsApp Business Account, "WABA"). Keep two ids from that screen: the **Messaging account id (WABA id)** and the **phone number id**. The kit needs both: the phone number id routes every webhook to the right tenant, and the WABA id is where templates are created.

Then collect the **app secret** (App settings, Basic). It is the HMAC key for webhook signatures. It is **not** the access token.

If you are one software vendor serving many customers (a SaaS), the docs split this further into Tech Provider / Solution Partner roles with **Embedded Signup**, where each customer connects their own Messaging account to your app and you receive a token per customer. The kit's data model already fits that (one row per tenant: phone number id, token, optional WABA id), but Embedded Signup itself is not implemented here.

## 3. The phone number

From the registration page:

1. **Add** the number in WhatsApp Manager.
2. **Verify** ownership (the docs say the number must be able to receive voice calls or SMS, must be owned by the business and have a country and area code).
3. **Register** it. Registration is only possible through the API, not through WhatsApp Manager:

```
POST https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>/register
Authorization: Bearer <token>
Content-Type: application/json

{ "messaging_product": "whatsapp", "pin": "<6-digit two-step verification PIN>" }
```

Limits from the docs: 10 registration requests per number in a 72-hour moving window (error `133016` after that). A number that is currently active in the regular WhatsApp or WhatsApp Business app has special rules (the docs have a separate page on onboarding WhatsApp Business app users; it was not read in detail and is not covered by the kit).

Write down which of your customers' numbers are already used in the normal WhatsApp or WhatsApp Business app: that is the most common surprise in a roll-out.

## 4. Access token

The docs recommend a **system user** token for a direct developer (long-lived, no person behind it), or a Business Integration System User token for a Tech Provider via Embedded Signup. Steps from the docs: create a system user, assign it the app with **Manage app** (full control) and the Messaging account as assets, then generate a token with these permissions:

- `business_management`
- `whatsapp_business_management`
- `whatsapp_business_messaging`

The kit stores one token per tenant in the `tenants` table (`access_token`, **plain text in SQLite**: see README Limits; put the database file on an encrypted volume or replace the column with a secrets-manager lookup before production). Never commit a token. Never put one in a URL.

## 5. Webhook

In the App Dashboard, under the WhatsApp configuration panel, enter:

| Field | Value |
|---|---|
| Callback URL | `https://<your host>/webhooks/whatsapp` (the path used by the kit's server; it is your choice if you mount `handleEvent` yourself) |
| Verify token | any string you choose; the same value goes into `WHATSAPP_VERIFY_TOKEN` |

Meta sends a `GET` with `hub.mode=subscribe`, `hub.challenge` and `hub.verify_token`. The kit answers `200` with the challenge as plain text when the token matches and `403` when it does not. Then subscribe the app to the **`messages`** field (it carries both incoming messages and the `sent` / `delivered` / `read` / `failed` statuses of your outgoing ones). The kit acknowledges and ignores other fields, including `message_template_status_update`.

Requirements from the docs: a valid TLS certificate (self-signed certificates are not supported), a response of `200` to every delivery that you have taken in, and tolerance for **duplicates and out-of-order delivery** (Meta retries failed deliveries for up to 7 days and says the server should deduplicate). For development, expose the local server with a tunnel of your choice; the kit does not include one.

Multi-tenant note: all your customers' events arrive at this one URL with one app secret. The kit finds the tenant from `entry[].changes[].value.metadata.phone_number_id`. If you run **one Meta app per customer** (different app secrets), pass `secrets: [{ secret, tenants: ["customer-a"] }, ...]`: a signature made with customer A's secret is then refused for an event that claims to belong to customer B.

If the signature check fails for a real delivery, the usual causes are: a JSON body parser ran before the check (use the raw bytes), the wrong app secret (the token or the verify token pasted by mistake), or a proxy that re-encodes the body.

## 6. Templates (Spanish example)

Outside the 24-hour customer service window, only an approved template may be sent. The kit sends a **utility** template with a **PDF document header**, three body variables and an opt-out footer. The wording below is an example (it is `DEFAULT_TEMPLATES.es.budget` in `src/templates.ts`, with variants for invoices and purchase orders, and English versions); the business must adapt it to its own voice and legal name.

| Part | Text |
|---|---|
| Name | `presupuesto_adjunto` (lowercase letters, digits and underscores only) |
| Language | `es` (docs list `es`, `es_AR`, `es_ES`, `es_MX`, ... a template exists per language; a send with a language code that has no approved template gives error `132001`, so the code in the template and in the send request must match) |
| Category | `UTILITY` |
| Header | Format `DOCUMENT` (the PDF is sent at message time) |
| Body | `Hola {{1}}, le enviamos el presupuesto N.º {{2}} de {{3}}. Encontrará el detalle en el PDF de arriba.` |
| Body examples | `María`, `P-2026-0042`, `Taller Ejemplo` |
| Footer | `Responda BAJA para no recibir más mensajes.` |

Variables: `{{1}}` customer name, `{{2}}` document number, `{{3}}` business name.

Create it (the kit has `templateCreationPayload(def)` that builds this JSON):

```
POST https://graph.facebook.com/v26.0/<WABA_ID>/message_templates
```

A `DOCUMENT` header needs an example file uploaded first through Meta's Resumable Upload API; the returned handle goes into `header_handle`. The kit's payload has an obviously fake placeholder there (`4::REPLACE_WITH_RESUMABLE_UPLOAD_HANDLE`) that must be replaced. The upload call itself is not implemented or tested in the kit.

What to expect (docs):

- Review can take up to 24 hours. An approved template has status `APPROVED`.
- A template whose content reads as marketing (discounts, "buy now") is **re-categorised as marketing** by Meta, which costs more and has different rules. Keep utility templates about the customer's own document or order and nothing else. The category is decided by Meta, not by the kit: see [COSTS.md](COSTS.md).
- Duplicate wording of an existing template is rejected.
- A template can later be paused or disabled for low quality (errors `132015` / `132016` at send time). The kit reports them in plain language and does not retry.
- Per tenant, the template name and language can be overridden (`tenants.templates_json`; `Store.upsertTenant({ templates: { budget: { name, language } } })`), so a customer with an already-approved template can use it, as long as it has the same three body variables and a document header.

**Unverified:** the JSON for passing the PDF into a template's document header at send time. Meta's pages show it for images; the kit builds the document version by analogy (`{ "type": "document", "document": { "id": ..., "filename": ... } }`). This is the first thing to confirm in the live test.

Free-form documents: if the customer wrote to you in the last 24 hours, the kit sends the PDF as an ordinary `document` message with a caption instead (no template, `mode: "auto"`). It needs no template, so it is also what you can test with before any template is approved, to a number that has written to you first.

## 7. Environment variables and tenants

`examples/own-app/wiring.ts` (`createWhatsAppIntegration(process.env)`) reads these. The library itself takes everything as arguments; `scripts/serve.ts` (the local demo) reads none and uses fictional values.

| Variable | Required | Meaning |
|---|---|---|
| `WHATSAPP_APP_SECRET` | yes | Meta app secret; HMAC key for `X-Hub-Signature-256` |
| `WHATSAPP_APP_SECRET_PREVIOUS` | no | The old secret, accepted during a rotation; remove it afterwards |
| `WHATSAPP_VERIFY_TOKEN` | yes | The string you typed into the Verify token field |
| `WHATSAPP_DB_PATH` | no | SQLite file (default `data/whatsapp.db`); the directory must exist |
| `WHATSAPP_GRAPH_VERSION` | no | Default `v26.0` (the version in the docs of 2026-11-01) |
| `WHATSAPP_GRAPH_BASE_URL` | no | Default `https://graph.facebook.com`; change only to point at a mock or a proxy |
| `WHATSAPP_CONFIRM_OPT_CHANGES` | no | `true` to answer STOP / BAJA and START / ALTA with a short confirmation |

Tenants are rows, not variables. For each customer:

```ts
store.upsertTenant({
  id: "taller-ar",              // your own tenant id
  name: "Taller Ejemplo SRL",   // used in the template's {{3}} and the caption
  phoneNumberId: "<PHONE_NUMBER_ID>",
  accessToken: "<token>",
  wabaId: "<WABA_ID>",
  defaultCountry: "AR",         // so "011 15 5550-0101" can be understood
  locale: "es",                 // "es" or "en": template wording and plain-language errors
});
```

`phone_number_id` is unique across tenants: two tenants cannot share a number.

## 8. Wire the two entry points into your app

1. **Webhook:** `GET /webhooks/whatsapp` calls `integration.verify(new URL(req.url, base).searchParams)`; `POST /webhooks/whatsapp` calls `integration.receive(rawBodyBuffer, req.headers)` and answers with the returned `status` and `body` (a text body as `text/plain`). Make sure the framework gives you the **raw** body for this route only.
2. **Button:** your "Send by WhatsApp" action, after your own login and permission checks, calls `integration.sender.sendDocument({...})` with the tenant id, document id, the number as typed, the PDF bytes (or a link) and the customer and document names. Show `result.message[locale]` to the user and store nothing else: the status shown next to the document comes from `Documents.history(...)`-style reads of the send log, which the webhook keeps up to date. `src/server.ts` and `src/documents.ts` show a complete working version of both with an example "documents" table.

## 9. Before the first real customer

Go through [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) with a real number you control. Do not skip the Argentine-number item: the docs do not describe Argentina at all, and the kit's behaviour there is a documented guess.
