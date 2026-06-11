import * as functions from "firebase-functions";
import { Request, Response } from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import {
  getOrCreateUser,
  getConversationHistory,
  appendConversationTurn,
  updateUser,
  getActiveMatchForUser,
  updateMatchStatus,
  updateMatchRecord,
} from "../services/firestore";
import {
  generateConversationReply,
  detectIntent,
  mergeProfileUpdates,
} from "../services/claude";
import {
  sendSms,
  sendVideoRoomLink,
  sendContactExchangeMessage,
  sendDeclinedMessage,
} from "../services/twilio";
import { createAnonymousRoom } from "../services/daily";
import { detectLiveIntent, detectCancelLiveIntent, detectHelpIntent } from "../services/intentDetector";
import { setUserLive, setUserOffline } from "../services/liveMatching";
import { UserProfile } from "../models/user";
import { extractReferralCode, processReferral, buildShareMessage } from "../services/referral";

// ─── Main SMS webhook handler ─────────────────────────────────────────────────

export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  // Security gate: reject forged webhooks before reading anything else.
  const { verifyTwilioRequest, sanitizeInboundBody, hasMedia, MEDIA_DECLINED_MESSAGE } =
    await import("../services/inboundSecurity");

  if (!verifyTwilioRequest(req)) {
    res.status(403).send("Forbidden");
    return;
  }

  const from: string = req.body?.From ?? "";
  const body: string = sanitizeInboundBody(req.body?.Body ?? "");

  // MMS: never fetch user-supplied media; decline politely (text-only product).
  if (from && hasMedia(req.body)) {
    functions.logger.info("Inbound MMS declined", { from: maskPhone(from) });
    try {
      await sendSms(from, MEDIA_DECLINED_MESSAGE);
    } catch (e) {
      functions.logger.error("MMS decline reply failed", e);
    }
    res.status(200).send("<Response/>");
    return;
  }

  if (!from || !body) {
    res.status(400).send("Missing From or Body");
    return;
  }

  functions.logger.info("Inbound SMS", { from: maskPhone(from), bodyLength: body.length });

  try {
    const { profile: rawProfile, isNew } = await getOrCreateUser(from);
    let profile = rawProfile;
    const phoneHash = profile.phoneHash;

    // ── Referral detection (new users only) ──────────────────────────────────

    if (isNew) {
      const code = extractReferralCode(body);
      if (code) {
        const referrerHash = await processReferral(phoneHash, code);
        if (referrerHash) {
          // Award the new user a bonus credit and record who referred them
          await updateUser(phoneHash, {
            creditsRemaining: (profile.creditsRemaining ?? 1) + 1,
            referredBy: code,
          });
          // Refresh profile so downstream sees the updated credits
          profile = { ...profile, creditsRemaining: (profile.creditsRemaining ?? 1) + 1, referredBy: code };
          functions.logger.info("Referral applied", { newUser: phoneHash.slice(0, 8), referrer: referrerHash.slice(0, 8) });
        }
      }
    }

    // ── Live mode routing (onboarded users only) ──────────────────────────────

    if (profile.onboardingComplete) {
      // Cancel live session
      if (profile.liveStatus === "waiting" && detectCancelLiveIntent(body)) {
        await setUserOffline(phoneHash, from, "user_cancel");
        await sendSms(from, "Got it — I've stopped the live search. I'll still be working on matches in the background!");
        res.status(200).send("<Response/>");
        return;
      }

      // Go live
      if (profile.liveStatus === "offline" && detectLiveIntent(body)) {
        await setUserLive(phoneHash, from);
        res.status(200).send("<Response/>");
        return;
      }

      // Already waiting — acknowledge
      if (profile.liveStatus === "waiting" && detectLiveIntent(body)) {
        await sendSms(from, "You're already live! I'm actively searching. I'll text you the moment I find a match 🔍");
        res.status(200).send("<Response/>");
        return;
      }
    }

    // ── Help shortcut ─────────────────────────────────────────────────────────

    if (detectHelpIntent(body)) {
      const helpText = buildHelpMessage(profile.onboardingComplete);
      await sendSms(from, helpText);
      res.status(200).send("<Response/>");
      return;
    }

    // ── Active match response ──────────────────────────────────────────────────

    const activeMatch = await getActiveMatchForUser(phoneHash);

    if (activeMatch && ["proposed", "mutual_interest", "video_expired"].includes(activeMatch.status)) {
      await handleMatchResponse(from, body, profile, activeMatch.id!, activeMatch);
      res.status(200).send("<Response/>");
      return;
    }

    // ── Regular conversation turn ─────────────────────────────────────────────

    await handleConversationTurn(from, body, profile, isNew);
    res.status(200).send("<Response/>");
  } catch (err) {
    functions.logger.error("SMS handler error", err);
    try {
      await sendSms(from, "Something went sideways on my end. Try again in a moment?");
    } catch (smsErr) {
      // If the fallback SMS itself fails (e.g. Twilio auth), still return
      // 200/TwiML so Twilio doesn't retry-storm the webhook.
      functions.logger.error("Fallback SMS also failed", smsErr);
    }
    res.status(200).send("<Response/>");
  }
}

// ─── Conversation handler ─────────────────────────────────────────────────────

async function handleConversationTurn(
  phone: string,
  userMessage: string,
  profile: UserProfile,
  isNew: boolean
): Promise<void> {
  const phoneHash = profile.phoneHash;
  const history = await getConversationHistory(phoneHash);

  await appendConversationTurn(phoneHash, {
    role: "user",
    content: userMessage,
    timestamp: Timestamp.now(),
  });

  const result = await generateConversationReply(
    userMessage,
    history,
    profile,
    profile.onboardingStage
  );

  await appendConversationTurn(phoneHash, {
    role: "assistant",
    content: result.message,
    timestamp: Timestamp.now(),
  });

  if (result.profileUpdates) {
    const profileUpdates = mergeProfileUpdates(profile, result.profileUpdates);
    if (Object.keys(profileUpdates).length > 0) {
      await updateUser(phoneHash, profileUpdates);
    }
  }

  // If onboarding just completed, nudge toward live mode + send share invite
  const justCompleted = result.profileUpdates?.onboardingComplete && !profile.onboardingComplete;
  let replyText = result.message;
  if (justCompleted) {
    replyText +=
      "\n\nPS: Text me \"ready now\" anytime you want to connect with someone instantly. I'll find a match in real time 🔥";
  }

  await sendSms(phone, replyText);

  // Follow-up: share message (separate SMS so it reads as a beat after the greeting)
  if (justCompleted) {
    const cupidNumber = process.env.TWILIO_PHONE_NUMBER ?? "";
    if (cupidNumber) {
      await new Promise((r) => setTimeout(r, 2500));
      const shareMsg = buildShareMessage(profile.referralCode, cupidNumber);
      await sendSms(phone, shareMsg);
    }
  }
}

// ─── Match response handler ───────────────────────────────────────────────────

async function handleMatchResponse(
  phone: string,
  userMessage: string,
  profile: UserProfile,
  matchId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  matchRecord: any
): Promise<void> {
  const phoneHash = profile.phoneHash;
  const intent = await detectIntent(userMessage);

  if (matchRecord.status === "proposed") {
    if (intent === "yes") {
      await updateMatchRecord(phoneHash, matchId, {
        userAccepted: true,
        status: "user_accepted",
      });

      const otherHash = matchRecord.matchedUserId;
      const otherMatchSnap = await getOtherSideMatch(otherHash, phoneHash);

      if (otherMatchSnap?.userAccepted === true) {
        await createVideoRoom(phone, phoneHash, matchId, otherHash, otherMatchSnap.id!);
      } else {
        await sendSms(
          phone,
          "Love the enthusiasm! I'll reach out to them too. I'll let you know as soon as I hear back 🤞"
        );
      }
    } else if (intent === "no") {
      await updateMatchStatus(phoneHash, matchId, "user_declined");
      await sendSms(
        phone,
        "No problem at all! I'll keep an eye out for better fits. These things take time."
      );
    } else {
      await sendSms(
        phone,
        "Just to be clear — are you interested in meeting this person? A simple yes or no works!"
      );
    }
  } else if (matchRecord.status === "video_expired") {
    if (intent === "yes") {
      await updateMatchRecord(phoneHash, matchId, {
        contactExchanged: true,
        status: "contact_shared",
      });

      const otherHash = matchRecord.matchedUserId;
      const otherMatchSnap = await getOtherSideMatch(otherHash, phoneHash);

      if (otherMatchSnap?.contactExchanged === true) {
        await sendContactExchangeMessage(
          phone,
          "your match",
          "Contact info shared via separate message"
        );
      } else {
        await sendSms(phone, "Got it! Waiting to hear back from them. I'll let you know.");
      }
    } else if (intent === "no") {
      await updateMatchRecord(phoneHash, matchId, { status: "contact_declined" });
      await sendDeclinedMessage(phone);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createVideoRoom(
  phone: string,
  phoneHash: string,
  matchId: string,
  otherHash: string,
  otherMatchId: string
): Promise<void> {
  const room = await createAnonymousRoom(matchId);
  const expiryTimestamp = Timestamp.fromMillis(room.expiresAt * 1000);

  await updateMatchRecord(phoneHash, matchId, {
    status: "video_sent",
    videoRoomUrl: room.url,
    videoRoomExpiry: expiryTimestamp,
  });
  await updateMatchRecord(otherHash, otherMatchId, {
    status: "video_sent",
    videoRoomUrl: room.url,
    videoRoomExpiry: expiryTimestamp,
  });

  // Send the link to BOTH sides simultaneously — the other user accepted
  // earlier and is waiting to hear back.
  const { getPhoneByHash } = await import("../services/firestore");
  const otherPhone = await getPhoneByHash(otherHash);
  await Promise.all([
    sendVideoRoomLink(phone, room.url, "your match"),
    otherPhone ? sendVideoRoomLink(otherPhone, room.url, "your match") : Promise.resolve(),
  ]);
}

async function getOtherSideMatch(
  otherHash: string,
  thisHash: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  // Status-independent lookup: the other side may have already advanced to a
  // terminal status (contact_shared), which getActiveMatchForUser filters out.
  const { getMatchBetween } = await import("../services/firestore");
  return getMatchBetween(otherHash, thisHash);
}

function buildHelpMessage(onboarded: boolean): string {
  if (!onboarded) {
    return "I'm Cupid, your AI matchmaker 💘 Just keep chatting — I'll ask you everything I need to find you a great match. There's nothing to configure.";
  }
  return (
    "Here's what I can do:\n\n" +
    "• Text me anytime to chat and update your preferences\n" +
    '• Text "ready now" to go live — I\'ll find someone compatible in real time ⚡\n' +
    '• Text "cancel" while live to stop the search\n' +
    "• Reply yes/no to match proposals\n" +
    "• After a video call, reply yes/no to exchange contact info\n\n" +
    "I work best when you're honest with me 💛"
  );
}

function maskPhone(phone: string): string {
  return phone.slice(0, 5) + "****" + phone.slice(-2);
}
