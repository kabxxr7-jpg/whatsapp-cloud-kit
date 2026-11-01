import { describe, expect, it } from "vitest";
import { KNOWN_ERROR_CODES, describeError, errorDetails, mapWhatsAppError } from "../src/whatsapp-errors.ts";

const RETRYABLE = new Set([2, 4, 80007, 130429, 131056, 131016, 133004, 131057, 131000]);

describe("mapWhatsAppError", () => {
  it("maps 131026 (undeliverable) to a recipient problem, not retryable", () => {
    const e = mapWhatsAppError(131026);
    expect(e.key).toBe("undeliverable");
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("check_recipient");
    expect(e.es).toContain("no tiene WhatsApp");
    expect(e.en).toContain("not on WhatsApp");
  });

  it("maps 131047 (24-hour window) to 'send a template'", () => {
    const e = mapWhatsAppError(131047);
    expect(e.action).toBe("send_template");
    expect(e.retryable).toBe(false);
    expect(e.es).toContain("24 horas");
    expect(e.en).toContain("24 hours");
  });

  it("maps the template errors to template fixes", () => {
    expect(mapWhatsAppError(132001).key).toBe("template_missing");
    expect(mapWhatsAppError(132001).action).toBe("fix_template");
    expect(mapWhatsAppError(132000).key).toBe("template_param_count");
    expect(mapWhatsAppError(132000).action).toBe("fix_parameters");
    expect(mapWhatsAppError(132015).key).toBe("template_paused");
    expect(mapWhatsAppError(132016).key).toBe("template_disabled");
  });

  it("maps token errors to 'fix the token'", () => {
    for (const code of [0, 190, 200, 3, 10, 131005]) expect(mapWhatsAppError(code).action).toBe("fix_token");
  });

  it("marks exactly the documented load and availability codes as retryable", () => {
    for (const code of KNOWN_ERROR_CODES) {
      expect(mapWhatsAppError(code).retryable, `code ${code}`).toBe(RETRYABLE.has(code));
    }
  });

  it("tells the caller to wait 24 hours for the ecosystem limit", () => {
    const e = mapWhatsAppError(131049);
    expect(e.action).toBe("wait_24h");
    expect(e.retryable).toBe(false);
  });

  it("maps sender equals recipient", () => {
    expect(mapWhatsAppError(131021).key).toBe("same_sender_recipient");
  });

  it("gives unknown codes a generic, non-retryable entry that shows the code", () => {
    const e = mapWhatsAppError(999999);
    expect(e.key).toBe("unknown");
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("contact_support");
    expect(e.code).toBe(999999);
    expect(e.es).toContain("999999");
    expect(e.en).toContain("999999");
  });

  it("handles a missing code", () => {
    for (const code of [undefined, null]) {
      const e = mapWhatsAppError(code);
      expect(e.key).toBe("unknown");
      expect(e.code).toBe(-1);
      expect(e.es).toContain("sin código");
      expect(e.en).toContain("no code");
    }
  });

  it("has a unique code, a key and both languages for every entry", () => {
    expect(new Set(KNOWN_ERROR_CODES).size).toBe(KNOWN_ERROR_CODES.length);
    for (const code of KNOWN_ERROR_CODES) {
      const e = mapWhatsAppError(code);
      expect(e.code).toBe(code);
      expect(e.key).not.toBe("unknown");
      expect(e.es.length).toBeGreaterThan(15);
      expect(e.en.length).toBeGreaterThan(15);
      expect(e.es).not.toBe(e.en);
    }
  });
});

describe("describeError", () => {
  it("defaults to Spanish and can return English", () => {
    expect(describeError(131047)).toBe(mapWhatsAppError(131047).es);
    expect(describeError(131047, "en")).toBe(mapWhatsAppError(131047).en);
  });
});

describe("errorDetails", () => {
  it("prefers error_data.details, then message, then title", () => {
    expect(errorDetails({ error_data: { details: "D" }, message: "M", title: "T" })).toBe("D");
    expect(errorDetails({ message: "M", title: "T" })).toBe("M");
    expect(errorDetails({ title: "T" })).toBe("T");
    expect(errorDetails({})).toBe("");
    expect(errorDetails(undefined)).toBe("");
  });
});
