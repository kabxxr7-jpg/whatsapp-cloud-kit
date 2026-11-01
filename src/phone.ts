// Phone number normalisation to E.164 with a few country rules, plus a comparison key.
//
// What Meta's docs say (docs/SOURCES.md): the `to` field accepts "+", hyphens, parentheses and spaces; always send the
// "+" and the country calling code; "For Brazil and Mexico, the extra added prefix of the phone number may be modified
// by the Cloud API". They say nothing about Argentina. So this module:
//   * produces a canonical E.164 string per the public numbering plans (Argentine mobiles keep the "9": +54 9 AREA NUMBER);
//   * never claims to know which form Meta will show in a webhook, and offers matchKey() to compare numbers in
//     either form (Argentine mobile "9", Mexican "1", Brazilian ninth digit).

export type CountryCode = "AR" | "ES" | "MX" | "BR" | "US" | "IN";

export type PhoneErrorCode =
  | "empty"
  | "invalid_characters"
  | "misplaced_plus"
  | "no_country"
  | "unsupported_default_country"
  | "too_short"
  | "too_long"
  | "bad_length"
  | "bad_leading_digit"
  | "bad_area_code";

export type PhoneNote =
  | "argentina_added_mobile_9"
  | "argentina_removed_15"
  | "argentina_removed_trunk_0"
  | "mexico_removed_mobile_1"
  | "mexico_removed_old_prefix"
  | "brazil_eight_digit_mobile"
  | "spain_landline"
  | "removed_trunk_zero";

export interface Bilingual {
  es: string;
  en: string;
}

export interface PhoneOk {
  ok: true;
  /** "+5491112345678" */
  e164: string;
  /** "5491112345678" (what the Graph API calls the number without "+") */
  digits: string;
  country: CountryCode | null;
  /** Country calling code, "54" */
  callingCode: string;
  kind: "mobile" | "fixed" | "unknown";
  notes: PhoneNote[];
}

export interface PhoneError {
  ok: false;
  code: PhoneErrorCode;
  input: string;
  message: Bilingual;
}

export type PhoneResult = PhoneOk | PhoneError;

export interface PhoneOptions {
  /** Used for numbers written without "+" or "00". */
  defaultCountry?: CountryCode | undefined;
  /**
   * Argentina: a number written as +54 AREA NUMBER (10 digits, no 9) cannot be told apart from a landline. WhatsApp
   * recipients are mobile phones, so by default the 9 is added. Set false to keep the number as written.
   */
  argentinaAssumeMobile?: boolean | undefined;
  /** Mexico: drop the historic "1" after +52 (default true). */
  mexicoDropMobile1?: boolean | undefined;
}

const COUNTRY_CODES: Array<[string, CountryCode]> = [
  ["54", "AR"],
  ["34", "ES"],
  ["52", "MX"],
  ["55", "BR"],
  ["91", "IN"],
  ["1", "US"],
];

const CALLING_CODE_OF: Record<CountryCode, string> = { AR: "54", ES: "34", MX: "52", BR: "55", US: "1", IN: "91" };

const MESSAGES: Record<PhoneErrorCode, Bilingual> = {
  empty: { es: "El número de teléfono está vacío.", en: "The phone number is empty." },
  invalid_characters: {
    es: "El número de teléfono solo puede tener dígitos, espacios, guiones, puntos y paréntesis, y un + al principio.",
    en: "The phone number may only contain digits, spaces, hyphens, dots and parentheses, and a + at the start.",
  },
  misplaced_plus: {
    es: "El signo + solo puede ir al principio del número.",
    en: "The + sign can only be at the start of the number.",
  },
  no_country: {
    es: "Falta el código de país (por ejemplo +54 para Argentina o +34 para España).",
    en: "The country code is missing (for example +54 for Argentina or +34 for Spain).",
  },
  unsupported_default_country: {
    es: "El país por defecto no es válido.",
    en: "The default country is not valid.",
  },
  too_short: { es: "El número de teléfono es demasiado corto.", en: "The phone number is too short." },
  too_long: { es: "El número de teléfono es demasiado largo.", en: "The phone number is too long." },
  bad_length: {
    es: "El número no tiene la cantidad de dígitos que corresponde a ese país.",
    en: "The number does not have the number of digits that country uses.",
  },
  bad_leading_digit: {
    es: "El número no empieza con un dígito válido para ese país.",
    en: "The number does not start with a digit that is valid for that country.",
  },
  bad_area_code: {
    es: "El código de área no es válido para ese país.",
    en: "The area code is not valid for that country.",
  },
};

function fail(code: PhoneErrorCode, input: string): PhoneError {
  return { ok: false, code, input, message: MESSAGES[code] };
}

function ok(
  callingCode: string,
  national: string,
  country: CountryCode | null,
  kind: PhoneOk["kind"],
  notes: PhoneNote[],
): PhoneOk {
  const digits = callingCode + national;
  return { ok: true, e164: "+" + digits, digits, country, callingCode, kind, notes };
}

/** "ar" / "AR" -> "AR"; anything we have no rules for -> undefined. */
export function asCountryCode(value: string | null | undefined): CountryCode | undefined {
  const up = (value ?? "").toUpperCase();
  return up in CALLING_CODE_OF ? (up as CountryCode) : undefined;
}

/** Bilingual text for a phone error code, e.g. to render in a form. */
export function phoneErrorMessage(code: PhoneErrorCode): Bilingual {
  return MESSAGES[code];
}

export function normalizePhone(input: string, options: PhoneOptions = {}): PhoneResult {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  if (trimmed === "") return fail("empty", raw);

  // Separators Meta accepts (+ - ( ) space) plus dots and non-breaking spaces, which people paste.
  const compact = trimmed.replace(/[\s\u00a0.\-()]/g, "");
  if (compact === "" || compact === "+") return fail("empty", raw);
  if (!/^\+?[0-9]+$/.test(compact)) {
    return fail(/^[+0-9]+$/.test(compact) ? "misplaced_plus" : "invalid_characters", raw);
  }

  let international = false;
  let digits = compact;
  if (digits.startsWith("+")) {
    international = true;
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits === "") return fail("empty", raw);

  if (international) {
    if (digits.startsWith("0")) return fail("bad_leading_digit", raw);
    const match = COUNTRY_CODES.find(([code]) => digits.startsWith(code));
    if (!match) return genericInternational(digits, raw);
    const [callingCode, country] = match;
    return applyCountry(country, callingCode, digits.slice(callingCode.length), raw, options);
  }

  const country = options.defaultCountry;
  if (country === undefined) return fail("no_country", raw);
  if (!(country in CALLING_CODE_OF)) return fail("unsupported_default_country", raw);
  return applyCountry(country, CALLING_CODE_OF[country], digits, raw, options, true);
}

function genericInternational(digits: string, raw: string): PhoneResult {
  if (digits.length < 8) return fail("too_short", raw);
  if (digits.length > 15) return fail("too_long", raw);
  // Without a country rule we cannot split the calling code from the number; keep the digits as given.
  return { ok: true, e164: "+" + digits, digits, country: null, callingCode: "", kind: "unknown", notes: [] };
}

function applyCountry(
  country: CountryCode,
  callingCode: string,
  rest: string,
  raw: string,
  options: PhoneOptions,
  nationalInput = false,
): PhoneResult {
  switch (country) {
    case "AR":
      return argentina(callingCode, rest, raw, options);
    case "ES":
      return spain(callingCode, rest, raw);
    case "MX":
      return mexico(callingCode, rest, raw, options, nationalInput);
    case "BR":
      return brazil(callingCode, rest, raw, nationalInput);
    case "US":
      return nanp(callingCode, rest, raw);
    case "IN":
      return india(callingCode, rest, raw, nationalInput);
  }
}

// ---- Argentina ---------------------------------------------------------------------------------------------------
// Mobile numbers in international form: +54 9 AREA SUBSCRIBER with AREA + SUBSCRIBER = 10 digits (Buenos Aires: 11 + 8).
// Written locally as 0 AREA 15 SUBSCRIBER; the "0" and the "15" are dropped in international form.
function argentina(cc: string, restIn: string, raw: string, options: PhoneOptions): PhoneResult {
  const notes: PhoneNote[] = [];
  let rest = restIn;
  let mobile = false;

  if (rest.startsWith("0")) {
    rest = rest.slice(1);
    notes.push("argentina_removed_trunk_0");
  }
  if (rest.startsWith("9") && rest.length === 11) {
    mobile = true;
    rest = rest.slice(1);
  }
  // The local mobile prefix "15" sits after the area code (2 to 4 digits): 11 15 1234 5678 -> 11 1234 5678
  if (!mobile && rest.length === 12) {
    for (const areaLength of [2, 3, 4]) {
      if (rest.slice(areaLength, areaLength + 2) === "15") {
        rest = rest.slice(0, areaLength) + rest.slice(areaLength + 2);
        mobile = true;
        notes.push("argentina_removed_15");
        break;
      }
    }
  }
  if (rest.length < 10) return fail("too_short", raw);
  if (rest.length > 10) return fail("bad_length", raw);
  if (!/^[1-3]/.test(rest)) return fail("bad_area_code", raw);

  const assumeMobile = options.argentinaAssumeMobile !== false;
  if (!mobile && assumeMobile) {
    mobile = true;
    notes.push("argentina_added_mobile_9");
  }
  return ok(cc, (mobile ? "9" : "") + rest, "AR", mobile ? "mobile" : "unknown", notes);
}

// ---- Spain -------------------------------------------------------------------------------------------------------
function spain(cc: string, rest: string, raw: string): PhoneResult {
  if (rest.length < 9) return fail("too_short", raw);
  if (rest.length > 9) return fail("bad_length", raw);
  if (!/^[6-9]/.test(rest)) return fail("bad_leading_digit", raw);
  if (/^[67]/.test(rest)) return ok(cc, rest, "ES", "mobile", []);
  return ok(cc, rest, "ES", "fixed", ["spain_landline"]);
}

// ---- Mexico ------------------------------------------------------------------------------------------------------
function mexico(cc: string, restIn: string, raw: string, options: PhoneOptions, nationalInput: boolean): PhoneResult {
  const notes: PhoneNote[] = [];
  let rest = restIn;
  if (nationalInput) {
    // Old dialling prefixes: 01 (long distance), 044 / 045 (mobile).
    const old = /^(044|045|01)/.exec(rest);
    if (old && rest.length - old[1]!.length === 10) {
      rest = rest.slice(old[1]!.length);
      notes.push("mexico_removed_old_prefix");
    }
  }
  if (rest.length === 11 && rest.startsWith("1") && options.mexicoDropMobile1 !== false) {
    rest = rest.slice(1);
    notes.push("mexico_removed_mobile_1");
  } else if (rest.length === 11 && rest.startsWith("1")) {
    return ok(cc, rest, "MX", "mobile", notes);
  }
  if (rest.length < 10) return fail("too_short", raw);
  if (rest.length > 10) return fail("bad_length", raw);
  if (/^[01]/.test(rest)) return fail("bad_area_code", raw);
  return ok(cc, rest, "MX", "unknown", notes);
}

// ---- Brazil ------------------------------------------------------------------------------------------------------
function brazil(cc: string, restIn: string, raw: string, nationalInput: boolean): PhoneResult {
  let rest = restIn;
  const notes: PhoneNote[] = [];
  if (nationalInput && rest.startsWith("0")) {
    rest = rest.slice(1);
    notes.push("removed_trunk_zero");
  }
  if (rest.length < 10) return fail("too_short", raw);
  if (rest.length > 11) return fail("bad_length", raw);
  const area = rest.slice(0, 2);
  if (!/^[1-9][1-9]$/.test(area)) return fail("bad_area_code", raw);
  const subscriber = rest.slice(2);
  if (subscriber.length === 9) {
    if (subscriber[0] !== "9") return fail("bad_leading_digit", raw);
    return ok(cc, rest, "BR", "mobile", notes);
  }
  // 8 digits: a landline (2-5) or an old mobile number without the ninth digit (6-9)
  if (/^[6-9]/.test(subscriber)) notes.push("brazil_eight_digit_mobile");
  return ok(cc, rest, "BR", /^[6-9]/.test(subscriber) ? "mobile" : "fixed", notes);
}

// ---- United States / Canada (NANP) -------------------------------------------------------------------------------
function nanp(cc: string, restIn: string, raw: string): PhoneResult {
  let rest = restIn;
  // a national "1 (631) 555-1234" arrives here as 11 digits starting with 1
  if (rest.length === 11 && rest.startsWith("1")) rest = rest.slice(1);
  if (rest.length < 10) return fail("too_short", raw);
  if (rest.length > 10) return fail("bad_length", raw);
  if (!/^[2-9]/.test(rest)) return fail("bad_area_code", raw);
  if (!/^[2-9]/.test(rest.slice(3))) return fail("bad_leading_digit", raw);
  return ok(cc, rest, "US", "unknown", []);
}

// ---- India -------------------------------------------------------------------------------------------------------
function india(cc: string, restIn: string, raw: string, nationalInput: boolean): PhoneResult {
  let rest = restIn;
  const notes: PhoneNote[] = [];
  if (nationalInput && rest.startsWith("0")) {
    rest = rest.slice(1);
    notes.push("removed_trunk_zero");
  }
  if (rest.length < 10) return fail("too_short", raw);
  if (rest.length > 10) return fail("bad_length", raw);
  if (!/^[6-9]/.test(rest)) return fail("bad_leading_digit", raw);
  return ok(cc, rest, "IN", "mobile", notes);
}

/**
 * A key under which "the same person" compares equal whichever way their number is written, for the countries where
 * the mobile form has an extra digit that WhatsApp may add or drop:
 *   Argentina  54 9 AREA NUM  ->  54 AREA NUM
 *   Mexico     52 1 NUM       ->  52 NUM
 *   Brazil     55 DD 9 NUM    ->  55 DD NUM     (nine-digit mobiles lose the ninth digit)
 * Everything else is the plain digits. This is a comparison key, never a number to dial.
 */
export function matchKey(input: string): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.startsWith("54")) {
    const rest = digits.slice(2);
    if (rest.length === 11 && rest.startsWith("9")) return "54" + rest.slice(1);
    return digits;
  }
  if (digits.startsWith("52")) {
    const rest = digits.slice(2);
    if (rest.length === 11 && rest.startsWith("1")) return "52" + rest.slice(1);
    return digits;
  }
  if (digits.startsWith("55")) {
    const rest = digits.slice(2);
    if (rest.length === 11 && rest[2] === "9") return "55" + rest.slice(0, 2) + rest.slice(3);
    return digits;
  }
  return digits;
}

/** Business-scoped user ids look like "US.13491208655302741918" (docs: ISO country code, a period, up to 128 alphanumerics). */
export function isBsuid(value: string): boolean {
  return /^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$/.test(value);
}
