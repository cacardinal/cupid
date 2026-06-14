import { Timestamp } from "firebase-admin/firestore";

/**
 * Abuse-review schema contract (single source of truth).
 *
 * Two top-level Firestore collections, admin-SDK only (see firestore.rules:
 * both deny all client access):
 *  - abuse_events:     append-only signals emitted by the runtime
 *  - moderation_flags: clustered/triaged flags produced by the daily agent
 *
 * PII rules (enforced by emitters, backstopped by abuseLog clamp):
 *  - phoneHash only, never a raw phone or message body
 *  - evidence is a short fixed-label string, no URL/phone/body content
 */

// ─── AbuseEvent ────────────────────────────────────────────────────────────────

export type AbuseEventType =
  | "daily_cap_breach"
  | "contact_scrub"
  | "injection_attempt"
  | "freeloader"
  | "concierge_decline"
  | "other";

export type AbuseSeverity = "low" | "medium" | "high";

export interface AbuseEvent {
  id?: string;
  phoneHash: string; // actor's phoneHash, or "system" sentinel for non-user signals
  type: AbuseEventType;
  severity: AbuseSeverity;
  evidence: string; // <=140 chars, no PII / phone / message body
  source: string; // emit site, e.g. "usageGuard", "inboundSecurity"
  createdAt: Timestamp; // server-stamped
}

// ─── ModerationFlag ────────────────────────────────────────────────────────────

export type ModerationStatus = "open" | "resolved";

export interface ModerationFlag {
  id?: string;
  phoneHash: string;
  types: AbuseEventType[];
  severity: AbuseSeverity;
  eventCount: number;
  evidence: string[];
  status: ModerationStatus;
  notes: string;
  createdAt: Timestamp;
  resolvedAt: Timestamp | null;
  resolvedBy: string | null;
}
