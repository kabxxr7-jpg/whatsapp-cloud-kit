// Template definitions for "your document is attached" messages, and the payload to create them.
//
// These are EXAMPLES of what a client would submit for approval in their own Messaging account. Nothing here is
// approved by Meta: approval, category (Meta may re-categorise a template as marketing) and wording are decided at
// review time (docs: "Template review", "Template categorization").
//
// Constraints taken from the docs: names are lowercase letters, digits and underscores; the body is required, max
// 1024 characters; a DOCUMENT header needs an example uploaded through the Resumable Upload API (shown below as an
// obviously fake handle); utility templates must be non-promotional and about the user's own order/account/transaction.

import type { DocType, Tenant, TemplateChoice } from "./db.ts";

export interface TemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY";
  /** {{1}} customer name, {{2}} document number, {{3}} business name */
  bodyText: string;
  bodyExamples: [string, string, string];
  footerText: string;
  headerFormat: "DOCUMENT";
}

export const DOC_LABEL: Record<"es" | "en", Record<DocType, string>> = {
  es: { budget: "presupuesto", invoice: "factura", purchase_order: "orden de compra" },
  en: { budget: "quote", invoice: "invoice", purchase_order: "purchase order" },
};

export const DEFAULT_TEMPLATES: Record<"es" | "en", Record<DocType, TemplateDefinition>> = {
  es: {
    budget: {
      name: "presupuesto_adjunto",
      language: "es",
      category: "UTILITY",
      bodyText: "Hola {{1}}, le enviamos el presupuesto N.º {{2}} de {{3}}. Encontrará el detalle en el PDF de arriba.",
      bodyExamples: ["María", "P-2026-0042", "Taller Ejemplo"],
      footerText: "Responda BAJA para no recibir más mensajes.",
      headerFormat: "DOCUMENT",
    },
    invoice: {
      name: "factura_adjunta",
      language: "es",
      category: "UTILITY",
      bodyText: "Hola {{1}}, le enviamos la factura N.º {{2}} de {{3}}. Encontrará el detalle en el PDF de arriba.",
      bodyExamples: ["María", "A-0001-00001234", "Taller Ejemplo"],
      footerText: "Responda BAJA para no recibir más mensajes.",
      headerFormat: "DOCUMENT",
    },
    purchase_order: {
      name: "orden_de_compra_adjunta",
      language: "es",
      category: "UTILITY",
      bodyText: "Hola {{1}}, le enviamos la orden de compra N.º {{2}} de {{3}}. Encontrará el detalle en el PDF de arriba.",
      bodyExamples: ["Carlos", "OC-2026-0108", "Taller Ejemplo"],
      footerText: "Responda BAJA para no recibir más mensajes.",
      headerFormat: "DOCUMENT",
    },
  },
  en: {
    budget: {
      name: "quote_attached",
      language: "en",
      category: "UTILITY",
      bodyText: "Hello {{1}}, here is quote no. {{2}} from {{3}}. You will find the details in the PDF above.",
      bodyExamples: ["Maria", "P-2026-0042", "Example Workshop"],
      footerText: "Reply STOP to stop receiving messages.",
      headerFormat: "DOCUMENT",
    },
    invoice: {
      name: "invoice_attached",
      language: "en",
      category: "UTILITY",
      bodyText: "Hello {{1}}, here is invoice no. {{2}} from {{3}}. You will find the details in the PDF above.",
      bodyExamples: ["Maria", "A-0001-00001234", "Example Workshop"],
      footerText: "Reply STOP to stop receiving messages.",
      headerFormat: "DOCUMENT",
    },
    purchase_order: {
      name: "purchase_order_attached",
      language: "en",
      category: "UTILITY",
      bodyText: "Hello {{1}}, here is purchase order no. {{2}} from {{3}}. You will find the details in the PDF above.",
      bodyExamples: ["Carlos", "OC-2026-0108", "Example Workshop"],
      footerText: "Reply STOP to stop receiving messages.",
      headerFormat: "DOCUMENT",
    },
  },
};

/** The template to use for a tenant and document type: the tenant's own choice, else the kit's example. */
export function templateFor(tenant: Pick<Tenant, "locale" | "templates">, docType: DocType): TemplateChoice {
  const own = tenant.templates[docType];
  if (own) return own;
  const def = DEFAULT_TEMPLATES[tenant.locale][docType];
  return { name: def.name, language: def.language };
}

export function bodyVariableCount(text: string): number {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) found.add(m[1]!);
  return found.size;
}

/** JSON for POST /<WABA_ID>/message_templates (docs: "Template components", `HEADER` with `format` DOCUMENT). */
export function templateCreationPayload(def: TemplateDefinition): Record<string, unknown> {
  return {
    name: def.name,
    language: def.language,
    category: def.category,
    components: [
      { type: "HEADER", format: def.headerFormat, example: { header_handle: ["4::REPLACE_WITH_RESUMABLE_UPLOAD_HANDLE"] } },
      { type: "BODY", text: def.bodyText, example: { body_text: [def.bodyExamples] } },
      { type: "FOOTER", text: def.footerText },
    ],
  };
}

export interface FreeformCopy {
  caption: (docType: DocType, number: string, business: string) => string;
  optOutConfirmation: string;
  optInConfirmation: string;
}

export const FREEFORM: Record<"es" | "en", FreeformCopy> = {
  es: {
    caption: (t, n, b) => `${capitalise(DOC_LABEL.es[t])} N.º ${n} de ${b}`,
    optOutConfirmation: "Listo: no le enviaremos más mensajes por WhatsApp. Si cambia de opinión, responda ALTA.",
    optInConfirmation: "Gracias: volverá a recibir nuestros documentos por WhatsApp. Responda BAJA para dejar de recibirlos.",
  },
  en: {
    caption: (t, n, b) => `${capitalise(DOC_LABEL.en[t])} no. ${n} from ${b}`,
    optOutConfirmation: "Done: we will not send you more WhatsApp messages. If you change your mind, reply START.",
    optInConfirmation: "Thanks: you will receive our documents on WhatsApp again. Reply STOP to stop receiving them.",
  },
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
