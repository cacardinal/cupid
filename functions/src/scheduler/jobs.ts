import * as functions from "firebase-functions";
import { track } from "../services/analytics"; // analytics: fire-and-forget



export interface MatchingRunSummary {
  eligibleUsers: number;
  pairsCreated: number;
  pairs: Array<{
    userA: string;
    userB: string;
    score: number;
    reasons: string[];
  }>;
}

// Instant matching uses a higher confidence bar than the nightly sweep: a
// real-time intro should only fire when we're genuinely sure, not just when a
// pair clears the batch minimum.
export const INSTANT_MATCH_MIN_SCORE = 70;

import type { MatchPair } from "./matchingJob";

/**
 * Create the reciprocal match records, set cooldowns, generate both proposals,
 * and text both users. Shared by the nightly sweep and instant matching.
 * Returns the proposed-pair summary entry, or null if anything failed.
 */
export async function proposeMatchPair(
  pair: MatchPair
): Promise<{ userA: string; userB: string; score: number; reasons: string[] } | null> {
  const { createMatchRecord, updateUser, getPhoneByHash } = await import("../services/firestore");
  const { generateMatchProposal } = await import("../services/claude");
  const { sendSms } = await import("../services/twilio");
  const { Timestamp } = await import("firebase-admin/firestore");

  try {
    const [proposalA, proposalB] = await Promise.all([
      generateMatchProposal(pair.userA, pair.userB),
      generateMatchProposal(pair.userB, pair.userA),
    ]);

    const now = Timestamp.now();
    const cooldown = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);

    const [matchIdA, matchIdB] = await Promise.all([
      createMatchRecord({
        userId: pair.userA.phoneHash,
        matchedUserId: pair.userB.phoneHash,
        status: "proposed",
        compatibilityScore: pair.score,
        proposedAt: now,
        updatedAt: now,
      }),
      createMatchRecord({
        userId: pair.userB.phoneHash,
        matchedUserId: pair.userA.phoneHash,
        status: "proposed",
        compatibilityScore: pair.score,
        proposedAt: now,
        updatedAt: now,
      }),
    ]);

    await Promise.all([
      updateUser(pair.userA.phoneHash, { matchCooldownUntil: cooldown }),
      updateUser(pair.userB.phoneHash, { matchCooldownUntil: cooldown }),
    ]);

    void track("match_proposed", pair.userA.phoneHash, { matchId: matchIdA, score: pair.score });
    void track("match_proposed", pair.userB.phoneHash, { matchId: matchIdB, score: pair.score });

    const [phoneA, phoneB] = await Promise.all([
      getPhoneByHash(pair.userA.phoneHash),
      getPhoneByHash(pair.userB.phoneHash),
    ]);

    await Promise.all([
      phoneA ? sendSms(phoneA, proposalA.message) : Promise.resolve(),
      phoneB ? sendSms(phoneB, proposalB.message) : Promise.resolve(),
    ]);

    functions.logger.info("Match proposed", { score: pair.score, matchIdA, matchIdB });
    return {
      userA: pair.userA.phoneHash,
      userB: pair.userB.phoneHash,
      score: pair.score,
      reasons: pair.reasons,
    };
  } catch (err) {
    functions.logger.error("proposeMatchPair failed", err);
    return null;
  }
}

export interface InstantMatchResult {
  matched: boolean;
  score?: number;
  matchedWith?: string;
  reason?: string;
}

/**
 * Try to introduce a single user RIGHT NOW (e.g. just after they finish
 * onboarding) instead of waiting for the nightly sweep. Finds this user's best
 * available partner; only proposes if the pair clears INSTANT_MATCH_MIN_SCORE.
 * Because it texts both sides, a user who has been waiting also gets introduced
 * the moment a strong new candidate completes onboarding.
 *
 * Note: the candidate-busy check is a read, not a transaction, so two
 * simultaneous completions could both pick the same third user (worst case: an
 * extra proposal). The 24h cooldown set on proposal limits the blast radius;
 * a Firestore transaction is the proper fix when volume warrants it.
 */
export async function attemptInstantMatch(phoneHash: string): Promise<InstantMatchResult> {
  const { getUser, getUsersWithoutRecentMatch, getActiveMatchForUser } = await import(
    "../services/firestore"
  );
  const { computeCompatibility, isPairBlocked } = await import("./matchingJob");

  const me = await getUser(phoneHash);
  if (!me || !me.onboardingComplete) return { matched: false, reason: "not_ready" };
  if (me.matchCooldownUntil && me.matchCooldownUntil.toMillis() > Date.now()) {
    return { matched: false, reason: "cooldown" };
  }
  if (await getActiveMatchForUser(phoneHash)) return { matched: false, reason: "active_match" };

  const pool = (await getUsersWithoutRecentMatch(24)).filter((u) => u.phoneHash !== phoneHash);
  let best: MatchPair | null = null;
  for (const cand of pool) {
    // Re-match avoidance: never re-pair a pair that already said no.
    if (isPairBlocked(me, cand)) continue;
    const r = computeCompatibility(me, cand);
    if (!r.passed || r.score < INSTANT_MATCH_MIN_SCORE) continue;
    if (!best || r.score > best.score) {
      best = { userA: me, userB: cand, score: r.score, reasons: r.reasons };
    }
  }
  if (!best) return { matched: false, reason: "no_candidate" };

  // Narrow the race window: skip if the chosen candidate just got matched.
  if (await getActiveMatchForUser(best.userB.phoneHash)) {
    return { matched: false, reason: "candidate_busy" };
  }

  const result = await proposeMatchPair(best);
  return result
    ? { matched: true, score: best.score, matchedWith: best.userB.phoneHash }
    : { matched: false, reason: "propose_failed" };
}

// ─── Event-driven re-scoring ──────────────────────────────────────────────────

// Match-affecting fields. A merged profile update that touches any of these is
// "material" and warrants a re-score; an onboardingStage-only or narrative-only
// update is not. Used by the webhook to decide whether to fire reassessMatchPool.
const MATERIAL_PREFERENCE_KEYS = new Set([
  "ageMin",
  "ageMax",
  "genderPreference",
  "relationshipIntent",
  "dealbreakers",
  "locationOpenness",
]);
const MATERIAL_PERSONALITY_KEYS = new Set([
  "values",
  "interests",
  "wantsKids",
  "hasKids",
]);

/**
 * True when a merged profile update touches a field that can change matching
 * outcomes. `updates` is the Partial<UserProfile> produced by mergeProfileUpdates.
 */
export function isMaterialChange(updates: Partial<import("../models/user").UserProfile>): boolean {
  if (!updates) return false;
  // Any demographics change is material (city, age, gender, orientation).
  if (updates.demographics && Object.keys(updates.demographics).length > 0) return true;
  if (updates.preferences) {
    for (const k of Object.keys(updates.preferences)) {
      if (MATERIAL_PREFERENCE_KEYS.has(k)) return true;
    }
  }
  if (updates.personality) {
    for (const k of Object.keys(updates.personality)) {
      if (MATERIAL_PERSONALITY_KEYS.has(k)) return true;
    }
  }
  return false;
}

export interface ReassessResult {
  reassessed: boolean;
  instantMatched?: boolean;
  nearMatchCount?: number;
  openCitiesUpdated?: boolean;
  reason?: string;
}

/**
 * Re-score a single member after a material profile/preference change. Fire-and
 * -forget from the webhook; never throws to the caller. Interprets any new
 * locationOpenness into structured locationOpenCities (model, review-time), then
 * tries an instant match and computes near-matches for telemetry.
 */
export async function reassessMatchPool(phoneHash: string): Promise<ReassessResult> {
  try {
    const { getUser, getUsersWithoutRecentMatch, updateUser } = await import(
      "../services/firestore"
    );
    const me = await getUser(phoneHash);
    if (!me || !me.onboardingComplete || me.active === false) {
      return { reassessed: false, reason: "not_ready" };
    }

    let openCitiesUpdated = false;

    // (1) Interpret openness prose into structured cities (deterministic matcher
    // never parses prose). Only when openness is set but cities not yet derived.
    if (me.preferences.locationOpenness &&
        (!me.preferences.locationOpenCities || me.preferences.locationOpenCities.length === 0)) {
      try {
        const { interpretOpenness } = await import("../services/claude");
        const pool = await getUsersWithoutRecentMatch(24);
        const candidateCities = Array.from(
          new Set(
            pool
              .filter((u) => u.phoneHash !== phoneHash)
              .map((u) => u.demographics.city?.toLowerCase().trim())
              .filter((c): c is string => !!c)
          )
        );
        const homeCity = me.demographics.city ?? "";
        const cities = await interpretOpenness(
          me.preferences.locationOpenness,
          homeCity,
          candidateCities.filter((c) => c !== homeCity.toLowerCase().trim())
        );
        if (cities.length > 0) {
          await updateUser(phoneHash, {
            preferences: { ...me.preferences, locationOpenCities: cities },
          });
          me.preferences.locationOpenCities = cities;
          openCitiesUpdated = true;
        }
      } catch (err) {
        functions.logger.error("Openness interpretation failed", err);
      }
    }

    // (2) A freshly-material change may now clear the instant bar.
    const instant = await attemptInstantMatch(phoneHash);

    // (3) Near-match telemetry (no side effects).
    let nearMatchCount = 0;
    try {
      const { findNearMatches } = await import("../services/nearMatch");
      const pool = (await getUsersWithoutRecentMatch(24)).filter(
        (u) => u.phoneHash !== phoneHash
      );
      nearMatchCount = findNearMatches(me, pool).length;
    } catch (err) {
      functions.logger.error("Near-match telemetry failed", err);
    }

    return {
      reassessed: true,
      instantMatched: instant.matched,
      nearMatchCount,
      openCitiesUpdated,
    };
  } catch (err) {
    functions.logger.error("reassessMatchPool failed", err);
    return { reassessed: false, reason: "error" };
  }
}

/**
 * Core nightly matching logic — shared by the scheduled `nightlyMatching`
 * function and the demo-only `demoAdmin?action=runMatching` endpoint.
 */
export async function runNightlyMatching(): Promise<MatchingRunSummary> {
  const { getUsersWithoutRecentMatch } = await import("../services/firestore");
  const { findTopMatches } = await import("./matchingJob");

  const users = await getUsersWithoutRecentMatch(24);
  functions.logger.info(`Found ${users.length} eligible users for matching`);

  const pairs = findTopMatches(users, 50, 1);
  functions.logger.info(`Found ${pairs.length} match pairs`);

  const summary: MatchingRunSummary = {
    eligibleUsers: users.length,
    pairsCreated: 0,
    pairs: [],
  };

  for (const pair of pairs) {
    const entry = await proposeMatchPair(pair);
    if (entry) {
      summary.pairsCreated++;
      summary.pairs.push(entry);
    }
  }

  return summary;
}

export interface VideoExpirySummary {
  followUpsSent: number;
  matches: Array<{ userHash: string; matchId: string }>;
}

/**
 * Core video-expiry follow-up logic — shared by the scheduled
 * `videoExpiryFollowUp` function and `demoAdmin?action=expireVideo`.
 * @param force  Treat all `video_sent` matches as expired regardless of
 *               their actual room expiry (demo use only).
 */
export async function runVideoExpiryFollowUp(force = false): Promise<VideoExpirySummary> {
  const { getAllActiveUsers, getActiveMatchForUser, updateMatchRecord, getPhoneByHash, appendConversationTurn } =
    await import("../services/firestore");
  const { generatePostVideoFollowUp } = await import("../services/claude");
  const { sendSms } = await import("../services/twilio");
  const { Timestamp } = await import("firebase-admin/firestore");

  const users = await getAllActiveUsers();
  const summary: VideoExpirySummary = { followUpsSent: 0, matches: [] };

  for (const user of users) {
    try {
      const match = await getActiveMatchForUser(user.phoneHash);
      // Idempotent: only video_sent matches enter the debrief, so this fires
      // exactly once per match (after which the status is debriefing).
      if (!match || match.status !== "video_sent") continue;

      if (!force) {
        const expiry = match.videoRoomExpiry;
        if (!expiry) continue;
        if (expiry.toMillis() > Date.now()) continue;
      }

      // Open the post-date debrief STAGE: status -> debriefing, ask "how did it
      // go", and reset the turn counter. Replies route to handleDebriefReply.
      const followUp = await generatePostVideoFollowUp(user);
      await updateMatchRecord(user.phoneHash, match.id!, {
        status: "debriefing",
        debriefTurnCount: 0,
      });

      const phone = await getPhoneByHash(user.phoneHash);
      if (phone) {
        await sendSms(phone, followUp.message);
        // Record the opener so the debrief handler has conversation context for
        // profile extraction on the user's first reply.
        await appendConversationTurn(user.phoneHash, {
          role: "assistant",
          content: followUp.message,
          timestamp: Timestamp.now(),
        });
        functions.logger.info("Debrief opened", { userHash: user.phoneHash.slice(0, 8) });
      } else {
        functions.logger.warn("No phone mapping for debrief opener", { userHash: user.phoneHash.slice(0, 8) });
      }

      summary.followUpsSent++;
      summary.matches.push({ userHash: user.phoneHash, matchId: match.id! });
    } catch (err) {
      functions.logger.error("Video expiry follow-up error", err);
    }
  }

  return summary;
}

export interface ScheduledDatesSummary {
  remindersSent: number;
  roomsOpened: number;
}

/**
 * Scheduled-date runner (every 5 min): sends the T-15min reminder, then opens
 * the Daily room at the scheduled time and sends both users the link.
 * @param force  Treat all scheduled dates as due now (demo use only).
 */
export async function runScheduledDates(force = false): Promise<ScheduledDatesSummary> {
  const { getAllActiveUsers, getActiveMatchForUser, updateMatchRecord, getPhoneByHash, getMatchBetween } =
    await import("../services/firestore");
  const { createAnonymousRoom } = await import("../services/daily");
  const { sendSms, sendVideoRoomLink } = await import("../services/twilio");
  const { Timestamp } = await import("firebase-admin/firestore");
  const { formatSlotCT } = await import("../services/scheduling");

  const users = await getAllActiveUsers();
  const summary: ScheduledDatesSummary = { remindersSent: 0, roomsOpened: 0 };
  const now = Date.now();

  for (const user of users) {
    try {
      const match = await getActiveMatchForUser(user.phoneHash);
      if (!match || match.status !== "scheduled" || !match.scheduledAt) continue;

      const startMs = match.scheduledAt.toMillis();
      const other = await getMatchBetween(match.matchedUserId, user.phoneHash);
      if (!other) continue;

      // T-15 reminder (once, sent by whichever side is processed first)
      if (!force && !match.reminderSent && now >= startMs - 15 * 60_000 && now < startMs) {
        const [pA, pB] = await Promise.all([
          getPhoneByHash(user.phoneHash),
          getPhoneByHash(match.matchedUserId),
        ]);
        const msg = `15 minutes until your Cupid date (${formatSlotCT(new Date(startMs))}). Find somewhere quiet — link coming right on time 💘`;
        await Promise.all([
          pA ? sendSms(pA, msg) : null,
          pB ? sendSms(pB, msg) : null,
          updateMatchRecord(user.phoneHash, match.id!, { reminderSent: true }),
          updateMatchRecord(match.matchedUserId, other.id!, { reminderSent: true }),
        ]);
        summary.remindersSent++;
        continue;
      }

      // Date time arrived → open the room
      if (force || now >= startMs) {
        const room = await createAnonymousRoom(match.id!);
        const expiry = Timestamp.fromMillis(room.expiresAt * 1000);
        await Promise.all([
          updateMatchRecord(user.phoneHash, match.id!, {
            status: "video_sent", videoRoomUrl: room.url, videoRoomExpiry: expiry,
          }),
          updateMatchRecord(match.matchedUserId, other.id!, {
            status: "video_sent", videoRoomUrl: room.url, videoRoomExpiry: expiry,
          }),
        ]);
        const [pA, pB] = await Promise.all([
          getPhoneByHash(user.phoneHash),
          getPhoneByHash(match.matchedUserId),
        ]);
        await Promise.all([
          pA ? sendVideoRoomLink(pA, room.url, "your match") : null,
          pB ? sendVideoRoomLink(pB, room.url, "your match") : null,
        ]);
        void track("video_room_opened", user.phoneHash, { matchId: match.id }); // analytics
        summary.roomsOpened++;
        functions.logger.info("Scheduled date room opened", { matchId: match.id });
      }
    } catch (err) {
      functions.logger.error("Scheduled date runner error", err);
    }
  }
  return summary;
}
