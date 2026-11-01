# Go-live checklist

This kit has **never run on WhatsApp or Meta**. Everything it was tested against is a local mock of the Graph API and signed fixtures written from Meta's public documentation. This checklist is the list of things only a live run can settle. Tick an item only when you saw it happen on a real account, and write what you saw in the "Observed" column: several items exist because the documentation was silent or unclear and the kit made a documented guess.

```
Ran on Meta on:            <date>            (blank until it happens)
Run by:                    <name>
Graph API version used:    <v26.0 or other>
Messaging account (WABA):  <id, last 4 digits only in this file>
Phone number id:           <id, last 4 digits only in this file>
Numbers tested with:       <country and kind only, never the full number>
Kit commit:                <git hash>
```

Do not paste tokens, app secrets or full phone numbers into this file or into a commit.

## A. Accounts and permissions

| # | Check | Observed |
|---|---|---|
| A1 | Business portfolio exists; business verification started (date) or finished (date) | |
| A2 | Meta app created with the WhatsApp use case; app secret copied to the secret store, not the repo | |
| A3 | Phone number added, verified and **registered through the API** (`/register`), two-step PIN stored | |
| A4 | System user token created with `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`; its expiry choice noted | |
| A5 | Display name approved. Current messaging limit read from the account (250 or 2,000 unique customers per 24 h) | |
| A6 | The number is not also in use in the regular WhatsApp app, or the coexistence rules were read and followed | |

## B. Webhook

| # | Check | Observed |
|---|---|---|
| B1 | Callback URL saved in the App Dashboard: Meta's GET verification answered by the kit (`200` with the challenge) | |
| B2 | App subscribed to the `messages` field; also subscribed on the WABA (`/<WABA_ID>/subscribed_apps`) if the account is not the app's own | |
| B3 | A **real** delivery arrives with a valid `X-Hub-Signature-256` (computed over the raw bytes with the app secret). Record: any non-ASCII text in the body, and whether the raw bytes verified (docs silent on escaping) | |
| B4 | The webhook answers within a few seconds and Meta stops retrying (no duplicate arrivals of the same status after a `200`) | |
| B5 | A forged request (right path, wrong signature) from outside is refused with `403` and logged | |
| B6 | TLS certificate valid (self-signed is refused by Meta) and renewal automated | |
| B7 | Events for each tenant arrive with the `metadata.phone_number_id` stored on the tenant row | |

## C. Sending

| # | Check | Observed |
|---|---|---|
| C1 | Free-form `text` to your own number **after** it has written to the business: accepted, delivered | |
| C2 | Free-form `document` by **media id** (upload to `/media`, then message): accepted, the PDF opens, filename and caption as sent | |
| C3 | Template created with a **DOCUMENT header** (the example upload handle replaces the placeholder in `templateCreationPayload`); status `APPROVED`; the **category Meta assigned** (utility or re-categorised): ______ | |
| C4 | **Send-time JSON of the document header parameter.** The kit sends `{"type":"header","parameters":[{"type":"document","document":{"id":"...","filename":"..."}}]}`, a guess by analogy with the documented image header. Accepted as is? If not, write the shape that worked and change `buildTemplateMessage` | |
| C5 | Template body variables in the order `{{1}}` name, `{{2}}` number, `{{3}}` business: rendered correctly in Spanish (accents, `N.º`) | |
| C6 | The response to the first send: record `contacts[0].input`, `contacts[0].wa_id` and `messages[0].id` exactly; `message_status` present or not | |
| C7 | `biz_opaque_callback_data` accepted on the Messages API (the reference page's schema excerpt does not list it) **and** echoed back in the status webhook as the correlation ref | |
| C8 | A deliberately wrong template name or language: the real error code and HTTP status (expected `132001`); the kit's plain-language message shown | |
| C9 | Document limits: a 5 MB PDF works; the kit's own checks (extension, size, caption length 1,024) match what the API accepts | |
| C10 | Media id reuse: the same PDF sent to a second recipient reuses the cached media id (no second upload) and Meta accepts it; a different PDF gets a new upload; after 30 days an id is expired (the cache keeps ids for 29 days) and a send with a dead id recovers by uploading again | |

## D. Phone numbers (Argentina first)

The documentation says nothing about Argentina. The kit sends the canonical mobile form `+54 9 <area> <number>`, keeps the `wa_id` the API answers with, and compares numbers with a key that ignores the Argentine `9` after `54` (and the Mexican `1`, and the Brazilian ninth digit). Record what really happens:

| # | Check | Observed |
|---|---|---|
| D1 | Send to an Argentine mobile typed three ways: `011 15 5555-1234`, `+54 11 5555-1234`, `+54 9 11 5555-1234`. Which are accepted, and what is `wa_id` for each? | |
| D2 | The webhook `statuses[].recipient_id` and inbound `messages[].from` for that number: with or without the `9`? Does the kit still link them to the send? (It matches a status to its send by message id and by the correlation ref, not by number; the number only drives opt-out and window state, via `matchKey`.) | |
| D3 | The same for a number outside Argentina you will really use: Spain, Mexico (`1` after `52`), Brazil (ninth digit), plus any other | |
| D4 | A number that is **not on WhatsApp**: the error, whether it comes synchronously or as a `failed` status, its code (expected `131026`) | |
| D5 | If `matchKey` guessed wrong anywhere, fix `src/phone.ts` and add a test with the observed forms before shipping | |

## E. Statuses and ordering

| # | Check | Observed |
|---|---|---|
| E1 | The sequence for a message read at once: is `delivered` skipped (the docs say it can be)? The send log still ends at `read` | |
| E2 | Any out-of-order or repeated status seen in the first 100 sends? The log never went backwards | |
| E3 | A `failed` status for a real failure: code, `title`, `message`, `error_data.details` and `href` as received; the kit's text is accurate | |
| E4 | `sent` without any later status for a day: how it shows in the document list | |
| E5 | A reply from a recipient with a WhatsApp username (BSUID) if such an account is available: which of `from`, `wa_id`, `user_id` arrive | |

## F. Window, opt-out, opt-in

| # | Check | Observed |
|---|---|---|
| F1 | Customer writes; within 24 hours the kit sends the PDF free-form; after 24 hours (use a test number) it falls back to the template and Meta agrees (no `131047`) | |
| F2 | The window clock: the kit measures from the inbound message's own timestamp. Compare against the moment Meta started rejecting free-form sends | |
| F3 | Customer replies `BAJA` / `STOP`: next "Send by WhatsApp" is refused by the kit without calling Meta; confirmation message delivered if enabled | |
| F4 | Customer replies `ALTA` / `START`: sending works again | |
| F5 | Where the business records **how and when each customer opted in** (Meta requires opt-in; the kit does not collect it) | |
| F6 | Keywords in use match what your customers really type (the kit matches the whole message only: "baja" yes, "quiero la baja" no) | |

## G. Errors, retries and duplicates

| # | Check | Observed |
|---|---|---|
| G1 | Send a burst above the rate limit (or watch for `130429`): the kit backs off and no message is sent twice | |
| G2 | Kill the process between the upload and the message: restart, retry; one message only | |
| G3 | Network cut after the request was written: the send is "in doubt", not "failed", and the operator can see it | |
| G4 | Real HTTP status for each error code you meet (the docs do not list them): update `src/whatsapp-errors.ts` if the retry decision was wrong | |
| G5 | Meta's retry of an undelivered webhook after you return `500` on purpose once: the retry is accepted and does not duplicate | |

## H. Multi-tenant

| # | Check | Observed |
|---|---|---|
| H1 | Two tenants on two numbers (or two test numbers): each send uses its own token and number; status events land on the right tenant | |
| H2 | An event for a number you did not register is acknowledged and counted, not an error loop | |
| H3 | If one Meta app per customer: `secrets[].tenants` limits each secret to its tenant | |

## I. Money

| # | Check | Observed |
|---|---|---|
| I1 | A payment method is on the Messaging account (without one, service messages stop after the first 1,000 a month) | |
| I2 | The rate card for the account's currency downloaded; the real utility and service rates for each country in use written into [COSTS.md](COSTS.md) with the date | |
| I3 | For the first 20 delivered messages, the `pricing` object of the status webhook (`billable`, `category`, `pricing_model`) compared with the invoice line. The kit does not store this object yet | |
| I4 | The category on a delivered template is `utility`, not `marketing` | |

## J. Operations

| # | Check | Observed |
|---|---|---|
| J1 | Access tokens kept out of logs and error reports. The kit stores them in plain text in SQLite: encrypt the volume or move them to a secret store | |
| J2 | Customer phone numbers are personal data: retention period, deletion on request, and log redaction decided | |
| J3 | Alert on: a burst of `failed` statuses, webhook non-200 rate, a token error (`190`, `200`), template paused or disabled (`132015` / `132016`; the template-status webhook is not handled) | |
| J4 | Database backup and restore tried once | |
| J5 | Procedure for rotating the app secret (set `WHATSAPP_APP_SECRET_PREVIOUS` first) and the access token | |

## What I expect the first live run to change

Listed so that nobody is surprised, in rough order of likelihood:

1. The template document-header JSON (C4).
2. The `wa_id` / `recipient_id` form for Argentine numbers (D1, D2) and the `matchKey` rule.
3. HTTP status codes per error code and therefore which failures are retried (G4).
4. Whether `biz_opaque_callback_data` is echoed as the docs say (C7), which the late-adoption and double-send detection depend on.
5. The category Meta gives the template (C3, I4).
6. Wording the template reviewers reject (the Spanish text in [SETUP-GUIDE.md](SETUP-GUIDE.md) is an example, not an approved text).

## Sign-off

```
All A to J items either ticked with an observation, or marked "not applicable" with a reason:  [ ]
Ran on Meta on: ______________________   by: ______________________
```
