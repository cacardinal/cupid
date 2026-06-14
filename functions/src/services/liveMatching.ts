import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import { UserProfile, LiveStatus } from "../models/user";
import { computeCompatibility } from "../scheduler/matchingJob";
import {
  getUser,
  updateUser,
  createMatchRecord,
  getActiveMatchForUser,
  getLiveWaitingUsers,
  getPhoneByHash,
} from "./firestore";
import { createAnonymousRoom } from "./daily";
import { sendSms } from "./twilio";
import { generateVoicedMessage } from "./claude";

// ─── Constants ─────────────────────────────────────────────────────────────────

const LIVE_WINDOW_MINUTES = 30;
const LIVE_ROOM_EXPIRY_MINUTES = 10; // Shorter window = more urgency, less ghosting
const LIVE_MATCH_MIN_SCORE = 45;     // Slightly lower threshold than async (urgency tradeoff)

// ─── Set user as live/waiting ──────────────────────────────────────────────────

export async function setUserLive(
  phoneHash: string,
  phone: string
): Promise<void> {
  const sessionId = uuidv4();
  const expiresAt = Timestamp.fromMillis(
    Date.now() + LIVE_WINDOW_MINUTES * 60 * 1000
  );

  await updateUser(phoneHash, {
    liveStatus: "waiting" as LiveStatus,
    liveStatusUntil: expiresAt,
    liveSessionId: sessionId,
  });

  const profile = await getUser(phoneHash);
  const msg = profile
    ? await generateVoicedMessage(
        profile,
        "They just told you they are ready to meet someone right now, tonight, in person or on video. They are excited and a little bold. Match their energy and let them know you are already on the hunt for the right person for them this very moment. Confident wingman energy.",
        "Love it. Let me see who's around right now 💘"
      )
    : "Love it. Let me see who's around right now 💘";
  await sendSms(phone, msg);

  functions.logger.info("User went live", { phoneHash, sessionId });
}

// ─── Set user offline ─────────────────────────────────────────────────────────

export async function setUserOffline(
  phoneHash: string,
  phone?: string,
  reason: "expired" | "matched" | "user_cancel" = "expired"
): Promise<void> {
  await updateUser(phoneHash, {
    liveStatus: "offline" as LiveStatus,
    liveStatusUntil: undefined,
    liveSessionId: undefined,
  });

  if (phone && reason === "expired") {
    await sendSms(
      phone,
      "No one compatible was live right now — but I'm always working behind the scenes on matches. I'll reach out when someone great comes along! 💛"
    );
  }

  functions.logger.info("User went offline", { phoneHash, reason });
}

// ─── Scan for a compatible live match ────────────────────────────────────────

export async function scanForLiveMatch(
  newUser: UserProfile
): Promise<{ matched: boolean; matchProfile?: UserProfile; matchId?: string }> {
  if (newUser.liveStatus !== "waiting") {
    return { matched: false };
  }

  // Get all other users currently waiting in the same city
  const city = newUser.demographics.city?.toLowerCase().trim();
  if (!city) {
    functions.logger.warn("Live user has no city set", { hash: newUser.phoneHash });
    return { matched: false };
  }

  const waitingUsers = await getLiveWaitingUsers(city, newUser.phoneHash);
  functions.logger.info("Live scan", {
    phoneHash: newUser.phoneHash,
    city,
    candidates: waitingUsers.length,
  });

  if (waitingUsers.length === 0) {
    return { matched: false };
  }

  // Score each candidate, pick the best compatible match
  let bestScore = LIVE_MATCH_MIN_SCORE - 1;
  let bestCandidate: UserProfile | null = null;

  for (const candidate of waitingUsers) {
    // Skip if either user already has an active match in progress
    const [existingA, existingB] = await Promise.all([
      getActiveMatchForUser(newUser.phoneHash),
      getActiveMatchForUser(candidate.phoneHash),
    ]);
    if (existingA || existingB) continue;

    const result = computeCompatibility(newUser, candidate);
    if (result.passed && result.score > bestScore) {
      bestScore = result.score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return { matched: false };
  }

  // Lock in the match — connect them instantly
  const matchId = await connectLivePair(newUser, bestCandidate, bestScore);
  return { matched: true, matchProfile: bestCandidate, matchId };
}

// ─── Instantly connect two live users ────────────────────────────────────────

async function connectLivePair(
  userA: UserProfile,
  userB: UserProfile,
  score: number
): Promise<string> {
  functions.logger.info("Connecting live pair", {
    hashA: userA.phoneHash,
    hashB: userB.phoneHash,
    score,
  });

  // Create a short-window Daily.co room
  const room = await createAnonymousRoom(
    `live-${userA.phoneHash.slice(0, 8)}-${userB.phoneHash.slice(0, 8)}`,
    LIVE_ROOM_EXPIRY_MINUTES
  );
  const expiryTimestamp = Timestamp.fromMillis(room.expiresAt * 1000);
  const now = Timestamp.now();

  // Create match records for both sides
  const [matchIdA] = await Promise.all([
    createMatchRecord({
      userId: userA.phoneHash,
      matchedUserId: userB.phoneHash,
      status: "live_connecting",
      compatibilityScore: score,
      proposedAt: now,
      updatedAt: now,
      videoRoomUrl: room.url,
      videoRoomExpiry: expiryTimestamp,
    }),
    createMatchRecord({
      userId: userB.phoneHash,
      matchedUserId: userA.phoneHash,
      status: "live_connecting",
      compatibilityScore: score,
      proposedAt: now,
      updatedAt: now,
      videoRoomUrl: room.url,
      videoRoomExpiry: expiryTimestamp,
    }),
  ]);

  // Update both users to "connecting" and clear live session
  await Promise.all([
    updateUser(userA.phoneHash, {
      liveStatus: "connecting" as LiveStatus,
      liveSessionId: undefined,
    }),
    updateUser(userB.phoneHash, {
      liveStatus: "connecting" as LiveStatus,
      liveSessionId: undefined,
    }),
  ]);

  // Look up E.164 phones from encrypted mapping — send simultaneous SMS
  const [phoneA, phoneB] = await Promise.all([
    getPhoneByHash(userA.phoneHash),
    getPhoneByHash(userB.phoneHash),
  ]);

  functions.logger.info("Live match created — sending video links", {
    roomUrl: room.url,
    expiresInMinutes: LIVE_ROOM_EXPIRY_MINUTES,
    matchIdA,
    hasPhoneA: !!phoneA,
    hasPhoneB: !!phoneB,
  });

  await Promise.all([
    phoneA ? sendInstantMatchSms(phoneA, room.url) : Promise.resolve(),
    phoneB ? sendInstantMatchSms(phoneB, room.url) : Promise.resolve(),
  ]);

  if (!phoneA || !phoneB) {
    functions.logger.warn("Phone mapping missing for one or both live match users", {
      missingA: !phoneA,
      missingB: !phoneB,
    });
  }

  return matchIdA;
}

// ─── SMS for instant live connection ─────────────────────────────────────────

export async function sendInstantMatchSms(phone: string, roomUrl: string): Promise<void> {
  const message =
    `⚡ Match found! I found someone great who's available right now.\n\n` +
    `Jump in — your private video chat is ready:\n${roomUrl}\n\n` +
    `This link expires in ${LIVE_ROOM_EXPIRY_MINUTES} minutes. Go!`;

  await sendSms(phone, message);
}

// ─── Expire stale live-waiting users ─────────────────────────────────────────

export async function expireLiveWaitingUsers(): Promise<number> {
  // Query users who are still "waiting" but their window has expired
  // getLiveWaitingUsers with no city filter returns all waiting users
  // The expiry check is done per-user below
  const now = Date.now();
  let expiredCount = 0;

  // We can't easily query "waiting AND expired" in Firestore without a composite index
  // on (liveStatus, liveStatusUntil) — so we use the scheduled job which calls this.
  // For MVP: fetch all waiting users, check expiry client-side.
  const { getAllLiveWaitingUsers } = await import("./firestore");
  const waitingUsers = await getAllLiveWaitingUsers();

  for (const user of waitingUsers) {
    if (!user.liveStatusUntil) continue;
    if (user.liveStatusUntil.toMillis() > now) continue;

    // Expired — set offline and notify
    await updateUser(user.phoneHash, {
      liveStatus: "offline" as LiveStatus,
      liveStatusUntil: undefined,
      liveSessionId: undefined,
    });

    functions.logger.info("Expired live-waiting user", { phoneHash: user.phoneHash });

    const phone = await getPhoneByHash(user.phoneHash);
    if (phone) {
      const msg = await generateVoicedMessage(
        user,
        "Their instant-match window just closed and nobody compatible happened to be around at the same moment. Let them down easy and with warmth, maybe a little humor. Make clear it is timing, not them, and the door is wide open to try again later. Do not make it sound like a system notification.",
        "No luck this round, nobody was around at the same time as you. It's timing, not you. We can try again whenever 💫"
      );
      await sendSms(phone, msg);
    }

    expiredCount++;
  }

  return expiredCount;
}
