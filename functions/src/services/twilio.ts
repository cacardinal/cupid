import twilio from "twilio";
import { track } from "./analytics";

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

export async function sendSms(to: string, rawBody: string): Promise<string> {
  // Brand rule: nothing Cupid sends contains em/en dashes (model slips AND
  // hardcoded strings are both covered here, the single outbound choke point).
  const body = rawBody.replace(/\s*[—–]\s*/g, ", ");
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
  const body = `You're both interested! 🎉 Here's your private video link — no names, no pressure, just a quick face-to-face.

${roomUrl}

The room is open for 15 minutes. You already know you have great things in common with this person.`;

  return sendSms(to, body);
}

export async function sendContactExchangeMessage(
  to: string,
  otherName: string,
  otherPhone: string
): Promise<string> {
  const body = `Great connection! Here are ${otherName}'s details:
📱 ${otherPhone}

Reach out and take it from here. Rooting for you both 💫`;
  return sendSms(to, body);
}

export async function sendDeclinedMessage(to: string): Promise<string> {
  const body = `It wasn't quite the right fit this time — that happens! I'm already thinking about who else might be a great match for you. Stay tuned.`;
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
