import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Initialize Firebase Admin
admin.initializeApp();

// ─── SMS Webhook ──────────────────────────────────────────────────────────────

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

// ─── Voice Webhooks ───────────────────────────────────────────────────────────

/** Initial call entry — greet user, start gathering speech */
export const voiceWebhook = functions
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const { handleInboundCall } = await import("./webhooks/voice");
    await handleInboundCall(req, res);
  });

/** Speech input received — transcribe, run Claude, respond */
export const voiceGather = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const { handleVoiceGather } = await import("./webhooks/voice");
    await handleVoiceGather(req, res);
  });

/** Recording ready — Deepgram transcription → async SMS response */
export const voiceRecording = functions
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const { handleVoiceRecording } = await import("./webhooks/voice");
    await handleVoiceRecording(req, res);
  });

/** Call status updates (completed, busy, no-answer) */
export const voiceStatus = functions
  .runWith({ timeoutSeconds: 10, memory: "128MB" })
  .https.onRequest(async (req, res) => {
    const { handleCallStatus } = await import("./webhooks/voice");
    await handleCallStatus(req, res);
  });

// ─── Live Matching — Firestore Trigger ───────────────────────────────────────
//
// Fires whenever a user document is updated.
// When liveStatus transitions from anything → "waiting", run the live scan.

export const onUserLiveStatusChange = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB" })
  .firestore.document("users/{phoneHash}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only act on transition INTO "waiting"
    if (before.liveStatus === "waiting" || after.liveStatus !== "waiting") {
      return null;
    }

    const phoneHash = context.params.phoneHash;
    functions.logger.info("User went live — running instant match scan", { phoneHash });

    const { scanForLiveMatch } = await import("./services/liveMatching");

    try {
      const result = await scanForLiveMatch(after as import("./models/user").UserProfile);

      if (result.matched) {
        functions.logger.info("Live match connected", {
          phoneHash,
          matchId: result.matchId,
        });
      } else {
        functions.logger.info("No live match found yet — user remains in waiting pool", {
          phoneHash,
          city: after.demographics?.city,
        });
      }
    } catch (err) {
      functions.logger.error("Live match scan error", { phoneHash, err });
    }

    return null;
  });

// ─── Scheduled: Expire live-waiting users ────────────────────────────────────
//
// Sweeps users whose 30-minute live window has expired and sets them offline.

export const expireLiveUsers = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const { expireLiveWaitingUsers } = await import("./services/liveMatching");
    const count = await expireLiveWaitingUsers();
    functions.logger.info("Live user expiry sweep complete", { expiredCount: count });
  });

// ─── Scheduled: Nightly batch matching ───────────────────────────────────────
//
// Async fallback for users who aren't using live mode.

export const nightlyMatching = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .pubsub.schedule("every day 02:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    functions.logger.info("Nightly matching job started");

    const { getUsersWithoutRecentMatch, createMatchRecord, updateUser } =
      await import("./services/firestore");
    const { findTopMatches } = await import("./scheduler/matchingJob");
    const { generateMatchProposal } = await import("./services/claude");
    const { Timestamp } = await import("firebase-admin/firestore");

    try {
      const users = await getUsersWithoutRecentMatch(24);
      functions.logger.info(`Found ${users.length} eligible users for matching`);

      const pairs = findTopMatches(users, 50, 1);
      functions.logger.info(`Found ${pairs.length} match pairs`);

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

// ─── Scheduled: Video expiry follow-up ───────────────────────────────────────

export const videoExpiryFollowUp = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const { getAllActiveUsers, getActiveMatchForUser, updateMatchStatus } =
      await import("./services/firestore");
    const { generatePostVideoFollowUp } = await import("./services/claude");

    const users = await getAllActiveUsers();

    for (const user of users) {
      try {
        const match = await getActiveMatchForUser(user.phoneHash);
        if (!match || match.status !== "video_sent") continue;

        const expiry = match.videoRoomExpiry;
        if (!expiry) continue;
        if (expiry.toMillis() > Date.now()) continue;

        await generatePostVideoFollowUp(user);
        await updateMatchStatus(user.phoneHash, match.id!, "video_expired");

        functions.logger.info("Video follow-up queued", { userHash: user.phoneHash });
        // NOTE: In production, look up phone from encrypted mapping and send SMS
      } catch (err) {
        functions.logger.error("Video expiry follow-up error", err);
      }
    }
  });
