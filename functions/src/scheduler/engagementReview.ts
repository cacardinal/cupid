import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { ProactiveLogEntry, UserProfile } from "../models/user";

// ─── Nightly engagement review ────────────────────────────────────────────────
//
// Replaces the fixed-cadence friendCheckins as the proactive driver. For each
// due member: gate (isDueForCheckin + busy-match + cadence ceiling), build
// near-matches and profile gaps, ask the model decideFollowUp (which may
// decline), and on a real follow-up QUEUE a scheduled_message timed by
// activeHours. Never sends directly, only queues. All work fire-and-forget at
// the index/pubsub layer.

export const PROACTIVE_WEEKLY_CAP = 3; // proactive messages per rolling 7 days
export const PROACTIVE_MIN_GAP_HOURS = 36; // min spacing between two proactive sends

const ROLLING_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface EngagementReviewSummary {
  considered: number;
  queued: number;
  declined: number;
  byIntent: { rapport: number; deepen: number; reveal_match: number };
}

/**
 * True when the member has hit the proactive cadence ceiling: 3 proactive sends
 * in the last 7 days, OR a proactive send within the last 36 hours. Used as the
 * second gate in the review and re-checked at drain.
 */
export function proactiveCeilingExceeded(
  member: UserProfile,
  now: Date = new Date()
): boolean {
  const nowMs = now.getTime();
  // Sim runs in compressed real time; collapse the min-gap in DEMO_MODE so a
  // member can receive more than one proactive send across the run (the weekly
  // cap still prevents spam). Production gap untouched.
  const minGapHours = process.env.DEMO_MODE === "true" ? 0.1 : PROACTIVE_MIN_GAP_HOURS;

  // Min-gap on the most recent proactive send.
  if (member.lastProactiveAt) {
    const hoursSince = (nowMs - member.lastProactiveAt.toMillis()) / 3_600_000;
    if (hoursSince < minGapHours) return true;
  }

  // Weekly cap over the rolling window.
  const recent = (member.proactiveLog ?? []).filter(
    (e: ProactiveLogEntry) => nowMs - e.at.toMillis() < ROLLING_WINDOW_MS
  );
  if (recent.length >= PROACTIVE_WEEKLY_CAP) return true;

  return false;
}

// Default capped low so a single review run cannot fire its whole decideFollowUp
// burst in one tick and starve persona conversations of shared bridge slots in
// the sim. The gates (cadence ceiling, busy-match) still apply per member.
export async function runEngagementReview(limit = 40): Promise<EngagementReviewSummary> {
  const {
    getAllActiveUsers,
    getActiveMatchForUser,
    getConversationHistory,
    getUsersWithoutRecentMatch,
    getLastInboundAt,
    updateUser,
  } = await import("../services/firestore");
  const { isDueForCheckin, BUSY_MATCH_STATUSES } = await import("./friendCheckins");
  const { findNearMatches } = await import("../services/nearMatch");
  const { profileGaps } = await import("../services/profileGaps");
  const { decideFollowUp } = await import("../services/claude");
  const { inferActiveWindow, computeSendAt } = await import("../services/activeHours");
  const { enqueueScheduledMessage } = await import("./scheduledMessages");

  const summary: EngagementReviewSummary = {
    considered: 0,
    queued: 0,
    declined: 0,
    byIntent: { rapport: 0, deepen: 0, reveal_match: 0 },
  };

  const users = await getAllActiveUsers();
  let pool: UserProfile[] | null = null;

  for (const user of users) {
    if (summary.queued >= limit) break;
    try {
      // Gate 1: standard check-in eligibility (active, onboarded, cadence, not
      // double-texting a recently-active member).
      if (!isDueForCheckin(user)) continue;

      // Gate 2: busy match flow.
      const activeMatch = await getActiveMatchForUser(user.phoneHash);
      if (activeMatch && BUSY_MATCH_STATUSES.has(activeMatch.status)) continue;

      // Gate 3: proactive cadence ceiling.
      if (proactiveCeilingExceeded(user)) continue;

      summary.considered++;

      // Build candidate material against the available pool.
      if (!pool) pool = (await getUsersWithoutRecentMatch(24));
      const candidates = pool.filter((u) => u.phoneHash !== user.phoneHash);
      const nearMatches = findNearMatches(user, candidates);
      const gaps = profileGaps(user);

      const history = await getConversationHistory(user.phoneHash, 12);
      const decision = await decideFollowUp(user, history, nearMatches, gaps);

      if (!decision.followUp || !decision.message) {
        summary.declined++;
        continue;
      }

      // Choose a topic for de-dup: for a reveal_match prefer the chosen
      // near-match's topic, else the first gap, else rapport.
      const revealNm = nearMatches.find(
        (nm) => nm.blockingFilter === "location"
      );
      const topic =
        decision.intent === "reveal_match" && revealNm
          ? revealNm.topic
          : decision.intent === "deepen" && gaps[0]
          ? gaps[0].topic
          : "rapport";

      const window = inferActiveWindow(
        history,
        user.quietHoursStart,
        user.quietHoursEnd
      );
      const sendAt = computeSendAt(window, new Date());

      // Capture the freshness anchor BEFORE the proactive-tracker write below.
      // The drain compares the member's last-inbound time against this anchor,
      // not against the doc's `updatedAt` (which the updateUser call just below
      // bumps), so the review's own bookkeeping can't masquerade as a fresh
      // inbound and skip the queued message.
      const lastInbound = await getLastInboundAt(user.phoneHash);

      await enqueueScheduledMessage({
        phoneHash: user.phoneHash,
        body: decision.message,
        sendAt,
        kind: decision.intent,
        ...(lastInbound ? { inboundAnchorMs: lastInbound.toMillis() } : {}),
        topic,
        reason: decision.reason,
      });

      // Update proactive trackers immediately so the cadence ceiling counts this
      // queued message (prevents over-queueing across the same nightly run and
      // future runs before it drains). Trim to last 10.
      const entry: ProactiveLogEntry = {
        at: Timestamp.now(),
        kind: decision.intent,
        topic,
      };
      const updates: Partial<UserProfile> = {
        lastProactiveAt: Timestamp.now(),
        proactiveLog: [...(user.proactiveLog ?? []), entry].slice(-10),
      };
      // If a location near-match was revealed, record the openness re-ask anchor.
      if (decision.intent === "reveal_match" && revealNm) {
        updates.preferences = {
          ...user.preferences,
          opennessAskedAt: Timestamp.now(),
        };
      }
      await updateUser(user.phoneHash, updates);

      summary.queued++;
      summary.byIntent[decision.intent]++;
      functions.logger.info("Engagement follow-up queued", {
        userHash: user.phoneHash.slice(0, 8),
        intent: decision.intent,
      });
    } catch (err) {
      functions.logger.error("Engagement review error", {
        userHash: user.phoneHash.slice(0, 8),
        err,
      });
    }
  }

  return summary;
}
