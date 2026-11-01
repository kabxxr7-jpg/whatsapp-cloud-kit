# Sources

Everything in this kit is written from Meta's public WhatsApp Business Platform documentation. Nothing was captured from a real WhatsApp account, Meta app, phone number or webhook delivery (there is no such account behind this project).

**Date read: 2026-11-01** (all pages below, same day).

How the pages were read: the docs site publishes a plain-markdown copy of each page by appending `.md` to the URL (index: `https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt`). Those copies were downloaded and read in full, so the quoted field names below are copied from the page text, not from a summary. Two older pages (marked "summary read") were only available through a summarising fetch helper, so their wording is a paraphrase and was used only for secondary points.

The docs have moved. The older `developers.facebook.com/docs/whatsapp/cloud-api/...` URLs now mostly answer "This page has moved" and point to `developers.facebook.com/documentation/business-messaging/whatsapp/...`. The Graph API version in the current examples is `v26.0`; the kit takes the version as a setting (default `v26.0`) and has not been run against any version.

Base for all URLs below: `https://developers.facebook.com/documentation/business-messaging/whatsapp/`

## Webhooks

| Page | Used for |
|---|---|
| `webhooks/create-webhook-endpoint` | GET verification: Meta sends `hub.mode=subscribe`, `hub.challenge` (a random string) and `hub.verify_token`; compare the token to the stored string; on a match answer HTTP 200 with the `hub.challenge` value, otherwise a 400-level status or anything other than 200. POST: header `X-Hub-Signature-256: sha256=<hash>`, where the hash is an **HMAC-SHA256** calculated with the post body payload as the message and the **app secret** as the key; compare to everything after `sha256=`; valid requests answered with 200. Batches of up to 1000 updates ("batching cannot be guaranteed"). Failed deliveries are retried immediately and then with decreasing frequency for 7 days; "Your server should handle deduplication". Unacknowledged responses are dropped after 7 days. "There are no APIs for fetching historical webhook data". TLS: valid certificate required, self-signed not supported. mTLS is supported. |
| `webhooks/overview` | Payload up to 3 MB. Retries "can result in duplicate webhook notifications". Meta's webhook IPs change periodically; mTLS is suggested instead of an IP allow-list. Permissions: `whatsapp_business_messaging` for `messages` webhooks. |
| `webhooks/reference/messages` | Shape of incoming-message and outgoing-status webhooks: `object: "whatsapp_business_account"`, `entry[].id`, `entry[].changes[].field: "messages"`, `value.messaging_product`, `value.metadata.display_phone_number`, `value.metadata.phone_number_id`, `value.contacts[].profile.name`, `value.contacts[].wa_id`, `value.messages[]` (`from`, `id`, `timestamp` as a string, `type`, `text.body`), `value.statuses[]`. "each outgoing message can have up to three separate webhooks (one for a status of sent, one for delivered, and one for read)". Errors can appear in `value.errors`, `value.messages[].errors` (type `unsupported`) and `value.statuses[].errors`. |
| `webhooks/reference/messages/status` | `statuses[]` fields: `id` (the wamid), `status`, `timestamp` (string), `recipient_id`, `biz_opaque_callback_data` (only if the business set it in the send request), `conversation` (omitted for v24.0+ except free entry point windows), `pricing` (`billable`, `pricing_model`, `type`, `category`), `errors[]` (`code` integer, `title`, `message`, `error_data.details`, `href`). Status values: `sent`, `delivered`, `read`, `failed`, `played` (voice messages only). Important: "In some cases ... the message is both delivered and read at the same time. In these cases, the 'delivered' webhook is not sent". `pricing` and `conversation` appear on `sent` plus one of `delivered`/`read`. The page says `title` and `message` are the same value. |
| `webhooks/reference/messages/errors` | System, app and account level errors arrive as `value.errors[]` with the same `code`/`title`/`message`/`error_data.details`/`href` fields. |
| `webhooks/reference/messages/text` | Incoming text message: `messages[].from`, `id`, `timestamp`, `type: "text"`, `text.body`; optional `context` and `referral`. Used for the STOP / opt-out handling and the customer-service-window clock. |
| `webhooks/reference/message_template_status_update` | Template status events (`APPROVED`, `REJECTED`, `PAUSED`, `DISABLED`, `FLAGGED`, ...) arrive on field `message_template_status_update`. The kit ignores this field but acknowledges it; see README Limits. |
| `business-scoped-user-ids` | Business-scoped user IDs (BSUID) and usernames: when a WhatsApp user adopts a username, `wa_id`, `from` and status `recipient_id` can be **omitted** from webhooks and `user_id` / `from_user_id` / `recipient_user_id` carry a BSUID such as `US.13491208655302741918`. The page carries the warning "Any changes described in this document are subject to change." Send requests may use `recipient` (BSUID) instead of `to`. The kit reads these fields defensively and never needs a phone number to match a status (it matches on the message id). |

## Sending

| Page | Used for |
|---|---|
| `messages/send-messages` | `POST /<PHONE_NUMBER_ID>/messages` with `messaging_product`, `recipient_type`, `to`, `type` and an object named after the type. Authorization is a bearer token. The 24-hour **customer service window** opens when a user messages (or calls); it resets on each new message; while open you can send free-form ("service") messages, after it closes only approved templates. Only message users who opted in. Response: `messaging_product`, `contacts[].input`, `contacts[].wa_id` ("May not match `input`"), `messages[].id`, `messages[].message_status` (only for templates). "This response only indicates that the API successfully accepted your request". Phone number formats: `+`, hyphens, parentheses and spaces are accepted; always include `+` and the country calling code, or the business number's country code is prepended. Note: "For Brazil and Mexico, the extra added prefix of the phone number may be modified by the Cloud API." Link media is cached for 10 minutes. Delivery order of multiple messages is not guaranteed. Default message TTL: 30 days. |
| `messages/document-messages` | Document message: `type: "document"`, `document.id` (uploaded media) **or** `document.link` (hosted; "not recommended" in favour of `id`), `document.caption` (max 1024 characters), `document.filename` ("with extension"). Supported types include `.pdf` (`application/pdf`), max 100 MB. |
| `business-phone-numbers/media` | `POST /<PHONE_NUMBER_ID>/media` as `multipart/form-data` with `messaging_product=whatsapp`, `file` and `type`; response `{ "id": "<MEDIA_ID>" }`. Uploaded media ids expire after 30 days. Document limit 100 MB. Mismatched MIME type is a common cause of error `131053`. |
| `reference/whatsapp-business-phone-number/message-api` | `BaseMessageProperties` (`messaging_product`, `recipient_type`, `to`, `type`, `context`), `MediaObject` ("Either `id` or `link` is required"), `message_status` values `accepted`, `held_for_quality_assessment`, `paused`. `biz_opaque_callback_data` is **not** listed in this schema excerpt; it is documented only in the status webhook reference above. |
| `templates/overview` | Template names: lowercase alphanumerics and underscores. Template send payload: `type: "template"`, `template.name`, `template.language.code`, `template.components[]` with `type: "body"` and `parameters[]` of `{ "type": "text", "text": ... }` (positional) or with `parameter_name` (named). Template must have status `APPROVED`. Review "can take up to 24 hours". 250 templates per unverified portfolio, 6,000 for a verified one. |
| `templates/template-media` | Media header send shape, shown for an image: component `{ "type": "header", "parameters": [ { "type": "image", "image": { "link": ... } } ] }`; "either upload your media asset ... and use its media ID (using the `id` property), or host the asset ... (using the `link` property)"; Meta recommends uploaded ids. |
| `templates/components` | Media header at creation: `format` `IMAGE`, `VIDEO`, `GIF` or `DOCUMENT`; an example for a utility `order_confirmation` template with a `DOCUMENT` header ("Tap the PDF linked above to view your receipt"). **Gap:** no page read shows the send-time JSON for a `document` header parameter. The kit builds `{ "type": "document", "document": { "id" or "link", "filename" } }` by analogy with the documented image header and the documented document message; third-party integration guides show the same shape, but that is not a Meta source. See README Limits. |
| `templates/supported-languages` | Spanish codes: `es`, `es_AR`, `es_CL`, `es_CO`, `es_ES`, `es_MX`, `es_PE`, `es_UY` and more. |
| `templates/template-categorization` | Utility templates must be non-promotional and specific to or requested by the user (order, account, transaction); a template with marketing content is re-categorised to marketing. |
| `getting-opt-in` | Businesses must obtain opt-in before messaging; the method is the business's choice but must state the business name and that the person opts in; "Provide clear instructions for how people can opt out ... and honor these requests". Meta does not define STOP keywords. |

## Errors

| Page | Used for |
|---|---|
| `support/error-codes` | Error body: `error.message` ("(#130429) Rate limit hit"), `error.type`, `error.code` (integer), `error.error_data.details`, `error.fbtrace_id`. "Meta recommends that you build your app's error handling logic around `code` values and `details`", and not on titles. Codes used by the kit: `131026` (cannot deliver: not a WhatsApp number, has not accepted the new terms, or old client), `131047` (more than 24 hours since the recipient last replied; send a template), `132000` (parameter count does not match the template), `132001` (template does not exist in that language or is not approved), `132012` (parameter format), `132015` / `132016` (template paused / permanently disabled), `132007` (policy), `130429` (Cloud API throughput reached), `131056` (pair rate limit: too many messages to the same recipient in a short period), `4` and `80007` (app / account rate limit), `131048` (spam-rate restriction), `131049` (healthy-ecosystem limit; wait at least 24 hours), `131050` (recipient stopped marketing messages), `130403` (business blocked the user), `131021` (sender equals recipient), `131009` (invalid parameter value), `131008` (missing parameter), `100` (invalid parameter), `131053` (media upload failed), `131000` / `131016` / `133004` / `2` / `1` (temporary or unknown service errors), `131057` (maintenance), `131042` (payment method), `131031` / `368` (account restricted), `190` / `0` / `3` / `10` / `200` (token or permission), `133010` (number not registered), `131062` (BSUID recipient not supported, from the BSUID page). **HTTP status per code is not documented** on the page (only for a few Marketing Messages API rows: 400 / 500), so the kit retries on HTTP 429 and 5xx *and* on the throttling codes. |
| `throughput` | 80 messages per second per number by default; over that, error `130429`. Sending too many messages to the same user number can give a pair rate-limit error. |
| `messaging-limits` | New portfolios start at 250 unique users per rolling 24 hours outside a customer service window; 2,000 after business verification (or by volume), then automatic scaling. |

## Phone numbers

| Page | Used for |
|---|---|
| `messages/send-messages`, `business-phone-numbers/phone-numbers` (section "WhatsApp user phone number formats") | The only statement about country-specific rewriting: the Brazil and Mexico note quoted above. **Argentina is not mentioned** on either page, nor on any other page read (`grep -i argentin` over all downloaded pages finds it only in the pricing pages: country calling code `54`, rate-card currency ARS, and an October 1, 2025 rate change). The docs say nothing about whether to send `+54 9 ...` or `+54 ...`, and nothing about which form appears in `recipient_id` / `from` / `wa_id` for an Argentine number. All examples use US numbers. |

## Pricing

| Page | Used for |
|---|---|
| `pricing` | Per-message pricing since July 1, 2025; charged for **delivered** messages only; five categories (marketing, utility, authentication, service, Meta Business Agent); rate depends on category and the recipient's country calling code; rates are published as CSV / PDF downloads per currency (not read: the numbers are not in the page text); Meta may change prices only on January 1, April 1, July 1 and October 1; from October 1, 2026 service messages are charged after 1,000 free ones per business phone number per month, and utility messages sent inside an open customer service window are charged; a payment method is required or service messages stop after the free tier. Argentina (54), Spain (34), Mexico (52), Brazil (55) and India (91) are standalone markets on the rate card; the United States (1) is priced in the "North America" region. |
| `pricing/conversation-based-pricing` | Marked deprecated; replaced by per-message pricing. Not used. |

## Setup

| Page | Used for |
|---|---|
| `get-started`, `access-tokens`, `permissions` | Create a Meta app with the WhatsApp use case, connect a Messaging account (WABA), a **system user** token with `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`; Tech Providers use Business Integration System User tokens obtained through Embedded Signup. |
| `business-phone-numbers/registration`, `business-phone-numbers/phone-numbers` | Add, verify, then **register** a number through the API (not through WhatsApp Manager). Eligible numbers must be owned, have a country and area code, and be able to receive voice calls or SMS. |
| `display-names` | A display name is required at registration and is verified when the messaging limit rises. |

## Summary reads (paraphrase only)

| URL | Used for |
|---|---|
| `https://developers.facebook.com/docs/graph-api/webhooks/getting-started` | The older Graph API page: `hub.mode` is always `subscribe`, `hub.challenge` is an integer to echo, signature in `X-Hub-Signature-256` prefixed `sha256=`, and "retry ... over 36 hours". That 36-hour figure **conflicts** with the 7 days on the two WhatsApp pages above; the kit allows a status event to be up to 8 days old by default for that reason. |

## Where the docs were unclear (carried into the README Limits)

1. Argentine numbers: not documented (see above). The kit sends the conventional international mobile form `+54 9 ...`, stores the `wa_id` the API answers with, and matches webhooks on a comparison key that ignores the Argentine mobile `9` and the Mexican `1`. Which behaviour Meta actually shows is unverified.
2. The send-time JSON for a document header parameter in a template (above).
3. HTTP status codes per error code (above), and whether a 5xx can mean "the message was created anyway". No idempotency key on the Messages API was found in the pages read.
4. The signature has no timestamp, so Meta's scheme gives no replay protection by itself; the kit adds a dedupe table and an age window on the payload's own timestamps.
5. Retry window (7 days vs 36 hours).
6. Rate-card numbers (CSV / PDF files, not read).
7. Business-scoped user IDs are marked "subject to change".
8. Whether non-ASCII characters in a signed body are escaped by Meta before signing is not covered by the pages read; the kit verifies the raw bytes it received, so it does not depend on the answer.
