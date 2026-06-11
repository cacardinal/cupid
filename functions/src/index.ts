import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Initialize Firebase Admin
admin.initializeApp();

const ALL_SECRETS = [
  "ANTHROPIC_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "PHONE_ENCRYPTION_KEY",
  "DEEPGRAM_API_KEY",
  "DAILY_API_KEY",
  "POSTHOG_API_KEY", // optional — analytics no-ops when unset (see services/analytics.ts)
];

// ─── SMS Webhook ──────────────────────────────────────────────────────────────

export const smsWebhook = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 30, memory: "256MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 60, memory: "512MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 120, memory: "512MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 10, memory: "128MB", secrets: ALL_SECRETS })
  .https.onRequest(async (req, res) => {
    const { handleCallStatus } = await import("./webhooks/voice");
    await handleCallStatus(req, res);
  });

// ─── Live Matching — Firestore Trigger ───────────────────────────────────────
//
// Fires whenever a user document is updated.
// When liveStatus transitions from anything → "waiting", run the live scan.

export const onUserLiveStatusChange = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 120, memory: "256MB", secrets: ALL_SECRETS })
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
  .runWith({ timeoutSeconds: 540, memory: "1GB", secrets: ALL_SECRETS })
  .pubsub.schedule("every day 02:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    functions.logger.info("Nightly matching job started");
    const { runNightlyMatching } = await import("./scheduler/jobs");

    try {
      const summary = await runNightlyMatching();
      functions.logger.info("Nightly matching job complete", {
        pairsProcessed: summary.pairsCreated,
      });
    } catch (err) {
      functions.logger.error("Nightly matching job failed", err);
      throw err;
    }
  });

// ─── Scheduled: Video expiry follow-up ───────────────────────────────────────

export const videoExpiryFollowUp = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB", secrets: ALL_SECRETS })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const { runVideoExpiryFollowUp } = await import("./scheduler/jobs");
    await runVideoExpiryFollowUp();
  });

// ─── Scheduled: Proactive status messages ────────────────────────────────────
//
// Sends thin-market and still-searching updates to waiting users daily.

export const proactiveStatusUpdates = functions
  .runWith({ timeoutSeconds: 300, memory: "512MB", secrets: ALL_SECRETS })
  .pubsub.schedule("every day 10:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    const { sendThinMarketUpdates, sendStillSearchingUpdates } = await import(
      "./scheduler/statusUpdates"
    );
    const [thin, still] = await Promise.all([
      sendThinMarketUpdates(),
      sendStillSearchingUpdates(),
    ]);
    functions.logger.info("Proactive status updates sent", {
      thinMarket: thin,
      stillSearching: still,
    });
  });

// ─── Demo admin endpoint (local emulator only) ──────────────────────────────
//
// Lets the local demo harness trigger scheduled jobs on demand.
// Hard-disabled unless DEMO_MODE=true (never set in production config).

export const demoAdmin = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    if (process.env.DEMO_MODE !== "true") {
      res.status(403).json({ error: "demoAdmin is disabled outside demo mode" });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const action = String(req.query.action ?? "");

    try {
      if (action === "runMatching") {
        const { runNightlyMatching } = await import("./scheduler/jobs");
        const summary = await runNightlyMatching();
        res.status(200).json({ ok: true, action, summary });
        return;
      }

      if (action === "expireVideo") {
        const { runVideoExpiryFollowUp } = await import("./scheduler/jobs");
        const summary = await runVideoExpiryFollowUp(true);
        res.status(200).json({ ok: true, action, summary });
        return;
      }

      if (action === "startScheduledDates") {
        const { runScheduledDates } = await import("./scheduler/jobs");
        const summary = await runScheduledDates(true);
        res.status(200).json({ ok: true, action, summary });
        return;
      }

      if (action === "runCheckins") {
        const { runFriendCheckins } = await import("./scheduler/friendCheckins");
        const sent = await runFriendCheckins();
        res.status(200).json({ ok: true, action, summary: { sent } });
        return;
      }

      if (action === "createCampaignCode") {
        const { createCampaignCode } = await import("./services/campaignCodes");
        const code = String(req.body?.code ?? "");
        const credits = req.body?.credits !== undefined ? Number(req.body.credits) : undefined;
        const maxRedemptions =
          req.body?.maxRedemptions !== undefined && req.body?.maxRedemptions !== null
            ? Number(req.body.maxRedemptions)
            : null;
        if (!code) {
          res.status(400).json({ error: "code is required" });
          return;
        }
        const campaignCode = await createCampaignCode(code, credits, maxRedemptions);
        res.status(200).json({ ok: true, action, campaignCode });
        return;
      }

      res.status(400).json({ error: `Unknown action: ${action}` });
    } catch (err) {
      functions.logger.error("demoAdmin error", { action, err });
      res.status(500).json({ error: String(err) });
    }
  });

// ─── Waitlist signup (website form) ──────────────────────────────────────────

const WAITLIST_ALLOWED_ORIGINS = new Set([
  "https://textcupid.app",
  "https://heycupid.app",
  "https://cupid-dating-mvp.web.app",
  "http://localhost:5190",
  "http://localhost:5180",
]);

export const waitlistSignup = functions
  .runWith({ timeoutSeconds: 15, memory: "256MB", secrets: ["PHONE_ENCRYPTION_KEY"] })
  .https.onRequest(async (req, res) => {
    const origin = req.header("Origin") ?? "";
    if (WAITLIST_ALLOWED_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    const { addToWaitlist } = await import("./services/waitlist");
    const phone = String(req.body?.phone ?? "");
    const city = req.body?.city ? String(req.body.city) : undefined;

    // Client IP for rate limiting: the FIRST X-Forwarded-For entry is
    // client-controllable (trivial limit bypass). Google's load balancer
    // appends the true client IP as the second-to-last entry — use that.
    const xff = (req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = (xff.length >= 2 ? xff[xff.length - 2] : xff[0]) || req.ip || "unknown";

    const result = await addToWaitlist(phone, ip, city);
    res.status(result.ok ? 200 : 400).json(result);
  });

// ─── Scheduled: date-runner (reminders + room opening) ──────────────────────

export const scheduledDateRunner = functions
  .runWith({ timeoutSeconds: 300, memory: "512MB", secrets: ALL_SECRETS })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const { runScheduledDates } = await import("./scheduler/jobs");
    const summary = await runScheduledDates();
    if (summary.remindersSent || summary.roomsOpened) {
      functions.logger.info("Scheduled dates processed", summary);
    }
  });

// ─── Scheduled: friend-mode check-ins (daily 6pm CT) ────────────────────────

export const friendCheckins = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB", secrets: ALL_SECRETS })
  .pubsub.schedule("every day 18:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    const { runFriendCheckins } = await import("./scheduler/friendCheckins");
    const sent = await runFriendCheckins();
    functions.logger.info("Friend check-ins complete", { sent });
  });

// ─── Calendar invite (ICS download for scheduled dates) ─────────────────────

export const calendarInvite = functions
  .runWith({ timeoutSeconds: 15, memory: "256MB", secrets: ["PHONE_ENCRYPTION_KEY"] })
  .https.onRequest(async (req, res) => {
    const matchId = String(req.query.match ?? "");
    const userPrefix = String(req.query.u ?? "");
    if (!/^[A-Za-z0-9]{6,40}$/.test(matchId) || !/^[a-f0-9]{8,64}$/.test(userPrefix)) {
      res.status(400).send("Bad request");
      return;
    }
    try {
      const adminFs = await import("firebase-admin/firestore");
      const db = adminFs.getFirestore();
      const userSnap = await db
        .collection("users")
        .where(adminFs.FieldPath.documentId(), ">=", userPrefix)
        .where(adminFs.FieldPath.documentId(), "<", userPrefix + "\uf8ff")
        .limit(1)
        .get();
      if (userSnap.empty) {
        res.status(404).send("Not found");
        return;
      }
      const matchSnap = await db
        .collection("users").doc(userSnap.docs[0].id)
        .collection("matches").doc(matchId).get();
      const m = matchSnap.data();
      if (!m?.scheduledAt) {
        res.status(404).send("Not found");
        return;
      }
      const { buildIcs } = await import("./services/scheduling");
      const ics = buildIcs(matchId, m.scheduledAt.toDate(), m.videoRoomUrl);
      res.set("Content-Type", "text/calendar; charset=utf-8");
      res.set("Content-Disposition", "attachment; filename=cupid-date.ics");
      res.status(200).send(ics);
    } catch (err) {
      functions.logger.error("calendarInvite error", err);
      res.status(500).send("Error");
    }
  });
