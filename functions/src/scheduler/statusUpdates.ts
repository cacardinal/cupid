/**
 * Proactive status SMS scheduler.
 *
 * Sends friendly "market update" messages from a friend POV — not system
 * notifications. Two types run daily at 10am CT:
 *
 *   1. thin_market — city has <5 active users; new user has waited >48h with
 *      no match. Max 1 per 7 days per user.
 *
 *   2. still_searching — user has been onboarded >7 days with no match yet.
 *      Max 1 per 14 days per user.
 *
 * All messages written in Cupid's voice: direct, warm, no corpo-speak.
 */

import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";
import { getAllActiveUsers, getPhoneByHash, getUsersWithoutRecentMatch } from "../services/firestore";
import { sendSms } from "../services/twilio";

const db = () => admin.firestore();
const STATUS_MESSAGES_COL = "status_messages";

type MessageType = "thin_market" | "still_searching";

/** Returns the timestamp of the most recent status message of a given type, or 0. */
async function lastMessageTimestamp(phoneHash: string, type: MessageType): Promise<number> {
  const snap = await db()
    .collection(STATUS_MESSAGES_COL)
    .where("phoneHash", "==", phoneHash)
    .where("type", "==", type)
    .orderBy("sentAt", "desc")
    .limit(1)
    .get();
  if (snap.empty) return 0;
  return snap.docs[0].data().sentAt.toMillis();
}

async function recordMessage(phoneHash: string, type: MessageType): Promise<void> {
  await db().collection(STATUS_MESSAGES_COL).add({
    phoneHash,
    type,
    sentAt: Timestamp.now(),
  });
}

// ─── Thin-market check ────────────────────────────────────────────────────────

/**
 * For cities with fewer than 5 active users, warn users who have been
 * waiting >48h without a match. Prevents the "ghosted by the app" feeling.
 */
export async function sendThinMarketUpdates(): Promise<number> {
  const users = await getAllActiveUsers();
  const now = Date.now();
  const FORTY_EIGHT_H = 48 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // Group onboarded users by city
  const byCity = new Map<string, UserProfile[]>();
  for (const u of users) {
    if (!u.onboardingComplete) continue;
    const city = (u.demographics?.city ?? "unknown").toLowerCase().trim();
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city)!.push(u);
  }

  let sent = 0;

  for (const [city, cityUsers] of byCity.entries()) {
    if (city === "unknown") continue;
    if (cityUsers.length >= 5) continue; // not thin

    for (const user of cityUsers) {
      if (user.totalMatches > 0) continue; // already had a match
      const waitSince = user.updatedAt?.toMillis() ?? user.createdAt.toMillis();
      if (now - waitSince < FORTY_EIGHT_H) continue; // hasn't waited long enough

      const lastSent = await lastMessageTimestamp(user.phoneHash, "thin_market");
      if (now - lastSent < SEVEN_DAYS) continue; // too soon to send again

      const phone = await getPhoneByHash(user.phoneHash);
      if (!phone) continue;

      const msg = pickThinMarketMessage(city);
      await sendSms(phone, msg);
      await recordMessage(user.phoneHash, "thin_market");
      functions.logger.info("Thin-market update sent", { city, user: user.phoneHash.slice(0, 8) });
      sent++;
    }
  }

  return sent;
}

// ─── Still-searching check ────────────────────────────────────────────────────

/**
 * For users who have been onboarded >7 days with no match, send a warm
 * "I haven't forgotten about you" message. Max 1 per 14 days.
 */
export async function sendStillSearchingUpdates(): Promise<number> {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const users = await getUsersWithoutRecentMatch(168); // 7 days
  let sent = 0;

  for (const user of users) {
    if (!user.onboardingComplete) continue;
    if (now - user.createdAt.toMillis() < SEVEN_DAYS) continue; // too new

    const lastSent = await lastMessageTimestamp(user.phoneHash, "still_searching");
    if (now - lastSent < FOURTEEN_DAYS) continue;

    const phone = await getPhoneByHash(user.phoneHash);
    if (!phone) continue;

    await sendSms(phone, pickStillSearchingMessage());
    await recordMessage(user.phoneHash, "still_searching");
    functions.logger.info("Still-searching update sent", { user: user.phoneHash.slice(0, 8) });
    sent++;
  }

  return sent;
}

// ─── Message copy ─────────────────────────────────────────────────────────────

function toTitleCase(str: string): string {
  return str.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function pickThinMarketMessage(city: string): string {
  const c = toTitleCase(city);
  const options = [
    `Hey — quick update. ${c} is still early for us, so matches are taking longer than usual. I haven't forgotten about you — just being patient to find the right fit.`,
    `Just checking in. The pool in ${c} is small right now, so I'm being careful rather than fast. No match yet, but I'd rather wait for a good one than send you someone who's just available.`,
    `Update from Cupid: we're still pretty new in ${c}. I'm working on it and being selective. Worth the patience, I promise.`,
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function pickStillSearchingMessage(): string {
  const options = [
    "Still here, still looking. I think about your preferences more than you'd guess. The right intro takes time — I'll reach out the moment I find someone worth your time.",
    "No match yet, but not from lack of trying. I'm being picky on your behalf. Worth the patience.",
    "Just checking in. Nothing to report yet — but I remember everything you told me and I'm keeping an eye out. Good things take a minute.",
  ];
  return options[Math.floor(Math.random() * options.length)];
}
