// Plain-language mapping for the WhatsApp Cloud API error codes the kit knows about.
//
// Source: "support/error-codes" (see docs/SOURCES.md, read 2026-11-01). Meta's advice is to build error handling on
// `code` and `details`, not on titles, so the table is keyed by code. The Spanish and English texts are this kit's own
// wording of what the docs say the code means; they are not Meta strings.
//
// `retryable` means "the docs say to try again later / the failure is about load or availability, so the same request
// can be repeated unchanged". Everything else needs a person (or a different request) to fix it first.

export type ErrorAction =
  | "retry_later"
  | "wait_24h"
  | "send_template"
  | "fix_template"
  | "fix_parameters"
  | "check_recipient"
  | "fix_account"
  | "fix_token"
  | "do_not_retry"
  | "contact_support";

export interface ErrorInfo {
  code: number;
  /** Short stable key, safe to store and to switch on in a UI. */
  key: string;
  retryable: boolean;
  action: ErrorAction;
  es: string;
  en: string;
}

function e(code: number, key: string, retryable: boolean, action: ErrorAction, es: string, en: string): ErrorInfo {
  return { code, key, retryable, action, es, en };
}

const TABLE: ErrorInfo[] = [
  // recipient / delivery
  e(131026, "undeliverable", false, "check_recipient",
    "No se pudo entregar el mensaje: el número no tiene WhatsApp, la persona no aceptó los términos nuevos o usa una versión muy antigua de la aplicación. Conviene contactarla por otro medio.",
    "The message could not be delivered: the number is not on WhatsApp, the person has not accepted the new terms, or they use a very old version of the app. Contact them another way."),
  e(131047, "reengagement_window", false, "send_template",
    "Pasaron más de 24 horas desde el último mensaje de la persona: solo se puede enviar una plantilla aprobada.",
    "More than 24 hours have passed since the person last wrote: only an approved template can be sent."),
  e(131021, "same_sender_recipient", false, "check_recipient",
    "El número de destino es el mismo que el número de la empresa.",
    "The recipient number is the same as the business number."),
  e(130403, "blocked_by_business", false, "do_not_retry",
    "La empresa bloqueó a esta persona en WhatsApp; no se puede enviar hasta desbloquearla.",
    "The business has blocked this person on WhatsApp; nothing can be sent until they are unblocked."),
  e(131050, "stopped_marketing", false, "do_not_retry",
    "La persona pidió no recibir más mensajes de marketing de esta empresa.",
    "The person asked to stop receiving marketing messages from this business."),
  e(131049, "ecosystem_limit", false, "wait_24h",
    "WhatsApp no entregó el mensaje para mantener una buena experiencia de los usuarios. Esperar al menos 24 horas antes de reenviar.",
    "WhatsApp did not deliver the message to keep the user experience healthy. Wait at least 24 hours before sending again."),
  // templates
  e(132000, "template_param_count", false, "fix_parameters",
    "La cantidad de variables enviadas no coincide con la cantidad de variables de la plantilla.",
    "The number of variable values sent does not match the number of variables in the template."),
  e(132001, "template_missing", false, "fix_template",
    "La plantilla no existe en ese idioma o todavía no fue aprobada por Meta.",
    "The template does not exist in that language or has not been approved by Meta yet."),
  e(132005, "template_translation_too_long", false, "fix_template",
    "El texto traducido de la plantilla es demasiado largo.",
    "The translated template text is too long."),
  e(132007, "template_policy", false, "fix_template",
    "El contenido de la plantilla infringe una política de WhatsApp.",
    "The template content violates a WhatsApp policy."),
  e(132012, "template_param_format", false, "fix_parameters",
    "Los valores de las variables no tienen el formato que pide la plantilla.",
    "The variable values are not in the format the template asks for."),
  e(132015, "template_paused", false, "fix_template",
    "La plantilla está en pausa por baja calidad y no se puede usar hasta mejorarla y que se apruebe de nuevo.",
    "The template is paused for low quality and cannot be used until it is improved and approved again."),
  e(132016, "template_disabled", false, "fix_template",
    "La plantilla fue desactivada de forma permanente; hay que crear una nueva con otro contenido.",
    "The template has been permanently disabled; create a new one with different content."),
  // rate limits and load
  e(130429, "throughput", true, "retry_later",
    "Se alcanzó el límite de mensajes por segundo del número; se vuelve a intentar en unos segundos.",
    "The number's messages-per-second limit was reached; trying again in a few seconds."),
  e(131056, "pair_rate_limit", true, "retry_later",
    "Se enviaron demasiados mensajes seguidos a la misma persona; hay que esperar un poco.",
    "Too many messages were sent to the same person in a short time; wait a little."),
  e(4, "app_rate_limit", true, "retry_later",
    "La aplicación alcanzó su límite de llamadas a la API; se vuelve a intentar más tarde.",
    "The app reached its API call limit; trying again later."),
  e(80007, "account_rate_limit", true, "retry_later",
    "La cuenta de WhatsApp Business alcanzó su límite de uso; se vuelve a intentar más tarde.",
    "The WhatsApp Business account reached its rate limit; trying again later."),
  e(131048, "spam_rate_limit", false, "fix_account",
    "El número tiene restricciones de envío porque demasiados mensajes anteriores fueron bloqueados o marcados como spam. Revisar la calidad del número en WhatsApp Manager.",
    "Sending from this number is restricted because too many earlier messages were blocked or flagged as spam. Check the number's quality in WhatsApp Manager."),
  e(131064, "template_classification_limit", false, "fix_template",
    "La cuenta llegó a su límite de mensajes por infracciones en la categoría de las plantillas.",
    "The account reached its messaging limit because of template category violations."),
  // availability
  e(2, "service_unavailable", true, "retry_later",
    "Servicio temporalmente no disponible; se vuelve a intentar.", "Service temporarily unavailable; trying again."),
  e(131016, "service_unavailable_2", true, "retry_later",
    "Un servicio de WhatsApp no está disponible por el momento; se vuelve a intentar.",
    "A WhatsApp service is temporarily unavailable; trying again."),
  e(133004, "server_unavailable", true, "retry_later",
    "El servidor de WhatsApp no está disponible por el momento; se vuelve a intentar.",
    "The WhatsApp server is temporarily unavailable; trying again."),
  e(131057, "maintenance", true, "retry_later",
    "La cuenta de WhatsApp Business está en mantenimiento; se vuelve a intentar.",
    "The WhatsApp Business account is in maintenance mode; trying again."),
  e(131000, "unknown_send_error", true, "retry_later",
    "El envío falló por un error desconocido de WhatsApp; se vuelve a intentar.",
    "The send failed with an unknown WhatsApp error; trying again."),
  e(1, "invalid_or_server", false, "contact_support",
    "Solicitud inválida o error del servidor de WhatsApp. Revisar el estado de la plataforma y la solicitud.",
    "Invalid request or a WhatsApp server error. Check the platform status and the request."),
  // request shape
  e(100, "invalid_parameter", false, "fix_parameters",
    "La solicitud tiene un parámetro no admitido o mal escrito.", "The request has an unsupported or misspelled parameter."),
  e(131008, "missing_parameter", false, "fix_parameters",
    "A la solicitud le falta un parámetro obligatorio.", "The request is missing a required parameter."),
  e(131009, "invalid_parameter_value", false, "fix_parameters",
    "Uno o más valores de la solicitud no son válidos (por ejemplo, el número de teléfono).",
    "One or more values in the request are not valid (for example, the phone number)."),
  e(131051, "unsupported_message_type", false, "fix_parameters",
    "Tipo de mensaje no admitido.", "Unsupported message type."),
  e(131053, "media_upload", false, "fix_parameters",
    "No se pudo subir el archivo: el tipo no es admitido o no coincide con su extensión.",
    "The file could not be uploaded: the type is not supported or does not match its extension."),
  // account / token
  e(0, "auth_failed", false, "fix_token",
    "No se pudo autenticar con WhatsApp: el token venció, fue revocado o es inválido.",
    "Authentication with WhatsApp failed: the token expired, was revoked or is invalid."),
  e(190, "token_expired", false, "fix_token",
    "El token de acceso venció; hay que generar uno nuevo.", "The access token expired; generate a new one."),
  e(200, "no_token", false, "fix_token",
    "Falta el token de acceso o no tiene acceso a este recurso.", "The access token is missing or has no access to this resource."),
  e(3, "capability", false, "fix_token",
    "Al token le faltan capacidades o permisos para esta operación.", "The token lacks the capability or permission for this operation."),
  e(10, "permission", false, "fix_token",
    "El permiso no fue otorgado o fue retirado.", "The permission was not granted or has been removed."),
  e(131005, "permission_removed", false, "fix_token",
    "El permiso no fue otorgado o fue retirado.", "The permission was not granted or has been removed."),
  e(368, "account_restricted", false, "fix_account",
    "La cuenta de WhatsApp Business fue restringida o desactivada por infringir una política.",
    "The WhatsApp Business account was restricted or disabled for violating a policy."),
  e(131031, "account_locked", false, "fix_account",
    "La cuenta fue restringida o bloqueada, o los datos enviados no coinciden con los de la cuenta.",
    "The account was restricted or locked, or the data sent does not match the account."),
  e(130497, "country_restricted", false, "fix_account",
    "La cuenta tiene prohibido enviar mensajes a personas de ese país.",
    "The account is not allowed to message people in that country."),
  e(131042, "payment_method", false, "fix_account",
    "Hay un problema con el medio de pago de la cuenta de WhatsApp Business (facturación sin configurar o con límite superado).",
    "There is a payment method problem on the WhatsApp Business account (billing not set up or credit line exceeded)."),
  e(131045, "number_not_registered_send", false, "fix_account",
    "El número de la empresa no está registrado para usar la API.", "The business number is not registered for the API."),
  e(133010, "number_not_registered", false, "fix_account",
    "El número no está registrado en la plataforma de WhatsApp Business.", "The phone number is not registered on the WhatsApp Business Platform."),
  e(33, "number_deleted", false, "fix_account",
    "El número de teléfono de la empresa fue eliminado.", "The business phone number has been deleted."),
  e(131062, "bsuid_unsupported", false, "fix_parameters",
    "Este tipo de mensaje no admite destinatarios identificados con un ID de usuario de empresa (BSUID).",
    "This message type does not support recipients identified by a business-scoped user ID (BSUID)."),
];

const BY_CODE = new Map<number, ErrorInfo>(TABLE.map((i) => [i.code, i]));

export const KNOWN_ERROR_CODES: readonly number[] = TABLE.map((i) => i.code);

/** Look a code up; unknown codes get a generic, non-retryable entry that still carries the number. */
export function mapWhatsAppError(code: number | undefined | null): ErrorInfo {
  if (typeof code === "number" && BY_CODE.has(code)) return BY_CODE.get(code)!;
  const shown = typeof code === "number" ? String(code) : "sin código";
  const shownEn = typeof code === "number" ? String(code) : "no code";
  return {
    code: typeof code === "number" ? code : -1,
    key: "unknown",
    retryable: false,
    action: "contact_support",
    es: `WhatsApp devolvió un error que este sistema no conoce (código ${shown}). Revisar el detalle técnico.`,
    en: `WhatsApp returned an error this system does not know (code ${shownEn}). Check the technical detail.`,
  };
}

/** One-line text for a UI or a log. */
export function describeError(code: number | undefined | null, lang: "es" | "en" = "es"): string {
  const info = mapWhatsAppError(code);
  return lang === "es" ? info.es : info.en;
}

/** Error object as Meta sends it, in a Graph API error body or in `statuses[].errors[]`. */
export interface WhatsAppApiError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string; messaging_product?: string };
  type?: string;
  fbtrace_id?: string;
}

export function errorDetails(err: WhatsAppApiError | undefined): string {
  if (!err) return "";
  return err.error_data?.details ?? err.message ?? err.title ?? "";
}
