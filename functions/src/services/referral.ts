/**
 * Referral + credit service.
 *
 * Each user gets a unique referral code: "CUP-XXXXXX" (first 6 chars of their
 * phoneHash, uppercased). When a new user's first SMS contains a valid code,
 * we award +1 credit to the referrer and +1 bonus credit to the new user.
 *
 * No Stripe — credits are Firestore-only and granted only via referral.
 * A credit is consumed when Cupid sends a mutual intro (contact exchange).
 */

import { getUserByReferralCode, updateUser } from "./firestore";

/** Pattern for extracting a referral code from an SMS body string. */
const REFERRAL_PATTERN = /\bCUP-([A-F0-9]{6})\b/i;

/**
 * Extract a referral code from an SMS body string.
 * Returns the normalized code ("CUP-XXXXXX") or null if not found.
 */
export function extractReferralCode(body: string): string | null {
  const match = body.match(REFERRAL_PATTERN);
  if (!match) return null;
  return `CUP-${match[1].toUpperCase()}`;
}

/**
 * Process a referral: credit referrer +1, record referredBy on new user.
 * The caller is responsible for awarding the new user's bonus credit separately
 * (so it can be folded into the same updateUser call alongside referredBy).
 *
 * Safe to call on every new inbound message — does nothing if:
 * - code is invalid (no matching user)
 * - the new user is trying to refer themselves
 *
 * @returns the referrer's phoneHash if successfully applied, null otherwise
 */
export async function processReferral(
  newUserHash: string,
  referralCode: string
): Promise<string | null> {
  const referrer = await getUserByReferralCode(referralCode);
  if (!referrer) return null;
  if (referrer.phoneHash === newUserHash) return null;

  await updateUser(referrer.phoneHash, {
    creditsRemaining: (referrer.creditsRemaining ?? 1) + 1,
    referralCount: (referrer.referralCount ?? 0) + 1,
  });

  return referrer.phoneHash;
}

/**
 * Build the share-your-code message sent after a user completes onboarding.
 * The pre-filled SMS body embeds their referral code so new users who tap the
 * link start with the code already in their message.
 */
export function buildShareMessage(
  referralCode: string,
  cupidNumber: string
): string {
  const body = encodeURIComponent(`Hi Cupid! Referred by ${referralCode}`);
  const link = `sms:${cupidNumber}?body=${body}`;

  return (
    `Glad you're here.\n\n` +
    `If someone comes to mind who'd want this too, send them your link. ` +
    `They start with a free intro, and so do you.\n\n` +
    `${link}\n\n` +
    `Your code: ${referralCode}`
  );
}
