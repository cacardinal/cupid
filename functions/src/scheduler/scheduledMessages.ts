import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { ProactiveKind, UserProfile } from "../models/user";

// ─── Scheduled-message queue ──────────────────────────────────────────────────
//
// Top-level `scheduled_messages` collection. Written ONLY by the engagement
// review (enqueueScheduledMessage), drained ONLY by drainScheduledMessages.
// No client access ever (firestore.rules: allow read, write: if false).
//
// PII rules: documents carry phoneHash (never the raw phone) and a Cupid-voiced
// outbound body (non-PII matchmaker prose, already dash-stripped by the
// generator). Never store raw user message bodies or phone numbers.

const SCHEDULED_MESSAGES_COL = "scheduled_messages";

const db = () => admin.firestore();

export type ScheduledMessageKind = ProactiveKind; // "rapport" | "deepen" | "reveal_match"
export type ScheduledMessageStatus = "pending" | "sent" | "skipped";

export interface ScheduledMessage {
  id?: string;
  phoneHash: string;
  body: string;
  sendAt: Timestamp;
  kind: ScheduledMessageKind;
  status: ScheduledMessageStatus;
  createdAt: Timestamp;
  // Freshness anchor: the member's last INBOUND (role:"user") turn timestamp as
  // it was when this message was queued (null if they had never messaged). At
  // drain we re-read the current last-inbound time and skip ONLY if it advanced
  // past this anchor — i.e. the member genuinely messaged after we queued. We do
  // NOT compare against the member doc's `updatedAt`, because the review's own
  // proactive-tracker write bumps `updatedAt` just after createdAt, which would
  // falsely mark every review-queued message as stale.
  inboundAnchorMs?: number;
  topic?: string;
  reason?: string;
}

/**
 * Queue a proactive message. Sets status:"pending" and createdAt (now if absent).
 * Returns the new doc id. Strips undefined (Firestore rejects it).
 */
export async function enqueueScheduledMessage(
  msg: Omit<ScheduledMessage, "id" | "status" | "createdAt"> & { createdAt?: Timestamp }
): Promise<string> {
  const doc: ScheduledMessage = {
    phoneHash: msg.phoneHash,
    body: msg.body,
    sendAt: msg.sendAt,
    kind: msg.kind,
    status: "pending",
    createdAt: msg.createdAt ?? Timestamp.now(),
    ...(msg.inboundAnchorMs !== undefined ? { inboundAnchorMs: msg.inboundAnchorMs } : {}),
    ...(msg.topic !== undefined ? { topic: msg.topic } : {}),
    ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
  };
  const ref = await db().collection(SCHEDULED_MESSAGES_COL).add(doc);
  return ref.id;
}

export interface DrainSummary {
  sent: number;
  skipped: number;
}

/**
 * Drain due pending messages (every 5 min). Re-checks freshness and the
 * proactive cadence ceiling at send time, sends via the sendSms sanitizer,
 * appends an assistant turn, and marks each sent/skipped. One bad doc never
 * aborts the rest. @param force ignore sendAt (demo).
 */
export async function drainScheduledMessages(force = false): Promise<DrainSummary> {
  const {
    getUser,
    getActiveMatchForUser,
    appendConversationTurn,
    updateUser,
    getPhoneByHash,
    getLastInboundAt,
  } = await import("../services/firestore");
  const { sendSms } = await import("../services/twilio");
  const { BUSY_MATCH_STATUSES } = await import("./friendCheckins");
  const { proactiveCeilingExceeded } = await import("./engagementReview");

  const now = Timestamp.now();
  let query = db()
    .collection(SCHEDULED_MESSAGES_COL)
    .where("status", "==", "pending") as admin.firestore.Query;
  if (!force) query = query.where("sendAt", "<=", now);
  const snap = await query.limit(200).get();

  const summary: DrainSummary = { sent: 0, skipped: 0 };

  for (const docSnap of snap.docs) {
    const msg = { id: docSnap.id, ...docSnap.data() } as ScheduledMessage;
    try {
      const member = await getUser(msg.phoneHash);

      // Freshness + eligibility re-checks (mirror runScheduledDates).
      if (!member || member.active === false || !member.onboardingComplete) {
        await markScheduledMessage(msg.id!, "skipped");
        summary.skipped++;
        continue;
      }
      // Member messaged since this was queued: don't double-text. We anchor on
      // the last INBOUND turn time, NOT the member doc's `updatedAt`: the
      // review's own proactive-tracker write bumps `updatedAt` just after
      // createdAt, so using `updatedAt` here would skip EVERY review-queued
      // message. A genuine inbound advances getLastInboundAt past the anchor we
      // captured at enqueue time.
      const lastInbound = await getLastInboundAt(msg.phoneHash);
      const anchorMs = msg.inboundAnchorMs ?? 0;
      if (lastInbound && lastInbound.toMillis() > anchorMs) {
        await markScheduledMessage(msg.id!, "skipped");
        summary.skipped++;
        continue;
      }
      // Now in a busy match flow: leave them alone.
      const activeMatch = await getActiveMatchForUser(msg.phoneHash);
      if (activeMatch && BUSY_MATCH_STATUSES.has(activeMatch.status)) {
        await markScheduledMessage(msg.id!, "skipped");
        summary.skipped++;
        continue;
      }
      // Cadence ceiling re-check.
      if (proactiveCeilingExceeded(member)) {
        await markScheduledMessage(msg.id!, "skipped");
        summary.skipped++;
        continue;
      }

      const phone = await getPhoneByHash(msg.phoneHash);
      if (!phone) {
        await markScheduledMessage(msg.id!, "skipped");
        summary.skipped++;
        continue;
      }

      await appendConversationTurn(msg.phoneHash, {
        role: "assistant",
        content: msg.body,
        timestamp: Timestamp.now(),
      });
      await sendSms(phone, msg.body);
      await updateUser(msg.phoneHash, {
        lastProactiveAt: Timestamp.now(),
        proactiveLog: trimProactiveLog(member, msg),
      });
      await markScheduledMessage(msg.id!, "sent");
      summary.sent++;
      functions.logger.info("Scheduled message sent", {
        userHash: msg.phoneHash.slice(0, 8),
        kind: msg.kind,
      });
    } catch (err) {
      functions.logger.error("Scheduled message drain error", {
        userHash: msg.phoneHash.slice(0, 8),
        err,
      });
    }
  }

  return summary;
}

function trimProactiveLog(member: UserProfile, msg: ScheduledMessage) {
  const entry = {
    at: Timestamp.now(),
    kind: msg.kind,
    ...(msg.topic !== undefined ? { topic: msg.topic } : {}),
  };
  return [...(member.proactiveLog ?? []), entry].slice(-10);
}

export async function markScheduledMessage(
  id: string,
  status: ScheduledMessageStatus
): Promise<void> {
  await db().collection(SCHEDULED_MESSAGES_COL).doc(id).update({ status });
}
