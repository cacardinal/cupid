/**
 * Campaign code service.
 *
 * Sibling concept to referral codes (see referral.ts): marketing codes like
 * "TEXTCUPID" that award bonus intro credits when texted to Cupid. Unlike
 * referral codes they are admin-created, work on ANY inbound message (not just
 * the first), and are redeemable once per user.
 *
 * Firestore layout:
 *   campaign_codes/{CODE}                       — code doc (doc ID = uppercase code)
 *   campaign_codes/{CODE}/redemptions/{hash}    — per-user redemption marker
 *
 * Credits use the same mechanism referral.ts uses: the user profile's
 * `creditsRemaining` counter (defaulting to 1 when unset, matching referral.ts).
 */

import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

const db = () => admin.firestore();

const CAMPAIGN_CODES_COL = "campaign_codes";
const REDEMPTIONS_SUB = "redemptions";
const USERS_COL = "users";

/** Max code-shaped tokens we look up per inbound message. */
const MAX_LOOKUPS_PER_MESSAGE = 5;

export interface CampaignCode {
  code: string; // uppercase, same as doc ID
  credits: number;
  active: boolean;
  maxRedemptions: number | null;
  redemptionCount: number;
  createdAt: Timestamp;
}

export type RedemptionResult =
  | { redeemed: true; creditsAwarded: number }
  | {
      redeemed: false;
      reason:
        | "not_found"
        | "inactive"
        | "max_redemptions"
        | "already_redeemed"
        | "user_not_found";
    };

// ─── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create (or overwrite) a campaign code. Doc ID is the uppercased code.
 */
export async function createCampaignCode(
  code: string,
  credits = 3,
  maxRedemptions: number | null = null
): Promise<CampaignCode> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(normalized)) {
    throw new Error(
      `Campaign code must be 4-12 alphanumeric characters, got: ${code}`
    );
  }

  const doc: CampaignCode = {
    code: normalized,
    credits,
    active: true,
    maxRedemptions,
    redemptionCount: 0,
    createdAt: Timestamp.now(),
  };

  await db().collection(CAMPAIGN_CODES_COL).doc(normalized).set(doc);
  return doc;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Extract code-shaped tokens from a message body: 4-12 char alphanumeric words
 * containing at least one letter, uppercased and de-duplicated, capped at
 * MAX_LOOKUPS_PER_MESSAGE so a long message can't fan out into many reads.
 *
 * Exported for testing.
 */
export function extractCandidateTokens(
  body: string,
  cap = MAX_LOOKUPS_PER_MESSAGE
): string[] {
  const tokens = body.split(/[^A-Za-z0-9]+/);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const token of tokens) {
    if (token.length < 4 || token.length > 12) continue;
    if (!/[A-Za-z]/.test(token)) continue; // pure numbers can't be codes
    const upper = token.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
    if (out.length >= cap) break;
  }

  return out;
}

/**
 * Scan a message body for an active campaign code.
 * Returns the matched (uppercase) code or null. Single batched read
 * (getAll) over at most MAX_LOOKUPS_PER_MESSAGE doc refs.
 */
export async function detectCampaignCode(
  messageBody: string
): Promise<string | null> {
  const candidates = extractCandidateTokens(messageBody);
  if (candidates.length === 0) return null;

  const refs = candidates.map((c) =>
    db().collection(CAMPAIGN_CODES_COL).doc(c)
  );
  const snaps = await db().getAll(...refs);

  for (const snap of snaps) {
    if (!snap.exists) continue;
    const data = snap.data() as CampaignCode;
    if (data.active) return data.code;
  }
  return null;
}

// ─── Redemption ───────────────────────────────────────────────────────────────

/**
 * Redeem a campaign code for a user. Idempotent per user: a redemption marker
 * at campaign_codes/{code}/redemptions/{phoneHash} is written if absent inside
 * a transaction, so double-delivery of the same message can't double-award.
 * Respects the active flag and maxRedemptions, increments redemptionCount,
 * and awards credits to the user's profile (creditsRemaining, same field
 * referral.ts uses).
 */
export async function redeemCampaignCode(
  code: string,
  phoneHash: string
): Promise<RedemptionResult> {
  const normalized = code.trim().toUpperCase();
  const codeRef = db().collection(CAMPAIGN_CODES_COL).doc(normalized);
  const redemptionRef = codeRef.collection(REDEMPTIONS_SUB).doc(phoneHash);
  const userRef = db().collection(USERS_COL).doc(phoneHash);

  return db().runTransaction(async (tx) => {
    // All reads before any writes (Firestore transaction requirement)
    const [codeSnap, redemptionSnap, userSnap] = await Promise.all([
      tx.get(codeRef),
      tx.get(redemptionRef),
      tx.get(userRef),
    ]);

    if (!codeSnap.exists) {
      return { redeemed: false, reason: "not_found" } as RedemptionResult;
    }
    const codeData = codeSnap.data() as CampaignCode;

    if (!codeData.active) {
      return { redeemed: false, reason: "inactive" } as RedemptionResult;
    }
    if (redemptionSnap.exists) {
      return { redeemed: false, reason: "already_redeemed" } as RedemptionResult;
    }
    if (
      codeData.maxRedemptions !== null &&
      codeData.maxRedemptions !== undefined &&
      (codeData.redemptionCount ?? 0) >= codeData.maxRedemptions
    ) {
      return { redeemed: false, reason: "max_redemptions" } as RedemptionResult;
    }
    if (!userSnap.exists) {
      return { redeemed: false, reason: "user_not_found" } as RedemptionResult;
    }

    const currentCredits =
      (userSnap.data()?.creditsRemaining as number | undefined) ?? 1;

    // Write-if-absent marker (create throws if it exists, but we checked above)
    tx.create(redemptionRef, {
      phoneHash,
      creditsAwarded: codeData.credits,
      redeemedAt: Timestamp.now(),
    });
    tx.update(codeRef, {
      redemptionCount: (codeData.redemptionCount ?? 0) + 1,
    });
    tx.update(userRef, {
      creditsRemaining: currentCredits + codeData.credits,
      updatedAt: Timestamp.now(),
    });

    return {
      redeemed: true,
      creditsAwarded: codeData.credits,
    } as RedemptionResult;
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * One short confirmation sentence in Cupid's voice.
 * No dashes, no assistant-speak, no exclamation spam.
 */
export function buildCampaignConfirmation(
  code: string,
  creditsAwarded: number
): string {
  const intros = creditsAwarded === 1 ? "1 free intro" : `${creditsAwarded} free intros`;
  return `Code ${code} is good, just added ${intros} to your account.`;
}
