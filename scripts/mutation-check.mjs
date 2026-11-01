#!/usr/bin/env node
// Mutation check: applies one deliberate breakage at a time to a COPY of the project, runs the test suite, and reports
// whether any test noticed. A mutant that survives means the tests do not pin that behaviour down. The real tree is
// never modified.
//
//   npm run mutation-check                     run every mutant (one at a time), exit 1 unless every one is killed
//   npm run mutation-check -- --list           list the mutants
//   npm run mutation-check -- --validate       check every mutant applies and typechecks (no test runs)
//   npm run mutation-check -- --only sig-skip-compare,st-no-dedupe
//   npm run mutation-check -- --timeout 300    per-mutant hard timeout in seconds (default: generous, from the baseline)
//   npm run mutation-check -- --json out.json  also write the results as JSON
//   npm run mutation-selftest                  prove the harness itself: a planted hang must be reported as TIMEOUT
//                                              (not as a kill) and its whole process tree must be gone afterwards
//
// Rules of this harness:
//   * concurrency 1: one vitest run at a time, never two heavy commands together;
//   * load gate: before every heavy command it waits (60 s polls, 20 min at most) until the 1-minute load average is
//     below --max-load (default 6), and gives up loudly instead of running on a loaded machine;
//   * hard timeout: every child runs in its own process group; on timeout the whole group (vitest, its workers, and
//     anything they spawned) gets SIGKILL, and the harness verifies the group is gone. A timeout is reported as
//     TIMEOUT. It is NOT counted as a kill, and it makes the run fail.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each mutant: `find` (or each pair in `edits`) must occur exactly once in `file`; it is replaced by `replace`.
 * `area` is only for the report. Every mutant must change behaviour; none is expected to be equivalent.
 */
const MUTANTS = [
  // ---- signature check ---------------------------------------------------------------------------------------------
  { id: "sig-skip-compare", area: "signature", file: "src/signature.ts", what: "accept any well-formed header (skip the HMAC comparison)",
    find: "if (timingSafeEqual(expected, supplied) && found === undefined) found = entry;", replace: "if (found === undefined) found = entry;" },
  { id: "sig-first-secret-only", area: "signature", file: "src/signature.ts", what: "check only the first secret (breaks rotation)",
    find: "for (const entry of secrets) {", replace: "for (const entry of secrets.slice(0, 1)) {" },
  { id: "sig-normalise-body", area: "signature", file: "src/signature.ts", what: "verify a whitespace-trimmed copy of the body instead of the raw bytes",
    find: 'const expected = createHmac("sha256", entry.secret).update(rawBody).digest();',
    replace: 'const expected = createHmac("sha256", entry.secret).update(Buffer.from(rawBody).toString("utf8").trim()).digest();' },
  { id: "sig-plain-equals", area: "signature", file: "src/signature.ts", what: "compare digests with a normal (non constant-time) equality",
    find: "if (timingSafeEqual(expected, supplied) && found === undefined) found = entry;", replace: "if (expected.equals(supplied) && found === undefined) found = entry;" },
  { id: "sig-token-early-exit", area: "signature", file: "src/signature.ts", what: "verify-token compare short-circuits on length instead of comparing digests",
    find: "return timingSafeEqual(ha, hb);", replace: "return a.length === b.length && ha.equals(hb);" },
  { id: "sig-accept-short-hex", area: "signature", file: "src/signature.ts", what: "accept a header with fewer hex digits",
    find: "const HEADER_RE = /^sha256=([0-9a-fA-F]{64})$/;", replace: "const HEADER_RE = /^sha256=([0-9a-fA-F]{64}|)$/;" },

  // ---- webhook: verification, signature handling, replay window, tenant routing --------------------------------------
  { id: "hook-verify-any-token", area: "webhook", file: "src/webhook.ts", what: "accept any hub.verify_token",
    find: 'if (!match) return { status: 403, contentType: "application/json", body: { error: "verify_token_mismatch" } };', replace: "" },
  { id: "hook-challenge-wrapped", area: "webhook", file: "src/webhook.ts", what: "answer the challenge wrapped in JSON instead of the bare value",
    find: 'return { status: 200, contentType: "text/plain", body: challenge };', replace: 'return { status: 200, contentType: "application/json", body: { challenge } };' },
  { id: "hook-skip-signature", area: "webhook", file: "src/webhook.ts", what: "treat every POST as correctly signed",
    find: 'const sig = verifySignature({ rawBody: input.rawBody, header: header(input.headers, "x-hub-signature-256"), secrets: config.secrets });',
    replace: 'const sig = { ok: true, entry: { secret: "" } } as ReturnType<typeof verifySignature>;' },
  { id: "hook-unsigned-403", area: "webhook", file: "src/webhook.ts", what: "answer an unsigned request 403 instead of 401",
    find: 'const status = sig.reason === "missing_header" || sig.reason === "malformed_header" ? 401 : 403;', replace: "const status = 403;" },
  { id: "hook-mismatch-401", area: "webhook", file: "src/webhook.ts", what: "answer a wrong signature 401 instead of 403",
    find: 'const status = sig.reason === "missing_header" || sig.reason === "malformed_header" ? 401 : 403;', replace: "const status = 401;" },
  { id: "hook-no-age-check", area: "webhook", file: "src/webhook.ts", what: "accept events of any age (no replay window)",
    find: "if (ts !== null && (now - ts > maxAge || ts - now > maxFuture)) {", replace: "if (false) {" },
  { id: "hook-age-off-by-one", area: "webhook", file: "src/webhook.ts", what: "reject an event exactly at the maximum age",
    find: "now - ts > maxAge", replace: "now - ts >= maxAge" },
  { id: "hook-future-unbounded", area: "webhook", file: "src/webhook.ts", what: "accept events dated in the future",
    find: "|| ts - now > maxFuture", replace: "|| false" },
  { id: "hook-route-first-tenant", area: "webhook", file: "src/webhook.ts", what: "route every event to the first tenant instead of by phone_number_id",
    find: "const tenant = phoneNumberId ? store.tenantByPhoneNumberId(phoneNumberId) : undefined;", replace: "const tenant = phoneNumberId ? store.listTenants()[0] : undefined;" },
  { id: "hook-secret-any-tenant", area: "webhook", file: "src/webhook.ts", what: "let a tenant-restricted secret sign for any tenant",
    find: "if (sig.entry.tenants !== undefined && !sig.entry.tenants.includes(tenant.id)) {", replace: "if (false) {" },
  { id: "hook-storage-error-200", area: "webhook", file: "src/webhook.ts", what: "answer 200 when storing the event failed (Meta would not retry)",
    find: 'return { status: 500, contentType: "application/json", body: { error: "processing_failed" } };', replace: 'return { status: 200, contentType: "application/json", body: { error: "processing_failed" } };' },
  { id: "hook-always-confirm", area: "webhook", file: "src/webhook.ts", what: "send STOP/START confirmations even when they are turned off",
    find: "config.confirmOptChanges !== false", replace: "true" },
  { id: "hook-no-identity-link", area: "webhook", file: "src/webhook.ts", what: "ignore the wa_id / user_id pairs in contacts[]",
    find: "if (waId && userId) store.linkIdentity(tenantId, userId, matchKey(waId));", replace: "" },

  // ---- idempotency and the send path -------------------------------------------------------------------------------------
  { id: "snd-key-without-tenant", area: "idempotency", file: "src/sender.ts", what: "idempotency key ignores the tenant",
    find: "baseKey: `${tenant.id}|${input.documentId}|${contactKey}`,", replace: "baseKey: `${input.documentId}|${contactKey}`," },
  { id: "snd-key-raw-digits", area: "idempotency", file: "src/sender.ts", what: "idempotency key uses the raw digits (the same person in two number forms is two recipients)",
    find: "const contactKey = matchKey(phone.digits);", replace: "const contactKey = phone.digits;" },
  { id: "snd-no-duplicate-guard", area: "idempotency", file: "src/sender.ts", what: "send again even though a message id already exists",
    find: 'if (row.wamid !== null) return { outcome: "duplicate", send: row, message: MSG.duplicate };\n      const stale',
    replace: "const stale" },
  { id: "snd-no-inflight-guard", area: "idempotency", file: "src/sender.ts", what: "start a second request while the first is still running",
    find: 'if (row.status === "pending" && !stale) return { outcome: "in_flight", send: row, message: MSG.in_flight };', replace: "" },
  { id: "db-resend-while-pending", area: "idempotency", file: "src/db.ts", what: "a deliberate resend may start while the previous send is not finished",
    find: "if (!(n.resend && finished)) return", replace: "if (!n.resend) return" },
  { id: "db-event-key-without-ts", area: "idempotency", file: "src/db.ts", what: "treat a repeated status with another timestamp as the same event",
    find: "UNIQUE (tenant_id, wamid, status, ts)", replace: "UNIQUE (tenant_id, wamid, status)" },
  { id: "snd-no-set-route", area: "idempotency", file: "src/sender.ts", what: "a retried send keeps the route of its first attempt",
    find: "      store.setRoute(row.id, { kind, templateName: kind === \"template\" ? choice.name : null, language: kind === \"template\" ? choice.language : null });\n", replace: "" },
  { id: "snd-no-retry-in-doubt-gate", area: "idempotency", file: "src/sender.ts", what: "retry a send of unknown outcome without being asked to",
    find: "if (inDoubt && input.retryInDoubt !== true) return", replace: "if (false) return" },

  // ---- retry and backoff ------------------------------------------------------------------------------------------------
  { id: "snd-no-retry-on-429", area: "retry", file: "src/sender.ts", what: "never retry (429 / 5xx / throttling codes)",
    find: "const retry = reply.status === 429 || reply.status >= 500 || info.retryable;", replace: "const retry = false;" },
  { id: "snd-retry-client-errors", area: "retry", file: "src/sender.ts", what: "retry every API error, including client errors",
    find: "const retry = reply.status === 429 || reply.status >= 500 || info.retryable;", replace: "const retry = true;" },
  { id: "snd-backoff-flat", area: "retry", file: "src/sender.ts", what: "constant delay instead of exponential backoff",
    find: "this.baseDelayMs * 2 ** (attempt - 1)", replace: "this.baseDelayMs" },
  { id: "snd-retry-after-uncapped", area: "retry", file: "src/sender.ts", what: "obey any Retry-After value, however long",
    find: "Math.min(retryAfterMs, 60_000)", replace: "retryAfterMs" },
  { id: "snd-one-retry-fewer", area: "retry", file: "src/sender.ts", what: "give up one attempt early",
    find: "if (attempt > this.maxRetries) return { reply, classified: c };", replace: "if (attempt >= this.maxRetries) return { reply, classified: c };" },
  { id: "snd-ambiguous-always-retried", area: "retry", file: "src/sender.ts", what: "retry an unclear outcome even when told not to",
    find: "if (c.ambiguous && !ambiguousRetryable) return { reply, classified: c };", replace: "" },
  { id: "snd-timeout-failed-not-unknown", area: "retry", file: "src/sender.ts", what: "report an unclear outcome as a plain failure",
    find: "if (c.ambiguous) {\n      const unknown", replace: "if (false) {\n      const unknown" },

  // ---- window rule and opt-out ---------------------------------------------------------------------------------------------
  { id: "snd-window-inverted", area: "window", file: "src/sender.ts", what: "free-form inside the window becomes template and vice versa",
    find: 'const kind = mode === "template" ? "template" : windowOpen ? "document" : "template";', replace: 'const kind = mode === "template" ? "template" : windowOpen ? "template" : "document";' },
  { id: "snd-freeform-outside-window", area: "window", file: "src/sender.ts", what: "allow a forced free-form send outside the window",
    find: 'if (mode === "freeform" && !windowOpen) return { outcome: "outside_window", send: null, message: MSG.outside_window };', replace: "" },
  { id: "in-window-closed-at-25h", area: "window", file: "src/inbound.ts", what: "window lasts 48 hours",
    find: "export const WINDOW_SECONDS = 24 * 60 * 60;", replace: "export const WINDOW_SECONDS = 48 * 60 * 60;" },
  { id: "in-window-boundary", area: "window", file: "src/inbound.ts", what: "window still open at exactly 24 hours",
    find: "nowSeconds - last < WINDOW_SECONDS", replace: "nowSeconds - last <= WINDOW_SECONDS" },
  { id: "in-window-always-open", area: "window", file: "src/inbound.ts", what: "the window is always open",
    find: "return last !== null && nowSeconds - last < WINDOW_SECONDS;", replace: "return true;" },
  { id: "in-window-not-opened", area: "window", file: "src/inbound.ts", what: "an inbound message does not open the window",
    find: "store.touchConversation(tenantId, contactKey, msg.ts);", replace: "" },
  { id: "db-window-shrinks", area: "window", file: "src/db.ts", what: "an older message moves the window back",
    find: "last_inbound_at = MAX(last_inbound_at, excluded.last_inbound_at)", replace: "last_inbound_at = excluded.last_inbound_at" },
  { id: "snd-optout-ignored", area: "opt-out", file: "src/sender.ts", what: "send documents to numbers that opted out",
    find: 'if (store.isOptedOut(tenant.id, contactKey)) return { outcome: "blocked_opt_out", send: null, message: MSG.blocked_opt_out };', replace: "" },
  { id: "snd-text-optout-ignored", area: "opt-out", file: "src/sender.ts", what: "send free-form replies to numbers that opted out",
    find: 'if (purpose === "reply" && store.isOptedOut(tenant.id, contactKey)) return', replace: "if (false) return" },
  { id: "in-optout-not-recorded", area: "opt-out", file: "src/inbound.ts", what: "STOP is recognised but not recorded",
    find: 'if (action === "opt_out") store.optOut(tenantId, contactKey, keyword!, msg.wamid, msg.ts);', replace: "" },
  { id: "in-optin-not-recorded", area: "opt-out", file: "src/inbound.ts", what: "START does not lift the opt-out",
    find: 'if (action === "opt_in") store.optIn(tenantId, contactKey, keyword!, msg.wamid, msg.ts);', replace: "" },
  { id: "in-keyword-substring", area: "opt-out", file: "src/inbound.ts", what: "any message that contains a keyword is an opt-out",
    find: 'if (config.optOut.some((k) => normalizeKeyword(k) === n)) return "opt_out";', replace: 'if (config.optOut.some((k) => n.includes(normalizeKeyword(k)))) return "opt_out";' },
  { id: "in-keyword-case-sensitive", area: "opt-out", file: "src/inbound.ts", what: "keywords are case-sensitive",
    find: "    .toLowerCase()\n", replace: "" },
  { id: "in-keyword-accents", area: "opt-out", file: "src/inbound.ts", what: "keywords are accent-sensitive",
    find: '    .replace(/\\p{Diacritic}/gu, "")\n', replace: "" },
  { id: "in-keyword-any-type", area: "opt-out", file: "src/inbound.ts", what: "an image or sticker can opt a person out",
    find: 'const action = msg.type === "text" ? classifyKeyword(msg.text, keywords) : null;', replace: "const action = classifyKeyword(msg.text, keywords);" },
  { id: "in-duplicate-reprocessed", area: "opt-out", file: "src/inbound.ts", what: "process a duplicate inbound message again",
    find: "if (!inserted) return { duplicate: true };", replace: "" },
  { id: "in-bsuid-not-linked", area: "opt-out", file: "src/inbound.ts", what: "never learn which phone number a user id belongs to",
    find: "if (phoneKey && who.bsuid) store.linkIdentity(tenantId, who.bsuid, phoneKey);", replace: "" },
  { id: "db-optout-lookup-inverted", area: "opt-out", file: "src/db.ts", what: "isOptedOut answers the opposite",
    find: 'opt_outs WHERE tenant_id = ? AND contact_key = ?").get(tenantId, contactKey) !== undefined;', replace: 'opt_outs WHERE tenant_id = ? AND contact_key = ?").get(tenantId, contactKey) === undefined;' },

  // ---- error mapping ------------------------------------------------------------------------------------------------------------
  { id: "err-window-code-retryable", area: "error mapping", file: "src/whatsapp-errors.ts", what: "131047 (outside the 24-hour window) is treated as retryable instead of 'send a template'",
    find: 'e(131047, "reengagement_window", false, "send_template",', replace: 'e(131047, "reengagement_window", true, "retry_later",' },
  { id: "err-undeliverable-retryable", area: "error mapping", file: "src/whatsapp-errors.ts", what: "131026 (not on WhatsApp) is retried",
    find: 'e(131026, "undeliverable", false, "check_recipient",', replace: 'e(131026, "undeliverable", true, "check_recipient",' },
  { id: "err-throughput-not-retryable", area: "error mapping", file: "src/whatsapp-errors.ts", what: "130429 (throughput) is not retried",
    find: 'e(130429, "throughput", true, "retry_later",', replace: 'e(130429, "throughput", false, "retry_later",' },
  { id: "err-unknown-retryable", area: "error mapping", file: "src/whatsapp-errors.ts", what: "unknown codes are treated as retryable",
    find: '    key: "unknown",\n    retryable: false,', replace: '    key: "unknown",\n    retryable: true,' },
  { id: "err-languages-swapped", area: "error mapping", file: "src/sender.ts", what: "Spanish and English texts swapped in API error mapping",
    find: "es: info.es, en: info.en },", replace: "es: info.en, en: info.es }," },
  { id: "err-details-order", area: "error mapping", file: "src/whatsapp-errors.ts", what: "technical detail prefers the title over error_data.details",
    find: 'return err.error_data?.details ?? err.message ?? err.title ?? "";', replace: 'return err.title ?? err.error_data?.details ?? err.message ?? "";' },
  { id: "err-token-error-retried", area: "error mapping", file: "src/whatsapp-errors.ts", what: "an expired token (190) is marked retryable",
    find: 'e(190, "token_expired", false, "fix_token",', replace: 'e(190, "token_expired", true, "fix_token",' },
  { id: "err-describe-language", area: "error mapping", file: "src/whatsapp-errors.ts", what: "describeError ignores the requested language",
    find: 'return lang === "es" ? info.es : info.en;', replace: "return info.es;" },

  // ---- status ordering ---------------------------------------------------------------------------------------------------------------
  { id: "st-status-can-go-down", area: "status ordering", file: "src/statuses.ts", what: "a lower-ranked status overwrites a higher one",
    find: '} else if ((RANK[ev.status] ?? 0) > (RANK[cur.status] ?? 0)) {', replace: '} else if ((RANK[ev.status] ?? 0) < (RANK[cur.status] ?? 0) || cur.status === "accepted") {' },
  { id: "st-read-not-implying-delivered", area: "status ordering", file: "src/statuses.ts", what: "a read without delivered does not count as delivered",
    find: "if (d.deliveredAt === null) {", replace: "if (false) {" },
  { id: "st-failed-beats-delivered", area: "status ordering", file: "src/statuses.ts", what: "a late failed status overwrites delivered / read",
    find: 'if ((RANK[cur.status] ?? 0) >= RANK["delivered"]!) {', replace: "if (false) {" },
  { id: "st-latest-time-wins", area: "status ordering", file: "src/statuses.ts", what: "keep the latest time seen for a status instead of the earliest",
    find: "(current === null ? next : Math.min(current, next))", replace: "(current === null ? next : Math.max(current, next))" },
  { id: "st-late-sent-clears-failure", area: "status ordering", file: "src/statuses.ts", what: "a late sent status clears a failure",
    find: 'if (ev.status !== "sent") {', replace: "if (true) {" },
  { id: "st-no-dedupe", area: "status ordering", file: "src/db.ts", what: "a duplicate status event is reported as new and processed again",
    find: "return Number(info.changes) === 1 ? Number(info.lastInsertRowid) : null;", replace: "return Number(info.lastInsertRowid);" },
  { id: "st-cross-tenant-apply", area: "tenant routing", file: "src/statuses.ts", what: "apply a status to another tenant's send",
    find: 'if (other && other.tenantId !== ev.tenantId) return { result: "other_tenant" };', replace: "if (other && other.tenantId !== ev.tenantId) send = other;" },
  { id: "st-no-adoption", area: "status ordering", file: "src/statuses.ts", what: "never adopt a message id from a status that carries our reference",
    find: "if (byRef.wamid === null) {", replace: 'if (byRef.wamid === null && ev.wamid === "") {' },
  { id: "db-wamid-lookup-any-tenant", area: "tenant routing", file: "src/db.ts", what: "look a message id up across all tenants",
    find: 'SELECT * FROM sends WHERE tenant_id = ? AND wamid = ?").get(tenantId, wamid) as Row | undefined;', replace: 'SELECT * FROM sends WHERE (? IS NOT NULL) AND wamid = ?").get(tenantId, wamid) as Row | undefined;' },
  { id: "db-ref-lookup-any-tenant", area: "tenant routing", file: "src/db.ts", what: "match a send reference across all tenants",
    find: 'SELECT * FROM sends WHERE tenant_id = ? AND ref = ?").get(tenantId, ref) as Row | undefined;', replace: 'SELECT * FROM sends WHERE (? IS NOT NULL) AND ref = ?").get(tenantId, ref) as Row | undefined;' },

  // ---- per-tenant credentials ----------------------------------------------------------------------------------------------------------
  { id: "snd-token-of-first-tenant", area: "tenant routing", file: "src/sender.ts", what: "authenticate with the first tenant's token",
    find: "authorization: `Bearer ${tenant.accessToken}`", replace: "authorization: `Bearer ${this.store.listTenants()[0]!.accessToken}`" },
  { id: "snd-number-of-first-tenant", area: "tenant routing", file: "src/sender.ts", what: "send from the first tenant's phone_number_id",
    find: "const url = `${this.baseUrl}/${this.version}/${tenant.phoneNumberId}/${path}`;", replace: "const url = `${this.baseUrl}/${this.version}/${this.store.listTenants()[0]!.phoneNumberId}/${path}`;" },
  { id: "snd-media-never-reused", area: "idempotency", file: "src/sender.ts", what: "never reuse an uploaded media id",
    find: "if (cached) return { ok: true, id: cached };", replace: "void cached;" },
  { id: "snd-dead-media-kept", area: "idempotency", file: "src/sender.ts", what: "a media id the API refused stays in the cache and is reused",
    find: "if (uploadedMediaId !== undefined) store.dropCachedMedia(tenant.id, uploadedMediaId);", replace: "void uploadedMediaId;" },
  { id: "db-media-never-expires", area: "idempotency", file: "src/db.ts", what: "cached media ids never expire",
    find: 'return (r["expires_at"] as number) > now ? (r["media_id"] as string) : null;', replace: 'return r["media_id"] as string;' },

  // ---- phone normalisation ----------------------------------------------------------------------------------------------------------------
  { id: "ph-ar-no-mobile-9", area: "normalisation", file: "src/phone.ts", what: "Argentine numbers written without the 9 stay without it",
    find: "if (!mobile && assumeMobile) {", replace: "if (false) {" },
  { id: "ph-ar-15-prefix", area: "normalisation", file: "src/phone.ts", what: "the local 15 mobile prefix is not recognised",
    find: 'if (rest.slice(areaLength, areaLength + 2) === "15") {', replace: 'if (rest.slice(areaLength, areaLength + 2) === "16") {' },
  { id: "ph-ar-trunk-0", area: "normalisation", file: "src/phone.ts", what: "the leading 0 of Argentine national numbers is kept",
    find: '    rest = rest.slice(1);\n    notes.push("argentina_removed_trunk_0");', replace: '    notes.push("argentina_removed_trunk_0");' },
  { id: "ph-ar-area-code", area: "normalisation", file: "src/phone.ts", what: "any first digit is accepted as an Argentine area code",
    find: 'if (!/^[1-3]/.test(rest)) return fail("bad_area_code", raw);', replace: "" },
  { id: "ph-mx-keep-1", area: "normalisation", file: "src/phone.ts", what: "the historic Mexican mobile 1 is kept",
    find: 'if (rest.length === 11 && rest.startsWith("1") && options.mexicoDropMobile1 !== false) {', replace: "if (false) {" },
  { id: "ph-mx-old-prefix", area: "normalisation", file: "src/phone.ts", what: "the old 044 / 045 / 01 Mexican prefixes are kept",
    find: "const old = /^(044|045|01)/.exec(rest);", replace: "const old = null as RegExpExecArray | null;" },
  { id: "ph-es-too-long", area: "normalisation", file: "src/phone.ts", what: "Spanish numbers may have extra digits",
    find: 'if (rest.length > 9) return fail("bad_length", raw);', replace: "" },
  { id: "ph-br-ninth-digit", area: "normalisation", file: "src/phone.ts", what: "a nine-digit Brazilian subscriber may start with any digit",
    find: 'if (subscriber[0] !== "9") return fail("bad_leading_digit", raw);', replace: "" },
  { id: "ph-in-leading-digit", area: "normalisation", file: "src/phone.ts", what: "Indian numbers may start with any digit",
    find: 'if (rest.length > 10) return fail("bad_length", raw);\n  if (!/^[6-9]/.test(rest)) return fail("bad_leading_digit", raw);', replace: 'if (rest.length > 10) return fail("bad_length", raw);' },
  { id: "ph-es-leading-digit", area: "normalisation", file: "src/phone.ts", what: "Spanish numbers may start with any digit",
    find: 'if (rest.length > 9) return fail("bad_length", raw);\n  if (!/^[6-9]/.test(rest)) return fail("bad_leading_digit", raw);', replace: 'if (rest.length > 9) return fail("bad_length", raw);' },
  { id: "ph-us-area-code", area: "normalisation", file: "src/phone.ts", what: "US area codes may start with 0 or 1",
    find: 'if (!/^[2-9]/.test(rest)) return fail("bad_area_code", raw);', replace: "" },
  { id: "ph-key-ar-9", area: "normalisation", file: "src/phone.ts", what: "matchKey keeps the Argentine 9 (the same person compares unequal)",
    find: 'if (rest.length === 11 && rest.startsWith("9")) return "54" + rest.slice(1);', replace: "" },
  { id: "ph-key-mx-1", area: "normalisation", file: "src/phone.ts", what: "matchKey keeps the Mexican 1",
    find: 'if (rest.length === 11 && rest.startsWith("1")) return "52" + rest.slice(1);', replace: "" },
  { id: "ph-key-br-9", area: "normalisation", file: "src/phone.ts", what: "matchKey keeps the Brazilian ninth digit",
    find: 'if (rest.length === 11 && rest[2] === "9") return "55" + rest.slice(0, 2) + rest.slice(3);', replace: "" },
  { id: "ph-plus-in-middle", area: "normalisation", file: "src/phone.ts", what: "a plus sign in the middle is reported as invalid characters",
    find: 'return fail(/^[+0-9]+$/.test(compact) ? "misplaced_plus" : "invalid_characters", raw);', replace: 'return fail("invalid_characters", raw);' },
  { id: "ph-generic-too-long", area: "normalisation", file: "src/phone.ts", what: "numbers over 15 digits are accepted",
    find: 'if (digits.length > 15) return fail("too_long", raw);', replace: "" },

  // ---- demo server --------------------------------------------------------------------------------------------------------------------------
  { id: "srv-no-body-limit", area: "server", file: "src/server.ts", what: "effectively remove the request body size limit",
    edits: [["if (Number.isFinite(declared) && declared > limit) {", "if (Number.isFinite(declared) && declared > limit * 1000) {"], ["if (total > limit) {", "if (total > limit * 1000) {"]] },
  { id: "srv-port-range-open", area: "server", file: "src/server.ts", what: "listenInRange accepts ports below 4750",
    find: "from < PORT_MIN ||", replace: "from < 1024 ||" },
  { id: "srv-leaks-error", area: "server", file: "src/server.ts", what: "an internal error answers with its message",
    find: '{ error: "internal_error" });\n      else res.end();', replace: '{ error: err instanceof Error ? err.message : "internal_error" });\n      else res.end();' },
  { id: "srv-optout-http-200", area: "server", file: "src/server.ts", what: "a blocked opt-out answers 200",
    find: "blocked_opt_out: 422,", replace: "blocked_opt_out: 200," },
  { id: "srv-failed-http-200", area: "server", file: "src/server.ts", what: "a failed send answers 200",
    find: "failed: 502,", replace: "failed: 200," },
];

// ---------------------------------------------------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const MAX_LOAD = Number(opt("--max-load", process.env.MUTATION_MAX_LOAD ?? "6"));
const POLL_SECONDS = Number(opt("--poll-sec", "60"));
const MAX_WAIT_MINUTES = Number(opt("--max-wait-min", "20"));

// ---------------------------------------------------------------------------------------------------------------------
// process handling
// ---------------------------------------------------------------------------------------------------------------------
const activeGroups = new Set();

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reapGroup(pid) {
  // after the leader exited there may still be workers or grandchildren in the group: kill them and confirm
  killGroup(pid);
  for (let i = 0; i < 50; i++) {
    if (!groupAlive(pid)) return true;
    await sleep(100);
    killGroup(pid);
  }
  return !groupAlive(pid);
}

/** Run a command in its own process group with a hard timeout. Always leaves no process of that group behind. */
function run(cmd, cmdArgs, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid === undefined) {
      resolve({ code: null, signal: null, timedOut: false, stdout: "", stderr: "spawn failed", leftover: false, ms: 0 });
      return;
    }
    activeGroups.add(pid);
    let stdout = "";
    let stderr = "";
    const cap = (s, chunk) => (s + chunk).slice(-2_000_000);
    child.stdout.on("data", (d) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(pid);
    }, timeoutMs);
    let finished = false;
    const finish = async (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const gone = await reapGroup(pid);
      activeGroups.delete(pid);
      resolve({ code, signal, timedOut, stdout, stderr, leftover: !gone, ms: Date.now() - started });
    };
    child.on("close", finish);
    child.on("error", (err) => {
      stderr += String(err);
      void finish(null, null);
    });
  });
}

function killEverything() {
  for (const pid of activeGroups) killGroup(pid);
}

// ---------------------------------------------------------------------------------------------------------------------
// load gate
// ---------------------------------------------------------------------------------------------------------------------
async function waitForLoad(label) {
  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  let announced = false;
  for (;;) {
    const load = os.loadavg()[0];
    if (load < MAX_LOAD) return;
    if (Date.now() >= deadline) {
      console.error(`load average stayed at ${load.toFixed(1)} (limit ${MAX_LOAD}) for ${MAX_WAIT_MINUTES} minutes before ${label}; giving up instead of running on a loaded machine.`);
      throw new LoadTimeout();
    }
    if (!announced) console.log(`waiting for the machine to calm down before ${label} (1-minute load ${load.toFixed(1)}, need < ${MAX_LOAD})...`);
    announced = true;
    await sleep(POLL_SECONDS * 1000);
  }
}
class LoadTimeout extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------------------------------------------------
// "declared but never used" (TS6133 and its relatives) only says that a mutant left a variable behind; the code still
// runs, so it is not a reason to discard the mutant. Any other compiler error makes the mutant INVALID.
const UNUSED_CODES = new Set(["TS6133", "TS6192", "TS6196", "TS6198", "TS6199", "TS6205"]);
function firstRealTypeError(output) {
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const errors = lines.filter((l) => /\berror TS\d+:/.test(l));
  if (errors.length === 0) return lines[0] ?? "typecheck failed with no output";
  const real = errors.find((l) => !UNUSED_CODES.has(/\berror (TS\d+):/.exec(l)[1]));
  return real ?? null;
}

function applyMutant(original, m) {
  const edits = m.edits ?? [[m.find, m.replace]];
  let mutated = original;
  for (const [find, replace] of edits) {
    const occurrences = mutated.split(find).length - 1;
    if (occurrences !== 1) return { error: `find-string occurs ${occurrences} times (must be exactly 1); the source changed` };
    mutated = mutated.replace(find, () => replace);
  }
  if (mutated === original) return { error: "mutant does not change the file" };
  return { mutated };
}

function parseVitestJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function firstFailure(json) {
  for (const file of json.testResults ?? []) {
    const bad = (file.assertionResults ?? []).find((a) => a.status === "failed");
    if (bad) return `${String(file.name).split("/test/").pop()} > ${bad.fullName}`;
  }
  return null;
}

/**
 * Run `mutants` against a throwaway copy of `root`. `entries` are the files and folders to copy.
 * Returns { baseline, results }.
 */
async function runMutants({ root, entries, mutants, timeoutSec, typecheck, validateOnly, label }) {
  const work = join(root, `.mutation-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const entry of entries) if (existsSync(join(root, entry))) cpSync(join(root, entry), join(work, entry), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  process.on("exit", cleanup);

  const bin = (name) => join(work, "node_modules", ".bin", name);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_NO_WARNINGS: "1", CI: "1" };
  const resultFile = join(work, "result.json");
  // No --bail: with it, vitest's JSON report sometimes shows no failing test although the run failed (seen in 1 of 6 runs
  // of the same mutant), which cannot be told apart from a crash. The whole suite takes a few seconds.
  const vitestArgs = ["run", "--reporter=json", `--outputFile=${resultFile}`];

  try {
    let baseline = null;
    let perMutantMs = timeoutSec * 1000;
    if (!validateOnly) {
      await waitForLoad("the baseline run");
      console.log(`${label}: baseline run of the unmodified copy...`);
      const t0 = Date.now();
      baseline = await run(bin("vitest"), vitestArgs, { cwd: work, env, timeoutMs: Math.max(timeoutSec, 300) * 1000 });
      const json = parseVitestJson(resultFile);
      if (baseline.timedOut || baseline.code !== 0 || !json || json.numFailedTests > 0 || baseline.leftover) {
        console.error(`baseline did not pass cleanly (timedOut=${baseline.timedOut}, exit=${baseline.code}, leftover processes=${baseline.leftover}).`);
        console.error((baseline.stdout + baseline.stderr).split("\n").slice(-30).join("\n"));
        return { baseline: { ok: false }, results: [] };
      }
      const baselineSec = (Date.now() - t0) / 1000;
      console.log(`${label}: baseline passed in ${baselineSec.toFixed(1)} s (${json.numPassedTests} tests)`);
      // "generous": at least the requested timeout, and never less than 15 times the baseline
      perMutantMs = Math.max(timeoutSec, Math.ceil(baselineSec * 15)) * 1000;
      console.log(`${label}: per-mutant hard timeout ${Math.round(perMutantMs / 1000)} s`);
    }

    const results = [];
    for (const m of mutants) {
      const original = readFileSync(join(root, m.file), "utf8");
      const applied = applyMutant(original, m);
      if (applied.error) {
        results.push({ ...m, status: "INVALID", why: applied.error });
        console.log(`INVALID   ${m.id}: ${applied.error}`);
        continue;
      }
      const target = join(work, m.file);
      writeFileSync(target, applied.mutated);
      try {
        if (typecheck) {
          await waitForLoad(`typechecking ${m.id}`);
          const tc = await run(bin("tsc"), ["--noEmit"], { cwd: work, env, timeoutMs: 180_000 });
          const realError = tc.timedOut || tc.code === 0 ? null : firstRealTypeError(tc.stdout || tc.stderr);
          if (tc.timedOut || realError !== null) {
            const why = tc.timedOut ? "typecheck timed out" : "mutant does not typecheck: " + realError;
            results.push({ ...m, status: "INVALID", why });
            console.log(`INVALID   ${m.id}: ${why}`);
            continue;
          }
        }
        if (validateOnly) {
          results.push({ ...m, status: "VALID", why: "" });
          console.log(`valid     ${m.id}`);
          continue;
        }
        // One attempt at a verdict. ERROR means "no verdict" (the run ended without a failing test being reported).
        const attempt = async () => {
          await waitForLoad(`mutant ${m.id}`);
          rmSync(resultFile, { force: true });
          const r = await run(bin("vitest"), vitestArgs, { cwd: work, env, timeoutMs: perMutantMs });
          let entry;
          if (r.timedOut) {
            entry = { ...m, status: "TIMEOUT", why: `no verdict within ${Math.round(perMutantMs / 1000)} s; process group killed${r.leftover ? "; SOME PROCESSES SURVIVED THE KILL" : ""}` };
          } else if (r.code === 0) {
            entry = { ...m, status: "SURVIVED", why: "" };
          } else {
            const json = parseVitestJson(resultFile);
            const failed = json ? firstFailure(json) : null;
            if (failed) entry = { ...m, status: "KILLED", why: failed };
            else if (json && json.numFailedTestSuites > 0) entry = { ...m, status: "KILLED", why: "a test file failed to run (suite-level failure)", suiteLevel: true };
            else {
              const tail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join(" | ").slice(-500);
              entry = { ...m, status: "ERROR", why: `tests exited with code ${r.code} but no failing test was reported; last output: ${tail}` };
            }
          }
          if (r.leftover) entry.leftover = true;
          return entry;
        };
        let entry = await attempt();
        if (entry.status === "ERROR") {
          // a run that ends without a verdict (a crashed worker, a port clash on a busy machine) is repeated once; the
          // retry is recorded in the result, never hidden
          console.log(`ERROR     ${m.id}: first run gave no verdict (${entry.why}); running it once more`);
          const firstWhy = entry.why;
          entry = await attempt();
          entry.retried = true;
          entry.firstRun = firstWhy;
        }
        results.push(entry);
        console.log(`${entry.status.padEnd(9)} ${m.id}${entry.status === "KILLED" ? `  <- ${entry.why}` : entry.why ? `  (${entry.why})` : ""}${entry.retried ? "  [after a retry]" : ""}`);
      } finally {
        writeFileSync(target, original);
      }
    }
    return { baseline: { ok: true }, results };
  } finally {
    cleanup();
  }
}

function summarise(results) {
  const killed = results.filter((r) => r.status === "KILLED");
  const survived = results.filter((r) => r.status === "SURVIVED");
  const timeouts = results.filter((r) => r.status === "TIMEOUT");
  const invalid = results.filter((r) => r.status === "INVALID");
  const errors = results.filter((r) => r.status === "ERROR");
  const valid = results.length - invalid.length;
  return { killed, survived, timeouts, invalid, errors, valid };
}

function printSummary(results) {
  const { killed, survived, timeouts, invalid, errors, valid } = summarise(results);
  console.log("\nMutation check");
  console.log("--------------");
  console.log(`mutants run : ${results.length} (${invalid.length} invalid)`);
  console.log(`killed      : ${killed.length}${killed.some((k) => k.suiteLevel) ? ` (${killed.filter((k) => k.suiteLevel).length} by a suite-level failure)` : ""}`);
  console.log(`survived    : ${survived.length}`);
  console.log(`timeout     : ${timeouts.length}   (a timeout is NOT a kill: no verdict)`);
  console.log(`error       : ${errors.length}`);
  console.log(`kill rate   : ${valid === 0 ? "n/a" : `${((killed.length / valid) * 100).toFixed(1)}%`} (${killed.length}/${valid})`);
  const byArea = new Map();
  for (const r of results) {
    const a = byArea.get(r.area) ?? { killed: 0, total: 0 };
    a.total++;
    if (r.status === "KILLED") a.killed++;
    byArea.set(r.area, a);
  }
  for (const [area, a] of byArea) console.log(`  ${area.padEnd(16)} ${a.killed}/${a.total}`);
  for (const s of survived) console.log(`  SURVIVED ${s.id}: ${s.what}  [${s.file}]`);
  for (const s of timeouts) console.log(`  TIMEOUT  ${s.id}: ${s.why}`);
  for (const s of errors) console.log(`  ERROR    ${s.id}: ${s.why}`);
  for (const s of invalid) console.log(`  INVALID  ${s.id}: ${s.why}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// self test: a planted hang
// ---------------------------------------------------------------------------------------------------------------------
function processesWithMarker(marker) {
  const ps = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" });
  return (ps.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("ps -axo"))
    .map((line) => line.trim());
}

async function selftest() {
  const marker = `MUTATION_SELFTEST_${process.pid}_${Date.now()}`;
  const dir = join(ROOT, `.mutation-selftest-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "selftest", type: "module", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2023"], types: ["node"], strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true }, include: ["src", "test"] }),
  );
  writeFileSync(join(dir, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], maxWorkers: 1, testTimeout: 60000 } });\n`);
  writeFileSync(
    join(dir, "src", "target.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export function untested(x: number): number {",
      "  return x * 2;",
      "}",
      "export function slow(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  // The slow() test first starts a grandchild that would outlive its parent, then calls slow(). The planted mutant turns
  // slow() into a synchronous infinite loop, which vitest's own test timeout cannot interrupt.
  writeFileSync(
    join(dir, "test", "target.test.ts"),
    [
      'import { spawn } from "node:child_process";',
      'import { expect, it } from "vitest";',
      'import { add, slow } from "../src/target.ts";',
      'it("adds", () => { expect(add(2, 3)).toBe(5); });',
      'it("slow returns 1 (and leaves a sleeping grandchild behind)", () => {',
      `  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ${JSON.stringify(marker)}], { stdio: "ignore" });`,
      "  child.unref();",
      "  expect(slow()).toBe(1);",
      "});",
      "",
    ].join("\n"),
  );

  const mutants = [
    { id: "selftest-killed", area: "selftest", file: "src/target.ts", what: "add() subtracts", find: "return a + b;", replace: "return a - b;" },
    { id: "selftest-survived", area: "selftest", file: "src/target.ts", what: "untested() triples (no test looks)", find: "return x * 2;", replace: "return x * 3;" },
    { id: "selftest-hang", area: "selftest", file: "src/target.ts", what: "slow() loops forever", find: "export function slow(): number {\n  return 1;\n}", replace: "export function slow(): number {\n  for (;;) {\n    /* planted hang */\n  }\n}" },
  ];

  const problems = [];
  const t0 = Date.now();
  let outcome;
  try {
    outcome = await runMutants({ root: dir, entries: ["src", "test", "package.json", "tsconfig.json", "vitest.config.ts"], mutants, timeoutSec: 20, typecheck: true, validateOnly: false, label: "selftest" });
  } catch (err) {
    if (err instanceof LoadTimeout) return 3;
    throw err;
  }
  if (!outcome.baseline.ok) {
    console.error("SELFTEST FAILED: the baseline of the tiny project did not pass");
    return 1;
  }
  const by = Object.fromEntries(outcome.results.map((r) => [r.id, r]));
  const expectStatus = (id, status) => {
    if (by[id]?.status !== status) problems.push(`${id}: expected ${status}, got ${by[id]?.status ?? "nothing"}`);
  };
  expectStatus("selftest-killed", "KILLED");
  expectStatus("selftest-survived", "SURVIVED");
  expectStatus("selftest-hang", "TIMEOUT");
  if (by["selftest-hang"] && by["selftest-hang"].status === "KILLED") problems.push("the planted hang was counted as KILLED: a timeout must not count as a kill");
  if (by["selftest-hang"]?.leftover) problems.push("processes survived the kill of the planted hang's process group");
  const remaining = processesWithMarker(marker);
  if (remaining.length > 0) problems.push(`processes still running after the run (marker ${marker}): ${remaining.join(" | ")}`);
  const { killed, timeouts } = summarise(outcome.results);
  if (killed.some((k) => k.id === "selftest-hang")) problems.push("hang counted in killed");
  if (timeouts.length !== 1) problems.push(`expected exactly 1 timeout, got ${timeouts.length}`);

  printSummary(outcome.results);
  console.log(`\nselftest took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (problems.length > 0) {
    console.error("\nSELFTEST FAILED");
    for (const p of problems) console.error("  - " + p);
    return 1;
  }
  console.log("SELFTEST OK: killed -> KILLED, untested -> SURVIVED, planted hang -> TIMEOUT (not a kill), and no process of the hung run was left behind.");
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  if (flag("--selftest")) return selftest();

  if (flag("--list")) {
    for (const m of MUTANTS) console.log(`${m.id.padEnd(34)} ${m.area.padEnd(16)} ${m.file.padEnd(24)} ${m.what}`);
    console.log(`\n${MUTANTS.length} mutants`);
    return 0;
  }

  const ids = new Set();
  for (const m of MUTANTS) {
    if (ids.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
    ids.add(m.id);
  }
  const onlyArg = opt("--only", null);
  const only = onlyArg ? new Set(onlyArg.split(",")) : null;
  const selected = only ? MUTANTS.filter((m) => only.has(m.id)) : MUTANTS;
  if (selected.length === 0) {
    console.error("no mutants selected");
    return 2;
  }

  const entries = ["src", "test", "testing", "scripts", "fixtures", "examples", "package.json", "tsconfig.json", "vitest.config.ts"];
  let outcome;
  try {
    outcome = await runMutants({
      root: ROOT,
      entries,
      mutants: selected,
      timeoutSec: Number(opt("--timeout", "180")),
      typecheck: true,
      validateOnly: flag("--validate"),
      label: "mutation-check",
    });
  } catch (err) {
    if (err instanceof LoadTimeout) return 3;
    throw err;
  }
  if (!outcome.baseline.ok && !flag("--validate")) return 2;

  const jsonPath = opt("--json", null);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(outcome.results.map(({ id, area, file, what, status, why }) => ({ id, area, file, what, status, why })), null, 2));

  if (flag("--validate")) {
    const bad = outcome.results.filter((r) => r.status === "INVALID");
    console.log(`\n${outcome.results.length - bad.length}/${outcome.results.length} mutants apply and typecheck`);
    return bad.length > 0 ? 1 : 0;
  }
  printSummary(outcome.results);
  const { survived, timeouts, invalid, errors } = summarise(outcome.results);
  return survived.length + timeouts.length + invalid.length + errors.length > 0 ? 1 : 0;
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killEverything();
    process.exit(130);
  });
}
process.on("exit", killEverything);

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    killEverything();
    process.exit(2);
  },
);
