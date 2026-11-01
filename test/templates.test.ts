import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, DOC_LABEL, FREEFORM, bodyVariableCount, templateCreationPayload, templateFor } from "../src/templates.ts";
import type { DocType } from "../src/db.ts";

const TYPES: DocType[] = ["budget", "invoice", "purchase_order"];

describe("default templates", () => {
  it("have valid names, three body variables and matching examples", () => {
    for (const lang of ["es", "en"] as const) {
      for (const t of TYPES) {
        const def = DEFAULT_TEMPLATES[lang][t];
        expect(def.name).toMatch(/^[a-z0-9_]+$/);
        expect(def.language).toBe(lang);
        expect(def.category).toBe("UTILITY");
        expect(def.bodyText.length).toBeLessThanOrEqual(1024);
        expect(bodyVariableCount(def.bodyText)).toBe(3);
        expect(def.bodyExamples).toHaveLength(3);
        expect(def.headerFormat).toBe("DOCUMENT");
      }
    }
  });

  it("carry the opt-out instruction in the footer", () => {
    expect(DEFAULT_TEMPLATES.es.budget.footerText).toContain("BAJA");
    expect(DEFAULT_TEMPLATES.en.budget.footerText).toContain("STOP");
  });

  it("use distinct names", () => {
    const names = (["es", "en"] as const).flatMap((l) => TYPES.map((t) => DEFAULT_TEMPLATES[l][t].name));
    expect(new Set(names).size).toBe(6);
  });
});

describe("templateFor", () => {
  it("falls back to the kit's example for the tenant's language", () => {
    expect(templateFor({ locale: "es", templates: {} }, "invoice")).toEqual({ name: "factura_adjunta", language: "es" });
    expect(templateFor({ locale: "en", templates: {} }, "budget")).toEqual({ name: "quote_attached", language: "en" });
  });

  it("uses the tenant's own approved template when set", () => {
    const own = { name: "mi_factura", language: "es_AR" };
    expect(templateFor({ locale: "es", templates: { invoice: own } }, "invoice")).toEqual(own);
    expect(templateFor({ locale: "es", templates: { invoice: own } }, "budget").name).toBe("presupuesto_adjunto");
  });
});

describe("bodyVariableCount", () => {
  it("counts distinct numbered variables", () => {
    expect(bodyVariableCount("Hola {{1}}, {{2}} y {{1}}")).toBe(2);
    expect(bodyVariableCount("sin variables")).toBe(0);
  });
});

describe("templateCreationPayload", () => {
  it("has a document header with an example, a body with examples and a footer", () => {
    const p = templateCreationPayload(DEFAULT_TEMPLATES.es.budget) as { name: string; language: string; category: string; components: Array<Record<string, unknown>> };
    expect(p.name).toBe("presupuesto_adjunto");
    expect(p.language).toBe("es");
    expect(p.category).toBe("UTILITY");
    expect(p.components.map((c) => c["type"])).toEqual(["HEADER", "BODY", "FOOTER"]);
    expect(p.components[0]).toMatchObject({ format: "DOCUMENT" });
    expect(p.components[1]!["example"]).toEqual({ body_text: [["María", "P-2026-0042", "Taller Ejemplo"]] });
  });
});

describe("free-form copy", () => {
  it("captions the document in Spanish and English", () => {
    expect(FREEFORM.es.caption("budget", "P-1", "Taller")).toBe("Presupuesto N.º P-1 de Taller");
    expect(FREEFORM.en.caption("purchase_order", "OC-9", "Shop")).toBe("Purchase order no. OC-9 from Shop");
  });

  it("confirms STOP and START with the way back", () => {
    expect(FREEFORM.es.optOutConfirmation).toContain("ALTA");
    expect(FREEFORM.en.optOutConfirmation).toContain("START");
    expect(FREEFORM.es.optInConfirmation).toContain("BAJA");
    expect(FREEFORM.en.optInConfirmation).toContain("STOP");
  });

  it("labels every document type in both languages", () => {
    for (const lang of ["es", "en"] as const) for (const t of TYPES) expect(DOC_LABEL[lang][t].length).toBeGreaterThan(3);
  });
});
