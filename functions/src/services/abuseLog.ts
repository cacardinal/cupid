import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { AbuseEvent } from "../models/abuse";

/**
 * Abuse-event emitter.
 *
 * Design rules (mirror services/analytics.ts):
 * - Fire-and-forget: NEVER throws, NEVER rejects. Call as `void logAbuseEvent(...)`.
 * - No-op when DEMO_MODE === "true" so sim/demo runs accrue zero records and
 *   spend zero compute (short-circuits before any hashing at the call site too).
 * - phoneHash only, never a raw phone. evidence is a fixed-label string with no
 *   PII; clamped to 140 chars as a backstop (the guarantee is the call site).
 * - Never logs the payload (no body, no URL, no full hash).
 */

const ABUSE_EVENTS_COL = "abuse_events";
const EVIDENCE_MAX = 140;

const db = () => admin.firestore();

/**
 * Sentinel phoneHash for signals that are NOT attributable to a specific user
 * (e.g. outbound allowlist scrubs of model-generated text, admin auth failures).
 * Using a fixed non-user value keeps these out of per-user triage clustering.
 */
export const SYSTEM_ACTOR = "system";

export async function logAbuseEvent(
  event: Omit<AbuseEvent, "id" | "createdAt">
): Promise<void> {
  try {
    if (process.env.DEMO_MODE === "true") return Promise.resolve();

    const evidence =
      event.evidence.length > EVIDENCE_MAX
        ? event.evidence.slice(0, EVIDENCE_MAX)
        : event.evidence;

    return db()
      .collection(ABUSE_EVENTS_COL)
      .add({
        phoneHash: event.phoneHash,
        type: event.type,
        severity: event.severity,
        evidence,
        source: event.source,
        createdAt: Timestamp.now(),
      })
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    // Abuse logging must never break the product.
    return Promise.resolve();
  }
}
