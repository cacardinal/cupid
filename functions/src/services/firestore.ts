import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import {
  UserProfile,
  ConversationTurn,
  MatchRecord,
  MatchStatus,
  createDefaultProfile,
} from "../models/user";
import * as crypto from "crypto";

const db = () => admin.firestore();

const USERS_COL = "users";
const CONVERSATIONS_SUB = "conversations";
const MATCHES_SUB = "matches";

// ─── Phone hashing ────────────────────────────────────────────────────────────

export function hashPhone(e164Phone: string): string {
  return crypto.createHash("sha256").update(e164Phone.trim()).digest("hex");
}

export function normalizePhone(raw: string): string {
  // Remove all non-digits, then ensure E.164 format with +1 default for US
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ─── User CRUD ────────────────────────────────────────────────────────────────

export async function getUser(phoneHash: string): Promise<UserProfile | null> {
  const doc = await db().collection(USERS_COL).doc(phoneHash).get();
  if (!doc.exists) return null;
  return doc.data() as UserProfile;
}

export async function getOrCreateUser(phone: string): Promise<{ profile: UserProfile; isNew: boolean }> {
  const phoneHash = hashPhone(normalizePhone(phone));
  const existing = await getUser(phoneHash);
  if (existing) return { profile: existing, isNew: false };

  const profile = createDefaultProfile(phoneHash);
  await db().collection(USERS_COL).doc(phoneHash).set(profile);
  return { profile, isNew: true };
}

export async function updateUser(
  phoneHash: string,
  updates: Partial<UserProfile>
): Promise<void> {
  // Strip explicit `undefined` values — Firestore rejects them
  const sanitized = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined)
  );
  await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .update({
      ...sanitized,
      updatedAt: Timestamp.now(),
    });
}

export async function getAllActiveUsers(): Promise<UserProfile[]> {
  const snap = await db()
    .collection(USERS_COL)
    .where("active", "==", true)
    .where("onboardingComplete", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as UserProfile);
}

// ─── Conversation history ──────────────────────────────────────────────────────

export async function appendConversationTurn(
  phoneHash: string,
  turn: Omit<ConversationTurn, "id">
): Promise<void> {
  await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(CONVERSATIONS_SUB)
    .add(turn);
}

export async function getConversationHistory(
  phoneHash: string,
  limit = 40
): Promise<ConversationTurn[]> {
  const snap = await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(CONVERSATIONS_SUB)
    .orderBy("timestamp", "asc")
    .limitToLast(limit)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ConversationTurn));
}

// ─── Match records ────────────────────────────────────────────────────────────

export async function createMatchRecord(match: Omit<MatchRecord, "id">): Promise<string> {
  const ref = await db()
    .collection(USERS_COL)
    .doc(match.userId)
    .collection(MATCHES_SUB)
    .add(match);
  return ref.id;
}

export async function getMatchRecord(
  phoneHash: string,
  matchId: string
): Promise<MatchRecord | null> {
  const doc = await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(MATCHES_SUB)
    .doc(matchId)
    .get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as MatchRecord;
}

export async function updateMatchRecord(
  phoneHash: string,
  matchId: string,
  updates: Partial<MatchRecord>
): Promise<void> {
  await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(MATCHES_SUB)
    .doc(matchId)
    .update({ ...updates, updatedAt: Timestamp.now() });
}

export async function getActiveMatchForUser(phoneHash: string): Promise<MatchRecord | null> {
  const snap = await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(MATCHES_SUB)
    .where("status", "in", [
      "proposed",
      "user_accepted",
      "mutual_interest",
      "video_sent",
      "video_expired",
      "live_connecting",
    ])
    .orderBy("proposedAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() } as MatchRecord;
}

export async function getPendingMatchProposalsForUser(
  phoneHash: string
): Promise<MatchRecord[]> {
  const snap = await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .collection(MATCHES_SUB)
    .where("status", "==", "proposed")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as MatchRecord));
}

export async function updateMatchStatus(
  phoneHash: string,
  matchId: string,
  status: MatchStatus
): Promise<void> {
  await updateMatchRecord(phoneHash, matchId, { status });
}

// ─── Live mode queries ────────────────────────────────────────────────────────

/**
 * Get all users in "waiting" liveStatus within a given city,
 * excluding the requesting user and anyone whose window has expired.
 * Requires composite index: (liveStatus, active, onboardingComplete)
 */
export async function getLiveWaitingUsers(
  city: string,
  excludePhoneHash: string
): Promise<UserProfile[]> {
  const now = Timestamp.now();

  const snap = await db()
    .collection(USERS_COL)
    .where("liveStatus", "==", "waiting")
    .where("active", "==", true)
    .where("onboardingComplete", "==", true)
    .get();

  return snap.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => {
      if (u.phoneHash === excludePhoneHash) return false;
      // Same city (case-insensitive)
      const uCity = u.demographics.city?.toLowerCase().trim();
      if (!uCity || uCity !== city) return false;
      // Not expired
      if (u.liveStatusUntil && u.liveStatusUntil.toMillis() < now.toMillis()) return false;
      return true;
    });
}

/**
 * Get ALL users currently in "waiting" liveStatus (used for expiry sweep)
 */
export async function getAllLiveWaitingUsers(): Promise<UserProfile[]> {
  const snap = await db()
    .collection(USERS_COL)
    .where("liveStatus", "==", "waiting")
    .get();
  return snap.docs.map((d) => d.data() as UserProfile);
}

// ─── Batch helpers ────────────────────────────────────────────────────────────

export async function getUsersWithoutRecentMatch(
  cooldownHours = 24
): Promise<UserProfile[]> {
  const allActive = await getAllActiveUsers();

  return allActive.filter((u) => {
    if (!u.matchCooldownUntil) return true;
    return u.matchCooldownUntil.toMillis() < Date.now();
  });
}
