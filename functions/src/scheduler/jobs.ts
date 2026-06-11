import * as functions from "firebase-functions";

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

/**
 * Core nightly matching logic — shared by the scheduled `nightlyMatching`
 * function and the demo-only `demoAdmin?action=runMatching` endpoint.
 */
export async function runNightlyMatching(): Promise<MatchingRunSummary> {
  const { getUsersWithoutRecentMatch, createMatchRecord, updateUser, getPhoneByHash } =
    await import("../services/firestore");
  const { findTopMatches } = await import("./matchingJob");
  const { generateMatchProposal } = await import("../services/claude");
  const { sendSms } = await import("../services/twilio");
  const { Timestamp } = await import("firebase-admin/firestore");

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

      functions.logger.info("Nightly match created", {
        score: pair.score,
        matchIdA,
        matchIdB,
        reasons: pair.reasons,
      });

      const [phoneA, phoneB] = await Promise.all([
        getPhoneByHash(pair.userA.phoneHash),
        getPhoneByHash(pair.userB.phoneHash),
      ]);

      await Promise.all([
        phoneA ? sendSms(phoneA, proposalA.message) : Promise.resolve(),
        phoneB ? sendSms(phoneB, proposalB.message) : Promise.resolve(),
      ]);

      functions.logger.info("Nightly match proposed", {
        score: pair.score,
        sentA: !!phoneA,
        sentB: !!phoneB,
      });

      summary.pairsCreated++;
      summary.pairs.push({
        userA: pair.userA.phoneHash,
        userB: pair.userB.phoneHash,
        score: pair.score,
        reasons: pair.reasons,
      });
    } catch (pairErr) {
      functions.logger.error("Error processing match pair", pairErr);
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
  const { getAllActiveUsers, getActiveMatchForUser, updateMatchStatus, getPhoneByHash } =
    await import("../services/firestore");
  const { generatePostVideoFollowUp } = await import("../services/claude");
  const { sendSms } = await import("../services/twilio");

  const users = await getAllActiveUsers();
  const summary: VideoExpirySummary = { followUpsSent: 0, matches: [] };

  for (const user of users) {
    try {
      const match = await getActiveMatchForUser(user.phoneHash);
      if (!match || match.status !== "video_sent") continue;

      if (!force) {
        const expiry = match.videoRoomExpiry;
        if (!expiry) continue;
        if (expiry.toMillis() > Date.now()) continue;
      }

      const followUp = await generatePostVideoFollowUp(user);
      await updateMatchStatus(user.phoneHash, match.id!, "video_expired");

      const phone = await getPhoneByHash(user.phoneHash);
      if (phone) {
        await sendSms(phone, followUp.message);
        functions.logger.info("Video follow-up sent", { userHash: user.phoneHash });
      } else {
        functions.logger.warn("No phone mapping for video follow-up", { userHash: user.phoneHash });
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
        summary.roomsOpened++;
        functions.logger.info("Scheduled date room opened", { matchId: match.id });
      }
    } catch (err) {
      functions.logger.error("Scheduled date runner error", err);
    }
  }
  return summary;
}
