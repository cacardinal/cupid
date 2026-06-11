import * as crypto from "crypto";
import * as functions from "firebase-functions";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { normalizePhone, hashPhone, encryptPhone } from "./firestore";

/**
 * Waitlist signup: stores a phone number from the website form.
 * Same privacy posture as user profiles — doc ID is the SHA-256 hash,
 * the number itself is AES-256-GCM encrypted, never plaintext.
 *
 * Abuse controls:
 *  - strict E.164 US validation before anything is written
 *  - per-IP rate limit (5 signups / hour) via a Firestore counter
 *  - idempotent: re-submitting the same number just updates the timestamp
 */

const WAITLIST_COL = "waitlist";
const RATELIMIT_COL = "waitlist_ratelimit";
const MAX_PER_IP_PER_HOUR = 5;

const US_E164 = /^\+1[2-9]\d{9}$/;

export interface WaitlistResult {
  ok: boolean;
  error?: string;
}

export async function addToWaitlist(
  rawPhone: string,
  clientIp: string,
  city?: string
): Promise<WaitlistResult> {
  const phone = normalizePhone(String(rawPhone ?? "").slice(0, 32));
  if (!US_E164.test(phone)) {
    return { ok: false, error: "Enter a valid US mobile number." };
  }

  if (!(await allowIp(clientIp))) {
    return { ok: false, error: "Too many signups from this connection. Try again later." };
  }

  const phoneHash = hashPhone(phone);
  const db = getFirestore();

  await db
    .collection(WAITLIST_COL)
    .doc(phoneHash)
    .set(
      {
        phoneHash,
        encryptedPhone: encryptPhone(phone),
        city: typeof city === "string" ? city.replace(/[<>"'`&]/g, "").trim().slice(0, 80) || null : null,
        source: "website",
        notified: false,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );

  functions.logger.info("Waitlist signup", { phoneHash: phoneHash.slice(0, 12) });
  return { ok: true };
}

/** Sliding-hour rate limit per client IP (hashed — we don't store raw IPs). */
async function allowIp(clientIp: string): Promise<boolean> {
  const ipHash = crypto.createHash("sha256").update(`wl:${clientIp}`).digest("hex").slice(0, 32);
  const ref = getFirestore().collection(RATELIMIT_COL).doc(ipHash);
  const hourBucket = Math.floor(Date.now() / 3_600_000);

  try {
    const allowed = await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as { bucket: number; count: number }) : null;
      if (data && data.bucket === hourBucket && data.count >= MAX_PER_IP_PER_HOUR) {
        return false;
      }
      if (data && data.bucket === hourBucket) {
        tx.update(ref, { count: FieldValue.increment(1) });
      } else {
        tx.set(ref, { bucket: hourBucket, count: 1 });
      }
      return true;
    });
    return allowed;
  } catch (err) {
    functions.logger.error("Rate limit transaction failed (allowing)", err);
    return true; // fail-open: a broken limiter shouldn't block real signups
  }
}
