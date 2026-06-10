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
