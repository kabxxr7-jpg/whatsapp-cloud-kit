# What WhatsApp messages cost (and what this kit costs to run)

**Source and date.** Meta's pricing page (`.../whatsapp/pricing`), read on **2026-11-01**. The page said it reflects pricing "effective as of October 1, 2026". Meta may change prices only on January 1, April 1, July 1 and October 1, with at least 1 month of notice for a rate-card change, 3 months for an add-on to the pricing model and 6 months for a change of the model itself. Re-read the page before quoting a client a number: a quote based on this file after **2027-01-01** may already be wrong.

**What this file cannot give you: the rates.** The page publishes the per-message rates only as downloadable CSV and PDF files, one set per currency (USD, EUR, ARS, MXN, BRL, INR and 10 more), and an interactive table on a separate site. The numbers are **not in the page text**, those files were **not read**, and this file does not quote a rate it did not see. The one price figure that does appear in the page text is an illustration inside a comparison with an AI-agent service: "0.68 cents per message" for a utility or authentication message to Brazil, "based on Meta's current rate". That is one market, one category, one day, and it says nothing about Argentina or Spain. To price a real project, open the CSV for the currency the client's Messaging account uses and read the row for the recipient country and category.

## How Meta charges

| Rule | What the page says |
|---|---|
| Unit | Per **delivered** message, since 2025-07-01. A message that is only sent, or fails, is not charged |
| Direction | Only business-to-user messages. Messages from users to the business are free |
| Rate depends on | The message **category** and the recipient's **country calling code** ("market"): Argentina is `54`, Spain `34`, Mexico `52`, Brazil `55`, India `91`; the United States (`1`) is priced inside a "North America" region. 47 markets on the card: 39 named countries and 8 regions; a country not listed is "Other" |
| Currency | Chosen when the Messaging account is created and not changeable afterwards (the page mentions migration APIs). ARS is one of the 16 currencies |
| Payment method | Required. From 2026-10-01, a Messaging account with no payment method gets its service messages stopped once the free tier is used up |

### Categories (one message has exactly one)

| Category | What it is | In this kit |
|---|---|---|
| **Utility** | A template for a transactional or informational purpose | The PDF template (`presupuesto_adjunto` etc.): used outside the 24-hour window |
| **Marketing** | A template with a promotional purpose | **Not used.** If Meta decides your "utility" template reads as promotional it re-categorises it as marketing, which is priced differently. Keep wording strictly about the customer's own document |
| **Authentication** | A template for identity verification (one-time codes) | Not used |
| **Service** | Any non-template message sent inside an open 24-hour customer service window, not powered by Meta's own agent | The free-form PDF with a caption: used when the customer wrote in the last 24 hours (`mode: "auto"`) |
| **Meta Business Agent** | A non-template message produced by Meta's agent product, $2.00 per 1M tokens (about 4 to 5 US cents a message, no volume tiers, no free tier) | Not used |

### What is free

- Every message **to** the business.
- The first **1,000 service messages per business phone number per month** (resets monthly, no roll-over). Applies from 2026-10-01; before that date service messages were free without a limit.
- Marketing, utility, authentication and service messages inside a **free entry point window**: when a user starts a chat from a Click-to-WhatsApp ad and the business answers inside the window, the window can stay open for up to 7 days (Meta Business Agent messages stay charged). Not relevant unless the business runs such ads.

### Volume tiers

For **utility and authentication only**: lower rates at higher monthly volumes, per market and category, counted across all Messaging accounts of the business portfolio, resetting monthly, counting only charged messages. The tier boundaries are in a separate CSV per currency (also not read).

## Reading this for the "Send by WhatsApp" job

These points are my reading of the page, not Meta's statements about this kit:

1. A PDF sent as a **template** (the case whenever the customer has not written in the last 24 hours) is **utility**: one charge per delivered message, at the utility rate of the recipient's country.
2. A PDF sent **free-form inside the window** is **service**: free for the first 1,000 per number per month, then charged at the service rate. From 2026-10-01 a **utility template** sent inside an open window is also charged (it used to be free), so sending a template inside the window no longer saves anything compared with the free-form document, which is why `mode: "auto"` prefers free-form when the window is open.
3. Only **delivered** messages are charged. A number that is not on WhatsApp (error `131026`), a failed send, or a message that is blocked by the kit's opt-out check costs nothing.
4. The cost is per message, so **one document sent twice costs twice**. The kit's duplicate protection (one message per tenant, document and recipient unless the user chooses "send again") is also a cost control.
5. The kit also answers STOP / BAJA with a confirmation when `WHATSAPP_CONFIRM_OPT_CHANGES=true`. That confirmation is a free-form message inside the window the customer just opened, so it counts as a service message.
6. Cost for a tenant is therefore roughly: (number of documents sent by template that were delivered) x (utility rate for the country) + (free-form documents delivered beyond the first 1,000 per month) x (service rate for the country), minus volume-tier discounts. Fill the two rates from the CSV.
7. Whose bill? The Messaging account that owns the phone number and its payment method. In a multi-tenant product decide up front whether each customer connects their own account (they pay Meta directly: usual for Embedded Signup) or you hold one account and re-bill them (then you need per-tenant message counts and the rate card to do it).

**Not implemented:** the status webhook carries a `pricing` object (`billable`, `pricing_model`, `category`, `type`) and the kit **does not store it**, so there is no per-tenant cost report. It is in the fixtures' shape and would be a small addition (a column on `status_events`), but it was not built or tested.

## Other costs

| Item | Cost |
|---|---|
| This kit | MIT licence, no fee. Runs on Node's built-in SQLite and `fetch`; no paid service |
| Meta app, webhook subscription, templates, phone number registration | The page does not charge for these; the phone number itself (a SIM, a virtual number) is the business's own expense and was not priced |
| Hosting for the webhook | A server with a valid TLS certificate (self-signed is not supported by Meta). Any small host |
| Business verification | Meta does not list a fee on the pages read. Ask for the current page; it takes the client's time more than money |

## Throughput and limits that affect planning (not prices)

- Default **80 messages per second** per phone number (error `130429` above that); the kit retries with backoff.
- **Messaging limit** for a new portfolio: 250 unique customers per rolling 24 hours outside a service window, 2,000 after business verification, then automatic scaling. This is a limit on how many different people you can start a conversation with by template per day: relevant for the first roll-out to a large customer list.
- A pair rate limit exists (error `131056`) for too many messages to the same number in a short time.
