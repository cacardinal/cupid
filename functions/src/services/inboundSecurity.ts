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

/** True if the inbound Twilio payload carries media attachments (MMS). */
export function hasMedia(body: Record<string, unknown>): boolean {
  const n = parseInt(String(body?.NumMedia ?? "0"), 10);
  return Number.isFinite(n) && n > 0;
}

export const MEDIA_DECLINED_MESSAGE =
  "I'm a text-only matchmaker — photos and attachments don't reach me (by design: nobody here judges by pictures). Tell me in words! 💬";
