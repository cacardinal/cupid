/**
 * Sharing / Wingman service — the friend-to-friend growth loop.
 *
 * CONSENT-FIRST INVARIANT (non-negotiable): Cupid NEVER texts a stranger cold.
 * Every flow in this module replies ONLY to the user who texted us, handing
 * them an asset (blurb / vCard) that THEY forward to the friend. Even when a
 * user explicitly sends a friend's phone number ("set up my friend 314-555-0123"),
 * we extract the number for logging/analytics but never message it.
 *
 * Builds on the referral system (services/referral.ts): blurbs embed the
 * user's referral code (CUP-XXXXXX) so when the friend's first text contains
 * it, both sides get +1 credit via the existing processReferral mechanics.
 */

import * as functions from "firebase-functions";
import { sendSms, sendContactCard } from "./twilio";
import { UserProfile } from "../models/user";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShareIntent =
  | { kind: "share_blurb" }
  | { kind: "contact_card" }
  | { kind: "wingman_number"; friendNumber: string }
  | { kind: "none" };

// ─── Cupid's number (display form for user-visible copy) ──────────────────────

const DEFAULT_DISPLAY_NUMBER = "+1 (314) 377-7361";

/** Format an E.164 US number for human eyes; fall back to the raw value. */
function displayNumber(raw?: string): string {
  const n = raw ?? process.env.TWILIO_PHONE_NUMBER;
  if (!n) return DEFAULT_DISPLAY_NUMBER;
  const digits = n.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return n;
}

// ─── Share blurb ──────────────────────────────────────────────────────────────

/**
 * A short forwardable text the user sends a friend. Contains the user's
 * referral code so extractReferralCode() picks it up on the friend's first
 * message and both get credit.
 */
export function buildShareBlurb(referralCode: string, cupidNumber?: string): string {
  const num = displayNumber(cupidNumber);
  return (
    `I've been texting this matchmaker called Cupid. No app, no swiping, just texting someone who actually gets to know you. ` +
    `Text "Hi Cupid ${referralCode}" to ${num} and you start with a free intro.`
  );
}

// ─── Intent detection ─────────────────────────────────────────────────────────

// Phrases, not bare words, so "I shared a pizza" or "my friend says hi" never trigger.
const CONTACT_CARD_PHRASES = [
  "contact card",
  "send your card",
  "send me your card",
  "your vcard",
  "vcard",
  "save your number",
  "save your contact",
  "send your contact",
  "send me your contact",
  "your contact info",
];

const SHARE_PHRASES = [
  "share you",
  "share cupid",
  "share your number",
  "share your info",
  "share this with",
  "how do i share",
  "how can i share",
  "tell my friend",
  "tell a friend",
  "tell my friends",
  "tell her about you",
  "tell him about you",
  "tell them about you",
  "invite my friend",
  "invite a friend",
  "invite someone",
  "refer a friend",
  "refer my friend",
  "referral code",
  "my referral",
  "referral link",
  "send to my friend",
  "send my friend",
  "give your number to",
  "introduce you to",
  "put my friend on",
];

// A friend's phone number plus one of these = wingman intent.
const WINGMAN_INTENT_PHRASES = [
  "set up",
  "setup",
  "set them up",
  "introduce",
  "match",
  "wingman",
  "friend",
  "sister",
  "brother",
  "cousin",
  "coworker",
  "roommate",
  "buddy",
];

// US phone number: optional +1, optional parens/dots/dashes/spaces.
const PHONE_PATTERN = /(?:\+?1[\s.()-]*)?\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})\b/;

/**
 * Extract a friend's phone number from a wingman-style message
 * ("set up my friend 314-555-0123"). Returns the number in E.164 form.
 *
 * The caller MUST honor the consent-first invariant: this number is never
 * texted. The user gets a blurb to forward instead.
 */
export function detectWingmanNumber(messageBody: string): string | null {
  const normalized = messageBody.toLowerCase();
  const hasIntent = WINGMAN_INTENT_PHRASES.some((p) => normalized.includes(p));
  if (!hasIntent) return null;

  const match = messageBody.match(PHONE_PATTERN);
  if (!match) return null;

  return `+1${match[1]}${match[2]}${match[3]}`;
}

/**
 * Classify an inbound message into a sharing intent.
 * Order matters: contact card is most specific, then wingman (needs a phone
 * number), then the generic share ask.
 */
export function detectShareIntent(messageBody: string): ShareIntent {
  const normalized = messageBody.toLowerCase();

  if (CONTACT_CARD_PHRASES.some((p) => normalized.includes(p))) {
    return { kind: "contact_card" };
  }

  const friendNumber = detectWingmanNumber(messageBody);
  if (friendNumber) {
    return { kind: "wingman_number", friendNumber };
  }

  if (SHARE_PHRASES.some((p) => normalized.includes(p))) {
    return { kind: "share_blurb" };
  }

  return { kind: "none" };
}

// ─── Reply builders (all user-visible copy: warm, concise, no dashes) ─────────

export function buildShareReply(referralCode: string): string {
  return `Forward them this:\n\n${buildShareBlurb(referralCode)}`;
}

export function buildWingmanReply(referralCode: string): string {
  return (
    `Love the wingman energy, but I don't text strangers out of the blue. ` +
    `Forward them this and I'll take it from there:\n\n${buildShareBlurb(referralCode)}`
  );
}

export function buildContactCardReply(referralCode: string): string {
  return `Card's on the way, save me. If a friend wants in, forward them this:\n\n${buildShareBlurb(referralCode)}`;
}

// ─── Handler (the only place this module sends anything) ─────────────────────

/**
 * Route a sharing intent to the right asset. Returns true if the message was
 * handled (caller should stop routing), false if no sharing intent.
 *
 * INVARIANT: every send below goes to `from` (the user who texted us).
 * The wingman friendNumber is logged, never messaged.
 */
export async function handleSharingIntent(
  from: string,
  messageBody: string,
  profile: UserProfile
): Promise<boolean> {
  const intent = detectShareIntent(messageBody);
  if (intent.kind === "none") return false;

  const code = profile.referralCode;

  switch (intent.kind) {
    case "share_blurb":
      await sendSms(from, buildShareReply(code));
      return true;

    case "contact_card":
      await sendContactCard(from);
      await sendSms(from, buildContactCardReply(code));
      return true;

    case "wingman_number":
      // Consent-first: do NOT text intent.friendNumber. The user forwards.
      functions.logger.info("Wingman number received (not contacted, consent-first)", {
        user: profile.phoneHash.slice(0, 8),
        friendNumberSuffix: intent.friendNumber.slice(-4),
      });
      await sendSms(from, buildWingmanReply(code));
      return true;
  }
}
