import { describe, expect, it } from "vitest";
import { asCountryCode, isBsuid, matchKey, normalizePhone, phoneErrorMessage, type PhoneErrorCode, type PhoneOptions } from "../src/phone.ts";

function good(input: string, options?: PhoneOptions) {
  const r = normalizePhone(input, options);
  if (!r.ok) throw new Error(`expected ${input} to be valid, got ${r.code}`);
  return r;
}

function bad(input: string, options?: PhoneOptions) {
  const r = normalizePhone(input, options);
  if (r.ok) throw new Error(`expected ${input} to be invalid, got ${r.e164}`);
  return r;
}

describe("Argentina", () => {
  it("turns a local mobile number (0 area 15 number) into +54 9 area number", () => {
    const r = good("011 15 5550-0101", { defaultCountry: "AR" });
    expect(r.e164).toBe("+5491155500101");
    expect(r.digits).toBe("5491155500101");
    expect(r.kind).toBe("mobile");
    expect(r.notes).toEqual(["argentina_removed_trunk_0", "argentina_removed_15"]);
  });

  it("handles a three-digit area code (Cordoba 351)", () => {
    expect(good("0351 15 555-0102", { defaultCountry: "AR" }).e164).toBe("+5493515550102");
  });

  it("keeps a number that already has the 9", () => {
    const r = good("+54 9 351 555-0102");
    expect(r.e164).toBe("+5493515550102");
    expect(r.notes).toEqual([]);
  });

  it("adds the 9 to +54 area number by default, because recipients are mobile phones", () => {
    const r = good("+54 11 5550 0103");
    expect(r.e164).toBe("+5491155500103");
    expect(r.notes).toEqual(["argentina_added_mobile_9"]);
  });

  it("keeps the number as written when asked not to assume mobile", () => {
    const r = good("+54 11 5550 0103", { argentinaAssumeMobile: false });
    expect(r.e164).toBe("+541155500103");
    expect(r.kind).toBe("unknown");
  });

  it("rejects a number that is too short", () => {
    expect(bad("11 5550", { defaultCountry: "AR" }).code).toBe("too_short");
  });

  it("rejects a number with too many digits", () => {
    expect(bad("+54 11 5550 0103 99").code).toBe("bad_length");
  });

  it("rejects an area code that does not start with 1, 2 or 3", () => {
    expect(bad("+54 9 811 555 0102").code).toBe("bad_area_code");
  });

  it("reports country AR and calling code 54", () => {
    const r = good("+54 9 11 5550 0101");
    expect(r.country).toBe("AR");
    expect(r.callingCode).toBe("54");
  });
});

describe("Spain", () => {
  it("accepts a mobile typed locally", () => {
    const r = good("612 34 56 78", { defaultCountry: "ES" });
    expect(r.e164).toBe("+34612345678");
    expect(r.kind).toBe("mobile");
  });

  it("accepts a 7xx mobile with the country code", () => {
    expect(good("+34 677 00 11 22").e164).toBe("+34677001122");
  });

  it("flags a landline", () => {
    const r = good("91 123 45 67", { defaultCountry: "ES" });
    expect(r.kind).toBe("fixed");
    expect(r.notes).toEqual(["spain_landline"]);
  });

  it("rejects a first digit that Spain does not use", () => {
    expect(bad("512 34 56 78", { defaultCountry: "ES" }).code).toBe("bad_leading_digit");
  });

  it("rejects short and long numbers", () => {
    expect(bad("+34 612 345").code).toBe("too_short");
    expect(bad("+34 612 345 6789").code).toBe("bad_length");
  });
});

describe("Mexico", () => {
  it("drops the historic 1 after +52", () => {
    const r = good("+52 1 55 5550 0104");
    expect(r.e164).toBe("+525555500104");
    expect(r.notes).toEqual(["mexico_removed_mobile_1"]);
  });

  it("can keep the 1 when asked", () => {
    expect(good("+52 1 55 5550 0104", { mexicoDropMobile1: false }).e164).toBe("+5215555500104");
  });

  it("drops the old 044 dialling prefix of national input", () => {
    const r = good("044 55 5550 0104", { defaultCountry: "MX" });
    expect(r.e164).toBe("+525555500104");
    expect(r.notes).toEqual(["mexico_removed_old_prefix"]);
  });

  it("drops the old 01 long-distance prefix of national input", () => {
    expect(good("01 55 5550 0104", { defaultCountry: "MX" }).e164).toBe("+525555500104");
  });

  it("rejects an area code starting with 0 or 1", () => {
    expect(bad("+52 1555 550 010").code).toBe("bad_area_code");
  });

  it("rejects a number that is too short", () => {
    expect(bad("+52 55 5550").code).toBe("too_short");
  });
});

describe("Brazil", () => {
  it("accepts a nine-digit mobile", () => {
    const r = good("+55 11 91234-5678");
    expect(r.e164).toBe("+5511912345678");
    expect(r.kind).toBe("mobile");
  });

  it("accepts a national number with the area code in parentheses", () => {
    expect(good("(11) 91234-5678", { defaultCountry: "BR" }).e164).toBe("+5511912345678");
  });

  it("accepts a landline", () => {
    expect(good("+55 11 3123-4567").kind).toBe("fixed");
  });

  it("notes an old eight-digit mobile", () => {
    const r = good("+55 11 8123-4567");
    expect(r.kind).toBe("mobile");
    expect(r.notes).toEqual(["brazil_eight_digit_mobile"]);
  });

  it("rejects area code 01", () => {
    expect(bad("+55 01 91234-5678").code).toBe("bad_area_code");
  });

  it("rejects a nine-digit subscriber that does not start with 9", () => {
    expect(bad("+55 11 71234-5678").code).toBe("bad_leading_digit");
  });
});

describe("United States and India", () => {
  it("accepts a US number with punctuation", () => {
    expect(good("+1 (631) 555-1234").e164).toBe("+16315551234");
  });

  it("strips the national 1 of a US number", () => {
    expect(good("1 631 555 1234", { defaultCountry: "US" }).e164).toBe("+16315551234");
  });

  it("rejects a US area code starting with 1", () => {
    expect(bad("+1 131 555 1234").code).toBe("bad_area_code");
  });

  it("accepts an Indian mobile", () => {
    const r = good("+91 98765 43210");
    expect(r.e164).toBe("+919876543210");
    expect(r.kind).toBe("mobile");
  });

  it("removes the trunk 0 of an Indian national number", () => {
    const r = good("098765 43210", { defaultCountry: "IN" });
    expect(r.e164).toBe("+919876543210");
    expect(r.notes).toEqual(["removed_trunk_zero"]);
  });

  it("rejects an Indian number starting below 6", () => {
    expect(bad("+91 12345 67890").code).toBe("bad_leading_digit");
  });
});

describe("other countries and shapes", () => {
  it("passes a number of a country without rules through as E.164", () => {
    const r = good("+44 20 7946 0958");
    expect(r.e164).toBe("+442079460958");
    expect(r.country).toBeNull();
    expect(r.kind).toBe("unknown");
  });

  it("limits generic numbers to 8..15 digits", () => {
    expect(bad("+99 123").code).toBe("too_short");
    expect(bad("+9912345678901234").code).toBe("too_long");
  });

  it("accepts 00 as the international prefix", () => {
    expect(good("0034 612 34 56 78").e164).toBe("+34612345678");
  });

  it("accepts dots and non-breaking spaces that people paste", () => {
    expect(good("+34.612.345.678").e164).toBe("+34612345678");
    expect(good("+34 612 345 678").e164).toBe("+34612345678");
  });

  it("rejects empty input", () => {
    expect(bad("").code).toBe("empty");
    expect(bad("   ").code).toBe("empty");
    expect(bad("+").code).toBe("empty");
  });

  it("rejects letters", () => {
    expect(bad("call me").code).toBe("invalid_characters");
  });

  it("rejects a plus sign in the middle", () => {
    expect(bad("6123+4567").code).toBe("misplaced_plus");
  });

  it("asks for a country when the number has none and there is no default", () => {
    expect(bad("612345678").code).toBe("no_country");
  });

  it("rejects an unknown default country", () => {
    expect(bad("612345678", { defaultCountry: "ZZ" as never }).code).toBe("unsupported_default_country");
  });

  it("rejects a country calling code that starts with 0", () => {
    expect(bad("+034612345678").code).toBe("bad_leading_digit");
  });

  it("keeps the original input in the error", () => {
    expect(bad("abc").input).toBe("abc");
  });
});

describe("error messages", () => {
  it("are plain Spanish and English", () => {
    const r = bad("");
    expect(r.message.es).toBe("El número de teléfono está vacío.");
    expect(r.message.en).toBe("The phone number is empty.");
  });

  it("exist in both languages for every code", () => {
    const codes: PhoneErrorCode[] = ["empty", "invalid_characters", "misplaced_plus", "no_country", "unsupported_default_country", "too_short", "too_long", "bad_length", "bad_leading_digit", "bad_area_code"];
    for (const code of codes) {
      const m = phoneErrorMessage(code);
      expect(m.es.length).toBeGreaterThan(10);
      expect(m.en.length).toBeGreaterThan(10);
      expect(m.es).not.toBe(m.en);
    }
  });

  it("mention the country code example when it is missing", () => {
    expect(bad("612345678").message.es).toContain("+54");
  });
});

describe("asCountryCode", () => {
  it("is case-insensitive and rejects unknown codes", () => {
    expect(asCountryCode("ar")).toBe("AR");
    expect(asCountryCode("Es")).toBe("ES");
    expect(asCountryCode("xx")).toBeUndefined();
    expect(asCountryCode(null)).toBeUndefined();
    expect(asCountryCode(undefined)).toBeUndefined();
  });
});

describe("matchKey", () => {
  it("treats Argentine numbers with and without the mobile 9 as the same person", () => {
    expect(matchKey("+54 9 11 5550 0101")).toBe("541155500101");
    expect(matchKey("+54 11 5550 0101")).toBe("541155500101");
    expect(matchKey("5491155500101")).toBe(matchKey("541155500101"));
  });

  it("treats Mexican numbers with and without the 1 as the same person", () => {
    expect(matchKey("+52 1 55 5550 0104")).toBe("525555500104");
    expect(matchKey("+52 55 5550 0104")).toBe("525555500104");
  });

  it("treats Brazilian numbers with and without the ninth digit as the same person", () => {
    expect(matchKey("+55 11 91234-5678")).toBe("551112345678");
    expect(matchKey("+55 11 1234-5678")).toBe("551112345678");
  });

  it("leaves other countries alone", () => {
    expect(matchKey("+34 612 345 678")).toBe("34612345678");
    expect(matchKey("+1 631 555 1234")).toBe("16315551234");
  });

  it("keeps different people apart", () => {
    expect(matchKey("+54 9 11 5550 0101")).not.toBe(matchKey("+54 9 11 5550 0102"));
    expect(matchKey("+54 9 11 5550 0101")).not.toBe(matchKey("+34 611 555 001"));
  });

  it("does not touch an Argentine landline-looking number that is not 11 digits after 54", () => {
    expect(matchKey("541155500101")).toBe("541155500101");
  });
});

describe("isBsuid", () => {
  it("recognises the documented shape", () => {
    expect(isBsuid("US.13491208655302741918")).toBe(true);
    expect(isBsuid("US.ENT.abc123")).toBe(true);
  });

  it("rejects phone numbers and lower-case country codes", () => {
    expect(isBsuid("+5491155500101")).toBe(false);
    expect(isBsuid("us.123")).toBe(false);
    expect(isBsuid("")).toBe(false);
  });
});
