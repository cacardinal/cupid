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

// ─── Phone hashing ───────────────────────────────────────────────────────────

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
  await db()
    .collection(USERS_COL)
    .doc(phoneHash)
    .update({
      ...updates,
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

// ─── Conversation history ─────────────────────────────────────────────────────

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

// ─── Batch helpers ────────────────────────────────────────────────────────────

export async function getUsersWithoutRecentMatch(
  cooldownHours = 24
): Promise<UserProfile[]> {
  const cutoff = Timestamp.fromMillis(Date.now() - cooldownHours * 60 * 60 * 1000);
  const allActive = await getAllActiveUsers();

  return allActive.filter((u) => {
    if (!u.matchCooldownUntil) return true;
    return u.matchCooldownUntil.toMillis() < Date.now();
  });
}
