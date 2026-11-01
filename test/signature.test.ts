import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeSignature, safeEqualStrings, verifySignature } from "../src/signature.ts";

const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] });

describe("computeSignature", () => {
  it("is sha256= plus the HMAC-SHA256 hex of the body keyed with the app secret", () => {
    // well-known HMAC-SHA256 test vector
    expect(computeSignature("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("gives the same result for a string and for its UTF-8 bytes", () => {
    expect(computeSignature("s", BODY)).toBe(computeSignature("s", Buffer.from(BODY)));
    expect(computeSignature("s", "Presupuesto N.º 42 – María")).toBe(computeSignature("s", Buffer.from("Presupuesto N.º 42 – María", "utf8")));
  });
});

describe("verifySignature", () => {
  const secrets = [{ secret: "app-secret" }];

  it("accepts a correct signature and returns the matching entry", () => {
    const r = verifySignature({ rawBody: BODY, header: computeSignature("app-secret", BODY), secrets });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry).toBe(secrets[0]);
  });

  it("accepts bytes as well as a string", () => {
    const r = verifySignature({ rawBody: Buffer.from(BODY), header: computeSignature("app-secret", BODY), secrets });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing or empty header", () => {
    expect(verifySignature({ rawBody: BODY, header: undefined, secrets })).toEqual({ ok: false, reason: "missing_header" });
    expect(verifySignature({ rawBody: BODY, header: "", secrets })).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects malformed headers", () => {
    const hex = createHmac("sha256", "app-secret").update(BODY).digest("hex");
    for (const header of [hex, "sha1=" + hex, "sha256=" + hex.slice(2), "sha256=" + hex + "00", "sha256=" + "z".repeat(64), "sha256= " + hex, "sha256="]) {
      expect(verifySignature({ rawBody: BODY, header, secrets }), header).toEqual({ ok: false, reason: "malformed_header" });
    }
  });

  it("rejects a signature made with another secret", () => {
    expect(verifySignature({ rawBody: BODY, header: computeSignature("other", BODY), secrets })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a body that changed by one byte", () => {
    const header = computeSignature("app-secret", BODY);
    expect(verifySignature({ rawBody: BODY.replace("1", "2"), header, secrets }).ok).toBe(false);
    expect(verifySignature({ rawBody: BODY + " ", header, secrets }).ok).toBe(false);
  });

  it("signs the exact bytes: the same JSON with different spacing does not verify", () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    const header = computeSignature("app-secret", pretty);
    expect(verifySignature({ rawBody: pretty, header, secrets }).ok).toBe(true);
    expect(verifySignature({ rawBody: BODY, header, secrets }).ok).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    expect(verifySignature({ rawBody: BODY, header: computeSignature("x", BODY), secrets: [] })).toEqual({ ok: false, reason: "no_secrets" });
  });

  it("supports secret rotation: the old and the new secret both verify", () => {
    const rotation = [{ secret: "new-secret" }, { secret: "old-secret" }];
    const withOld = verifySignature({ rawBody: BODY, header: computeSignature("old-secret", BODY), secrets: rotation });
    const withNew = verifySignature({ rawBody: BODY, header: computeSignature("new-secret", BODY), secrets: rotation });
    expect(withOld.ok && withOld.entry.secret).toBe("old-secret");
    expect(withNew.ok && withNew.entry.secret).toBe("new-secret");
  });

  it("returns the entry so the caller can check which tenants it may speak for", () => {
    const entry = { secret: "tenant-a-secret", tenants: ["taller-ar"] };
    const r = verifySignature({ rawBody: BODY, header: computeSignature("tenant-a-secret", BODY), secrets: [{ secret: "x" }, entry] });
    expect(r.ok && r.entry.tenants).toEqual(["taller-ar"]);
  });

  it("rejects an all-zero signature", () => {
    expect(verifySignature({ rawBody: BODY, header: "sha256=" + "0".repeat(64), secrets }).ok).toBe(false);
  });
});

describe("safeEqualStrings", () => {
  it("compares equal and different strings, including different lengths", () => {
    expect(safeEqualStrings("abc", "abc")).toBe(true);
    expect(safeEqualStrings("abc", "abd")).toBe(false);
    expect(safeEqualStrings("abc", "abcd")).toBe(false);
    expect(safeEqualStrings("", "")).toBe(true);
    expect(safeEqualStrings("", "x")).toBe(false);
    expect(safeEqualStrings("contraseña", "contraseña")).toBe(true);
    expect(safeEqualStrings("contraseña", "contrasena")).toBe(false);
  });
});
