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
import { UserProfile } from "../models/user";

// ─── Main SMS webhook handler ─────────────────────────────────────────────────

export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  // Twilio sends form-encoded body
  const from: string = req.body?.From ?? "";
  const body: string = (req.body?.Body ?? "").trim();

  if (!from || !body) {
    res.status(400).send("Missing From or Body");
    return;
  }

  functions.logger.info("Inbound SMS", { from: maskPhone(from), bodyLength: body.length });

  try {
    // 1. Get or create user
    const { profile, isNew } = await getOrCreateUser(from);
    const phoneHash = profile.phoneHash;

    // 2. Check if this message is a response to an active match proposal
    const activeMatch = await getActiveMatchForUser(phoneHash);

    if (activeMatch && ["proposed", "mutual_interest", "video_expired"].includes(activeMatch.status)) {
      await handleMatchResponse(from, body, profile, activeMatch.id!, activeMatch);
      res.status(200).send("<Response/>");
      return;
    }

    // 3. Regular conversation turn
    await handleConversationTurn(from, body, profile, isNew);
    res.status(200).send("<Response/>");
  } catch (err) {
    functions.logger.error("SMS handler error", err);
    await sendSms(from, "Something went sideways on my end. Try again in a moment?");
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

  // Save user turn
  await appendConversationTurn(phoneHash, {
    role: "user",
    content: userMessage,
    timestamp: Timestamp.now(),
  });

  // Generate Claude reply
  const result = await generateConversationReply(
    userMessage,
    history,
    profile,
    profile.onboardingStage
  );

  // Save assistant turn
  await appendConversationTurn(phoneHash, {
    role: "assistant",
    content: result.message,
    timestamp: Timestamp.now(),
  });

  // Merge profile updates if any
  if (result.profileUpdates) {
    const profileUpdates = mergeProfileUpdates(profile, result.profileUpdates);
    if (Object.keys(profileUpdates).length > 0) {
      await updateUser(phoneHash, profileUpdates);
    }
  }

  // Send reply via SMS
  await sendSms(phone, result.message);
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
    // User is responding to initial match proposal
    if (intent === "yes") {
      await updateMatchRecord(phoneHash, matchId, {
        userAccepted: true,
        status: "user_accepted",
      });

      // Check if the other user has also accepted
      const otherHash = matchRecord.matchedUserId;
      const otherMatchSnap = await getOtherSideMatch(otherHash, phoneHash);

      if (otherMatchSnap?.userAccepted === true) {
        // Mutual interest! Create video room.
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
      // Ambiguous — ask again
      await sendSms(
        phone,
        "Just to be clear — are you interested in meeting this person? A simple yes or no works!"
      );
    }
  } else if (matchRecord.status === "video_expired") {
    // User is responding to post-call follow-up (contact exchange request)
    if (intent === "yes") {
      await updateMatchRecord(phoneHash, matchId, {
        contactExchanged: true,
        status: "contact_shared",
      });

      // Check if other user also wants to exchange
      const otherHash = matchRecord.matchedUserId;
      const otherMatchSnap = await getOtherSideMatch(otherHash, phoneHash);

      if (otherMatchSnap?.contactExchanged === true) {
        // Both consented — share contact info (actual phone numbers)
        // In production, we'd look up phone numbers from a secure mapping
        await sendContactExchangeMessage(
          phone,
          "your match",
          "Contact info shared via separate message"
        );
      } else {
        await sendSms(
          phone,
          "Got it! Waiting to hear back from them. I'll let you know."
        );
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

  // Update both match records
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

  // Send video link to this user (the other will receive it from their match handler)
  await sendVideoRoomLink(phone, room.url, "your match");
}

// In a real implementation we'd look this up from the match record
async function getOtherSideMatch(
  otherHash: string,
  thisHash: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { getActiveMatchForUser } = await import("../services/firestore");
  const match = await getActiveMatchForUser(otherHash);
  if (!match) return null;
  if (match.matchedUserId !== thisHash) return null;
  return match;
}

function maskPhone(phone: string): string {
  return phone.slice(0, 5) + "****" + phone.slice(-2);
}
