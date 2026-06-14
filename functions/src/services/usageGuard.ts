import { UserProfile } from "../models/user";
import { updateUser } from "./firestore";
import { logAbuseEvent } from "./abuseLog";

// Deterministic cost control for the conversation path. Prompt rules redirect
// freeloaders; this guard is the hard backstop so a user (or bot) hammering the
// number can't burn a Claude call per text indefinitely. Matching, scheduling,
// and match-response flows are NOT capped — only free-form conversation turns.

export const DAILY_TURN_CAP = 60;

const CT_OFFSET_HOURS = 5; // matches scheduling.ts convention

export function ctDateString(now: Date): string {
  const ct = new Date(now.getTime() - CT_OFFSET_HOURS * 3600 * 1000);
  return ct.toISOString().slice(0, 10);
}

export type CapDecision =
  | { allowed: true }
  | { allowed: false; sendNotice: boolean };

export const CAP_NOTICE_MESSAGE =
  "We've been texting up a storm today and I want to spend some of it actually looking for your person. Let's pick this back up tomorrow 💘";

/**
 * Counts this turn against the user's daily budget and decides whether the
 * conversation path may call the model. Persists the updated counters.
 * Fail-open: a Firestore error never blocks a real user's message.
 */
export async function checkDailyTurnCap(
  profile: UserProfile,
  now: Date = new Date()
): Promise<CapDecision> {
  try {
    const today = ctDateString(now);
    const sameDay = profile.dailyTurnDate === today;
    const count = (sameDay ? profile.dailyTurnCount ?? 0 : 0) + 1;
    const noticeSent = sameDay && profile.capNoticeDate === today;

    const overCap = count > DAILY_TURN_CAP;
    await updateUser(profile.phoneHash, {
      dailyTurnDate: today,
      dailyTurnCount: count,
      ...(overCap && !noticeSent ? { capNoticeDate: today } : {}),
    });

    if (!overCap) return { allowed: true };

    // SITE 1: daily cap breach. Fixed-label evidence (count is a small int, not
    // PII). Fire-and-forget; the surrounding catch already swallows errors.
    void logAbuseEvent({
      phoneHash: profile.phoneHash,
      type: "daily_cap_breach",
      severity: "medium",
      evidence: `turn ${count} over ${DAILY_TURN_CAP}`,
      source: "usageGuard",
    });

    return { allowed: false, sendNotice: !noticeSent };
  } catch {
    return { allowed: true };
  }
}
