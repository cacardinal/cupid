import twilio from "twilio";
import { track } from "./analytics";
import { logAbuseEvent, SYSTEM_ACTOR } from "./abuseLog";

let _client: twilio.Twilio | null = null;

function getClient(): twilio.Twilio {
  if (!_client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error("Missing Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)");
    }
    _client = twilio(accountSid, authToken);
  }
  return _client;
}

const CUPID_NUMBER = () => {
  const n = process.env.TWILIO_PHONE_NUMBER;
  if (!n) throw new Error("Missing TWILIO_PHONE_NUMBER env var");
  return n;
};

// ─── SMS ──────────────────────────────────────────────────────────────────────

export interface SendOptions {
  /** Phone numbers permitted in this message (contact-exchange flow). */
  allowPhones?: string[];
}

export async function sendSms(to: string, rawBody: string, opts: SendOptions = {}): Promise<string> {
  // Brand rule: nothing Cupid sends contains em/en dashes (model slips AND
  // hardcoded strings are both covered here, the single outbound choke point).
  const dashed = rawBody.replace(/\s*[—–]\s*/g, ", ");
  // Anti-phishing: strip non-allowlisted URLs and phone numbers. Deterministic,
  // covers prompt-injection-via-profile reaching another user's messages.
  const { scrubOutbound } = await import("./outboundSecurity");
  const scrub = scrubOutbound(dashed, opts.allowPhones);
  const body = scrub.body;
  // SITE 2: outbound allowlist telemetry. Attributed to the SYSTEM sentinel,
  // never to `to`. The recipient is not the author of scrubbed content (the
  // scrubbed text is usually model output or a partner-facing system message),
  // so attributing to `to` would flag victims/bystanders. Actor-attributed
  // contact-share signals are emitted on the INBOUND path (see webhooks/sms.ts).
  if (scrub.removedUrls.length || scrub.removedPhones.length) {
    void logAbuseEvent({
      phoneHash: SYSTEM_ACTOR,
      type: "contact_scrub",
      severity: "low",
      evidence: `stripped ${scrub.removedUrls.length} url ${scrub.removedPhones.length} phone`,
      source: "outboundAllowlist",
    });
  }
  void track("message_sent", to, { length: body.length }); // analytics: `to` is hashed inside track, never sent raw
  // Demo mode: write to Firestore outbox instead of hitting Twilio.
  // Lets the local demo harness render outbound messages as chat bubbles.
  if (process.env.DEMO_MODE === "true") {
    const { getFirestore, Timestamp } = await import("firebase-admin/firestore");
    const ref = await getFirestore().collection("demo_outbox").add({
      to,
      body,
      sentAt: Timestamp.now(),
    });
    return `demo-${ref.id}`;
  }

  // Enforce SMS length — split if > 1600 chars
  const chunks = splitMessage(body);
  let lastSid = "";

  for (const chunk of chunks) {
    const msg = await getClient().messages.create({
      body: chunk,
      from: CUPID_NUMBER(),
      to,
    });
    lastSid = msg.sid;
  }

  return lastSid;
}

// ─── Contact card (vCard via MMS) ─────────────────────────────────────────────

const CONTACT_CARD_URL = "https://textcupid.co/cupid.vcf";

/** Send Cupid's vCard so the user can save the number and share it onward. */
export async function sendContactCard(to: string): Promise<string> {
  const body = "Here's my card 💘";

  // Demo mode: write to the outbox with the mediaUrl so the harness can
  // render the attachment bubble.
  if (process.env.DEMO_MODE === "true") {
    const { getFirestore, Timestamp } = await import("firebase-admin/firestore");
    const ref = await getFirestore().collection("demo_outbox").add({
      to,
      body,
      mediaUrl: CONTACT_CARD_URL,
      sentAt: Timestamp.now(),
    });
    return `demo-${ref.id}`;
  }

  const msg = await getClient().messages.create({
    body,
    from: CUPID_NUMBER(),
    to,
    mediaUrl: [CONTACT_CARD_URL],
  });
  return msg.sid;
}

export async function sendIntroductionMessage(
  to: string,
  proposalText: string
): Promise<string> {
  return sendSms(to, proposalText);
}

export async function sendVideoRoomLink(
  to: string,
  roomUrl: string,
  otherPersonDescription: string
): Promise<string> {
  const body = `Here's your private video link, no names, no pressure, just a quick face to face.

${roomUrl}

The room's open for the next 15 minutes. You two already have real things in common.`;

  return sendSms(to, body);
}

export async function sendContactExchangeMessage(
  to: string,
  otherName: string,
  otherPhone: string
): Promise<string> {
  // otherName is a neutral label ("your match"), never a real name. The only
  // real phone number Cupid ever sends rides in this single message, allowlisted
  // so the outbound scrubber lets it through.
  const body = `Here's how to reach ${otherName}:
${otherPhone}

Take it from here. I'm rooting for you both.`;
  return sendSms(to, body, { allowPhones: [otherPhone] });
}

export async function sendDeclinedMessage(to: string): Promise<string> {
  const body = `Not quite the right fit this time. I'm already thinking about who else could be a good match for you.`;
  return sendSms(to, body);
}

// ─── Webhook validation ───────────────────────────────────────────────────────

export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text: string, maxLength = 1600): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}
