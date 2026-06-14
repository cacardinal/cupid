import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";
import { track } from "../services/analytics"; // analytics: fire-and-forget

/**
 * Friend mode: Cupid periodically checks in like a thoughtful friend —
 * referencing things the user actually said — so the profile deepens and
 * trust builds between matches. Replies flow through the normal conversation
 * pipeline, so anything shared enriches the profile automatically.
 *
 * Cadence: every ~3 days for the first three check-ins, weekly after.
 * Skipped when: user inactive, mid-match-flow (proposal/scheduling/video),
 * or they've messaged within the last 24h (a friend doesn't double-text).
 */

const EARLY_CADENCE_DAYS = 3;
const ESTABLISHED_CADENCE_DAYS = 7;
const EARLY_CHECKIN_THRESHOLD = 3;
const RECENT_ACTIVITY_HOURS = 24;

export function isDueForCheckin(profile: UserProfile, now: Date = new Date()): boolean {
  if (!profile.active || !profile.onboardingComplete) return false;

  const count = profile.checkinCount ?? 0;
  const cadenceDays = count < EARLY_CHECKIN_THRESHOLD ? EARLY_CADENCE_DAYS : ESTABLISHED_CADENCE_DAYS;

  // Anchor on last check-in, falling back to profile updatedAt (covers brand-new users)
  const anchor = profile.lastCheckinAt ?? profile.updatedAt;
  if (!anchor) return false;
  const daysSince = (now.getTime() - anchor.toMillis()) / 86_400_000;
  if (daysSince < cadenceDays) return false;

  // A friend doesn't double-text: skip if THEY were active very recently
  const sinceUpdate = (now.getTime() - profile.updatedAt.toMillis()) / 3_600_000;
  if (sinceUpdate < RECENT_ACTIVITY_HOURS && (profile.lastCheckinAt?.toMillis() ?? 0) < profile.updatedAt.toMillis()) {
    return false;
  }
  return true;
}

/** Statuses that mean "leave them alone, a match flow is in motion". */
export const BUSY_MATCH_STATUSES = new Set([
  "proposed",
  "user_accepted",
  "scheduling",
  "scheduled",
  "mutual_interest",
  "video_sent",
]);

export async function runFriendCheckins(limit = 25): Promise<number> {
  const { getAllActiveUsers, getActiveMatchForUser, getConversationHistory, appendConversationTurn, updateUser, getPhoneByHash } =
    await import("../services/firestore");
  const { generateFriendCheckin } = await import("../services/claude");
  const { sendSms } = await import("../services/twilio");

  const users = await getAllActiveUsers();
  let sent = 0;

  for (const user of users) {
    if (sent >= limit) break;
    try {
      if (!isDueForCheckin(user)) continue;

      const activeMatch = await getActiveMatchForUser(user.phoneHash);
      if (activeMatch && BUSY_MATCH_STATUSES.has(activeMatch.status)) continue;

      const history = await getConversationHistory(user.phoneHash, 12);
      const checkin = await generateFriendCheckin(user, history);
      if (!checkin.message) continue;

      const phone = await getPhoneByHash(user.phoneHash);
      if (!phone) continue;

      await appendConversationTurn(user.phoneHash, {
        role: "assistant",
        content: checkin.message,
        timestamp: Timestamp.now(),
      });
      await sendSms(phone, checkin.message);
      await updateUser(user.phoneHash, {
        lastCheckinAt: Timestamp.now(),
        checkinCount: (user.checkinCount ?? 0) + 1,
      });

      sent++;
      void track("checkin_sent", user.phoneHash, { checkinCount: (user.checkinCount ?? 0) + 1 }); // analytics
      functions.logger.info("Friend check-in sent", { userHash: user.phoneHash.slice(0, 8) });
    } catch (err) {
      functions.logger.error("Friend check-in error", { userHash: user.phoneHash.slice(0, 8), err });
    }
  }

  return sent;
}
