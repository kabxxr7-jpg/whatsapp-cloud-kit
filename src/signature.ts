// X-Hub-Signature-256 verification.
//
// Per Meta's "Create a webhook endpoint" page: the header is `sha256=<hash>`, where <hash> is an HMAC-SHA256 of the
// POST body used as the message and the app secret as the key. The check must be made over the exact bytes received:
// parsing the JSON and serialising it again can change the bytes (key order, spacing, escapes) and break the match.
//
// The scheme has no timestamp, so the signature alone does not stop a replay of an old, genuine request; the webhook
// handler adds an age check on the payload's own timestamps and a dedupe table for that.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SecretEntry {
  secret: string;
  /** If set, this secret may only sign events for these tenants (one Meta app per customer). */
  tenants?: readonly string[] | undefined;
}

export type SignatureFailure = "missing_header" | "malformed_header" | "no_secrets" | "mismatch";

export type SignatureResult =
  | { ok: true; entry: SecretEntry }
  | { ok: false; reason: SignatureFailure };

export function computeSignature(secret: string, rawBody: Uint8Array | string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

const HEADER_RE = /^sha256=([0-9a-fA-F]{64})$/;

export function verifySignature(params: {
  rawBody: Uint8Array | string;
  header: string | undefined;
  secrets: readonly SecretEntry[];
}): SignatureResult {
  const { rawBody, header, secrets } = params;
  if (header === undefined || header === "") return { ok: false, reason: "missing_header" };
  const match = HEADER_RE.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed_header" };
  if (secrets.length === 0) return { ok: false, reason: "no_secrets" };
  const supplied = Buffer.from(match[1]!, "hex");

  // Compare against every secret (no early exit) so the time taken does not depend on which one matched.
  let found: SecretEntry | undefined;
  for (const entry of secrets) {
    const expected = createHmac("sha256", entry.secret).update(rawBody).digest();
    if (timingSafeEqual(expected, supplied) && found === undefined) found = entry;
  }
  return found ? { ok: true, entry: found } : { ok: false, reason: "mismatch" };
}

/** Constant-time string comparison for the GET verify token (hashes first so lengths do not leak). */
export function safeEqualStrings(a: string, b: string): boolean {
  const ha = createHmac("sha256", "verify-token-compare").update(a).digest();
  const hb = createHmac("sha256", "verify-token-compare").update(b).digest();
  return timingSafeEqual(ha, hb);
}
