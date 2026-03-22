import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Initialize Firebase Admin
admin.initializeApp();

// Lazy imports to reduce cold start time
// ─── HTTP Functions ───────────────────────────────────────────────────────────

export const smsWebhook = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const { handleInboundSms } = await import("./webhooks/sms");
    await handleInboundSms(req, res);
  });

// ─── Scheduled Functions ──────────────────────────────────────────────────────

export const nightlyMatching = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .pubsub.schedule("every day 02:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    functions.logger.info("Nightly matching job started");

    const { getAllActiveUsers, getUser, createMatchRecord, updateUser, getUsersWithoutRecentMatch } =
      await import("./services/firestore");
    const { findTopMatches } = await import("./scheduler/matchingJob");
    const { generateMatchProposal } = await import("./services/claude");
    const { sendIntroductionMessage } = await import("./services/twilio");
    const { Timestamp } = await import("firebase-admin/firestore");

    try {
      const users = await getUsersWithoutRecentMatch(24);
      functions.logger.info(`Found ${users.length} eligible users for matching`);

      const pairs = findTopMatches(users, 50, 1);
      functions.logger.info(`Found ${pairs.length} match pairs`);

      for (const pair of pairs) {
        try {
          // Generate proposal messages for both users
          const [proposalA, proposalB] = await Promise.all([
            generateMatchProposal(pair.userA, pair.userB),
            generateMatchProposal(pair.userB, pair.userA),
          ]);

          const now = Timestamp.now();
          const cooldown = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);

          // Create match records for both users
          const [matchIdA, matchIdB] = await Promise.all([
            createMatchRecord({
              userId: pair.userA.phoneHash,
              matchedUserId: pair.userB.phoneHash,
              status: "proposed",
              compatibilityScore: pair.score,
              proposedAt: now,
              updatedAt: now,
              userAccepted: undefined,
              matchAccepted: undefined,
            }),
            createMatchRecord({
              userId: pair.userB.phoneHash,
              matchedUserId: pair.userA.phoneHash,
              status: "proposed",
              compatibilityScore: pair.score,
              proposedAt: now,
              updatedAt: now,
              userAccepted: undefined,
              matchAccepted: undefined,
            }),
          ]);

          // Update match cooldown on both users
          await Promise.all([
            updateUser(pair.userA.phoneHash, { matchCooldownUntil: cooldown }),
            updateUser(pair.userB.phoneHash, { matchCooldownUntil: cooldown }),
          ]);

          functions.logger.info("Match created", {
            score: pair.score,
            matchIdA,
            matchIdB,
            reasons: pair.reasons,
          });

          // NOTE: In production, phone numbers are stored in a secure encrypted mapping
          // and retrieved here to send the SMS. For MVP, log match IDs for manual review.
          functions.logger.info("Proposal messages generated", {
            proposalA: proposalA.message,
            proposalB: proposalB.message,
          });
        } catch (pairErr) {
          functions.logger.error("Error processing match pair", pairErr);
        }
      }

      functions.logger.info("Nightly matching job complete", { pairsProcessed: pairs.length });
    } catch (err) {
      functions.logger.error("Nightly matching job failed", err);
      throw err;
    }
  });

// ─── Video expiry follow-up ───────────────────────────────────────────────────

export const videoExpiryFollowUp = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    // Scan for video_sent matches where room has expired, send follow-up
    const { getAllActiveUsers, getActiveMatchForUser, updateMatchStatus } =
      await import("./services/firestore");
    const { generatePostVideoFollowUp } = await import("./services/claude");
    const { sendSms } = await import("./services/twilio");

    const users = await getAllActiveUsers();

    for (const user of users) {
      try {
        const match = await getActiveMatchForUser(user.phoneHash);
        if (!match || match.status !== "video_sent") continue;

        const expiry = match.videoRoomExpiry;
        if (!expiry) continue;

        const now = Date.now();
        if (expiry.toMillis() > now) continue; // Room still active

        // Room expired — send follow-up
        const followUp = await generatePostVideoFollowUp(user);
        await updateMatchStatus(user.phoneHash, match.id!, "video_expired");

        // NOTE: In production, look up actual phone from secure mapping
        functions.logger.info("Video follow-up sent", { userHash: user.phoneHash });
        // await sendSms(phone, followUp.message);
      } catch (err) {
        functions.logger.error("Video expiry follow-up error", err);
      }
    }
  });
