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
import { track } from "../services/analytics"; // analytics: all calls below are `void track(...)` fire-and-forget

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
    void track("message_received", phoneHash, { isNew, stage: profile.onboardingStage }); // analytics

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
          void track("referral_redeemed", phoneHash, { referrer: referrerHash.slice(0, 8) }); // analytics
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

    // ── BEGIN sharing/wingman routing (sharing branch) ────────────────────────
    // Consent-first growth loop: blurb / vCard / wingman replies go to the
    // sender only. See services/sharing.ts. Keep this block self-contained.
    {
      const { handleSharingIntent } = await import("../services/sharing");
      if (await handleSharingIntent(from, body, profile)) {
        res.status(200).send("<Response/>");
        return;
      }
    }
    // ── END sharing/wingman routing ───────────────────────────────────────────

    // ── Active match response ──────────────────────────────────────────────────

    const activeMatch = await getActiveMatchForUser(phoneHash);

    if (activeMatch && ["proposed", "mutual_interest", "video_expired", "scheduling"].includes(activeMatch.status)) {
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
    void track("onboarding_completed", phoneHash); // analytics
    replyText +=
      "\n\nPS: Text me \"ready now\" anytime you want to connect with someone instantly. I'll find a match in real time 🔥";
  }

  await sendSms(phone, replyText);

  // ── Narrative memory refresh (fire-and-forget, AFTER send: zero user latency) ──
  void import("../services/narrative")
    .then(({ maybeUpdateNarrative }) => maybeUpdateNarrative(phoneHash, profile, history))
    .catch((err) => functions.logger.error("Narrative dispatch failed", err));
  // ── End narrative memory refresh ──────────────────────────────────────────────

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

  if (matchRecord.status === "scheduling") {
    await handleSchedulingReply(phone, userMessage, phoneHash, matchId, matchRecord);
    return;
  }

  const intent = await detectIntent(userMessage);

  if (matchRecord.status === "proposed") {
    if (intent === "yes") {
      await updateMatchRecord(phoneHash, matchId, {
        userAccepted: true,
        status: "user_accepted",
      });
      void track("match_accepted", phoneHash, { matchId }); // analytics

      const otherHash = matchRecord.matchedUserId;
      const otherMatchSnap = await getOtherSideMatch(otherHash, phoneHash);

      if (otherMatchSnap?.userAccepted === true) {
        await startScheduling(phone, phoneHash, matchId, otherHash, otherMatchSnap.id!);
      } else {
        await sendSms(
          phone,
          "Love the enthusiasm! I'll reach out to them too. I'll let you know as soon as I hear back 🤞"
        );
      }
    } else if (intent === "no") {
      await updateMatchStatus(phoneHash, matchId, "user_declined");
      void track("match_declined", phoneHash, { matchId }); // analytics
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
        void track("contact_exchanged", phoneHash, { matchId }); // analytics
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

/** Both accepted: propose evening time slots to both users (status -> scheduling). */
async function startScheduling(
  phone: string,
  phoneHash: string,
  matchId: string,
  otherHash: string,
  otherMatchId: string
): Promise<void> {
  const { proposeSlots, slotsMessage, toTimestamp } = await import("../services/scheduling");
  const slots = proposeSlots();
  const slotTs = slots.map(toTimestamp);

  await Promise.all([
    updateMatchRecord(phoneHash, matchId, { status: "scheduling", proposedSlots: slotTs }),
    updateMatchRecord(otherHash, otherMatchId, { status: "scheduling", proposedSlots: slotTs }),
  ]);

  const { getPhoneByHash } = await import("../services/firestore");
  const otherPhone = await getPhoneByHash(otherHash);
  const msg = slotsMessage(slots);
  await Promise.all([
    sendSms(phone, msg),
    otherPhone ? sendSms(otherPhone, msg) : Promise.resolve(),
  ]);
}

/** Handle a reply while the pair is picking a time. */
async function handleSchedulingReply(
  phone: string,
  userMessage: string,
  phoneHash: string,
  matchId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  matchRecord: any
): Promise<void> {
  const { parseSlotReply, proposeSlots, slotsMessage, toTimestamp, formatSlotCT, scheduledConfirmationMessage } =
    await import("../services/scheduling");
  const { getPhoneByHash, getMatchBetween } = await import("../services/firestore");
  const { detectYesNoIntent } = await import("../services/intentDetector");

  const otherHash = matchRecord.matchedUserId;
  const other = await getMatchBetween(otherHash, phoneHash);
  const otherPhone = await getPhoneByHash(otherHash);

  // Someone already suggested a time and THIS user is confirming it
  if (matchRecord.slotPickedBy && matchRecord.slotPickedBy !== phoneHash && matchRecord.scheduledAt) {
    const yn = detectYesNoIntent(userMessage);
    if (yn === "yes") {
      await Promise.all([
        updateMatchRecord(phoneHash, matchId, { status: "scheduled" }),
        other ? updateMatchRecord(otherHash, other.id!, { status: "scheduled" }) : null,
      ]);
      void track("date_scheduled", phoneHash, { matchId }); // analytics
      const when = matchRecord.scheduledAt.toDate();
      await Promise.all([
        sendSms(phone, scheduledConfirmationMessage(when, matchId, phoneHash)),
        otherPhone && other
          ? sendSms(otherPhone, scheduledConfirmationMessage(when, other.id!, otherHash))
          : Promise.resolve(),
      ]);
      return;
    }
    if (yn === "no") {
      // Decliner picks instead: fresh slots to both, decliner is now the picker
      const slots = proposeSlots();
      const slotTs = slots.map(toTimestamp);
      await Promise.all([
        updateMatchRecord(phoneHash, matchId, { proposedSlots: slotTs, slotPickedBy: "" }),
        other ? updateMatchRecord(otherHash, other.id!, { proposedSlots: slotTs, slotPickedBy: "" }) : null,
      ]);
      await sendSms(phone, "No problem — pick one that works for you:\n\n" + slotsMessage(slots));
      if (otherPhone) await sendSms(otherPhone, "That time didn't work for them — finding another. Hang tight!");
      return;
    }
    await sendSms(phone, `Does ${formatSlotCT(matchRecord.scheduledAt.toDate())} work for you? A simple yes or no does it.`);
    return;
  }

  // This user is picking from the proposed slots
  const slots: Date[] = (matchRecord.proposedSlots ?? []).map((t: { toDate: () => Date }) => t.toDate());
  const choice = parseSlotReply(userMessage, slots.length || 3);

  if (choice === "none") {
    const fresh = proposeSlots(new Date(Date.now() + 86_400_000));
    const slotTs = fresh.map(toTimestamp);
    await Promise.all([
      updateMatchRecord(phoneHash, matchId, { proposedSlots: slotTs }),
      other ? updateMatchRecord(otherHash, other.id!, { proposedSlots: slotTs }) : null,
    ]);
    await sendSms(phone, "All good — how about these instead?\n\n" + slotsMessage(fresh));
    return;
  }

  if (choice === null || !slots[choice]) {
    await sendSms(phone, "Just reply 1, 2, or 3 to pick a time — or \"none\" if they don't work.");
    return;
  }

  const picked = slots[choice];
  const pickedTs = toTimestamp(picked);
  await Promise.all([
    updateMatchRecord(phoneHash, matchId, { scheduledAt: pickedTs, slotPickedBy: phoneHash }),
    other ? updateMatchRecord(otherHash, other.id!, { scheduledAt: pickedTs, slotPickedBy: phoneHash }) : null,
  ]);
  await sendSms(phone, `${formatSlotCT(picked)} — nice choice. Checking with your match now 🤞`);
  if (otherPhone) {
    await sendSms(otherPhone, `Your match suggested ${formatSlotCT(picked)} for your video date. Does that work? (yes/no)`);
  }
}

// (legacy instant-room helper retained for the live flow path)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    return "I'm Cupid. Keep texting and I'll figure out the rest. No setup, no forms.";
  }
  return (
    'Text me anytime to chat or update what you want. Say "ready now" to look for someone right now, "cancel" to stop. Yes or no answers my match questions. Honest answers get you better dates.'
  );
}

function maskPhone(phone: string): string {
  return phone.slice(0, 5) + "****" + phone.slice(-2);
}
