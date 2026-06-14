import * as functions from "firebase-functions";
import { Request } from "firebase-functions";
import { validateTwilioSignature } from "./twilio";

/**
 * Inbound SMS security layer.
 *
 * Threats handled:
 *  1. Webhook forgery — anyone can POST to the public function URL and
 *     impersonate Twilio (and through it, any phone number). We validate
 *     Twilio's X-Twilio-Signature on every production request.
 *  2. Prompt/structure injection — user texts are untrusted input that flows
 *     into Claude prompts and our tag parser. We strip our own structural
 *     tags (<profile_update>) and control characters so a message can never
 *     masquerade as model output, and cap length so a single text can't
 *     blow out the context window.
 *  3. Multimedia — we never fetch user-supplied media URLs. MMS is detected
 *     and answered politely without touching the attachment.
 */

const MAX_BODY_LENGTH = 1200; // ~8 SMS segments; beyond this is abuse, not romance

const PUBLIC_WEBHOOK_URL =
  process.env.SMS_WEBHOOK_URL ??
  "https://us-central1-cupid-dating-mvp.cloudfunctions.net/smsWebhook";

/** True when running under the emulator / demo harness (no real Twilio). */
function isLocalDev(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.DEMO_MODE === "true";
}

/**
 * Verify the request actually came from Twilio. Returns true when valid.
 * Always true in local dev (the harness posts directly without signatures).
 */
export function verifyTwilioRequest(req: Request): boolean {
  if (isLocalDev()) return true;

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    functions.logger.warn("Inbound request missing X-Twilio-Signature");
    return false;
  }

  const params = (req.body ?? {}) as Record<string, string>;
  const valid = validateTwilioSignature(PUBLIC_WEBHOOK_URL, params, signature);
  if (!valid) {
    functions.logger.warn("Twilio signature validation FAILED", {
      url: PUBLIC_WEBHOOK_URL,
    });
  }
  return valid;
}

/**
 * Sanitize an inbound message body before it touches prompts or storage.
 * - strips C0/C1 control chars and zero-width/bidi characters
 * - strips our structural tags so user text can't impersonate model output
 * - collapses whitespace runs, trims, caps length
 */
export function sanitizeInboundBody(raw: string): string {
  let s = raw ?? "";

  // Control characters (keep \n), zero-width + bidi override characters
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");

  // Our own structural tags — user input must never look like model output
  s = s.replace(/<\/?profile_update>/gi, "");

  // Whitespace hygiene + hard cap
  s = s.replace(/[ \t]{3,}/g, "  ").trim();
  if (s.length > MAX_BODY_LENGTH) {
    s = s.slice(0, MAX_BODY_LENGTH);
  }

  return s;
}

// ─── Abuse-signal detectors (read-only; never mutate or log the body) ──────────
//
// These read RAW inbound text to decide whether to emit an abuse signal. They
// never log the matched body and never place body content in evidence (callers
// emit fixed-label evidence only). Sanitization is separate (above): detectors
// run on raw input so a stripped tag still registers as an injection attempt.

// Structural-tag injection (reuses the exact literal sanitizeInboundBody strips)
// plus anchored jailbreak phrasing. Kept narrow to avoid flagging normal dating
// chat. Case-insensitive.
const INJECTION_PHRASE_RE =
  /<\/?profile_update>|ignore (?:all |the )?(?:previous|prior|above) (?:instructions|prompts?)|disregard (?:all |the )?(?:previous|prior|above)|you are (?:now )?(?:a|an|in) (?:developer|dev|debug|admin|jailbreak)|system prompt|reveal (?:your )?(?:instructions|system prompt|prompt)/i;

export function detectInjection(raw: string): boolean {
  return INJECTION_PHRASE_RE.test(raw ?? "");
}

// Off-mission / freeloader proxy: the user is treating Cupid as a general
// assistant rather than a matchmaker. Heuristic, intentionally conservative.
const OFF_MISSION_RE =
  /\b(write|generate|create|give me|compose) (me )?(a |an |some )?(essay|poem|code|script|function|program|story|recipe|email|sql|python|javascript)\b|\b(solve|calculate|compute) (this|the|my)\b|\bhomework\b|\btranslate (this|the following)\b|\bact as (?:a |an |my |your )?(?!matchmaker|wingman)(?:chatgpt|assistant|ai|bot|model|developer|expert)\b/i;

export function detectOffMission(body: string): boolean {
  return OFF_MISSION_RE.test(body ?? "");
}

// Contact-share vector on the INBOUND path: a URL or a phone-shaped string in
// the user's own message. The SENDER is the actor, so an emit keyed on the
// sender's phoneHash is correctly attributed (the B1 fix for contact_scrub).
const INBOUND_URL_RE =
  /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|app|io|co|me|info|biz|xyz)\b/i;
const INBOUND_PHONE_RE =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\+1\d{10}/;

export function detectContactShare(raw: string): boolean {
  const s = raw ?? "";
  return INBOUND_URL_RE.test(s) || INBOUND_PHONE_RE.test(s);
}

/** True if the inbound Twilio payload carries media attachments (MMS). */
export function hasMedia(body: Record<string, unknown>): boolean {
  const n = parseInt(String(body?.NumMedia ?? "0"), 10);
  return Number.isFinite(n) && n > 0;
}

export const MEDIA_DECLINED_MESSAGE =
  "I'm a text-only matchmaker — photos and attachments don't reach me (by design: nobody here judges by pictures). Tell me in words! 💬";
