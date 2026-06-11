/**
 * Server-side product analytics (PostHog, plain fetch — no SDK dependency).
 *
 * Design rules:
 * - Fire-and-forget: `track()` NEVER throws and is never awaited on the hot
 *   path. Call sites use `void track(...)`.
 * - No-op when DEMO_MODE === "true" or POSTHOG_API_KEY is unset, so the
 *   product runs fine without analytics configured.
 * - distinctId is ALWAYS the phoneHash. As a defense-in-depth measure,
 *   anything that looks like a raw phone number is hashed before sending
 *   (same sha256-of-normalized-E.164 scheme as services/firestore.ts).
 * - Properties must be small primitives (stage, matchId, score). NEVER
 *   message content, NEVER raw phone numbers.
 */

import * as crypto from "crypto";

const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const TRACK_TIMEOUT_MS = 3000;

// ─── Event catalogue ──────────────────────────────────────────────────────────

export const AnalyticsEvents = {
  userCreated: "user_created",
  onboardingCompleted: "onboarding_completed",
  messageReceived: "message_received",
  messageSent: "message_sent",
  matchProposed: "match_proposed",
  matchAccepted: "match_accepted",
  matchDeclined: "match_declined",
  dateScheduled: "date_scheduled",
  videoRoomOpened: "video_room_opened",
  contactExchanged: "contact_exchanged",
  referralRedeemed: "referral_redeemed",
  checkinSent: "checkin_sent",
  paymentRequiredShown: "payment_required_shown",
} as const;

export type AnalyticsEvent = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

// ─── Distinct-ID safety ───────────────────────────────────────────────────────

/** Heuristic for "this looks like a raw phone number, not a phoneHash". */
const RAW_PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

/**
 * Mirrors normalizePhone + hashPhone in services/firestore.ts (duplicated
 * here deliberately so analytics has zero internal dependencies).
 */
function hashRawPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  let normalized = `+${digits}`;
  if (digits.length === 10) normalized = `+1${digits}`;
  return crypto.createHash("sha256").update(normalized.trim()).digest("hex");
}

/**
 * Guarantee the distinct id sent to PostHog is never a raw phone number.
 * phoneHashes (64-char hex) pass through untouched; anything phone-shaped is
 * sha256-hashed with the same scheme firestore.ts uses, so the id still
 * joins up with events tracked by phoneHash.
 */
export function toDistinctId(id: string): string {
  return RAW_PHONE_RE.test(id) ? hashRawPhone(id) : id;
}

// ─── track() ──────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget event capture. Never throws, never rejects.
 * Call as `void track(...)` — do NOT await on the hot path.
 */
export function track(
  event: AnalyticsEvent,
  distinctId: string,
  properties?: Record<string, unknown>
): Promise<void> {
  try {
    if (process.env.DEMO_MODE === "true") return Promise.resolve();
    const apiKey = process.env.POSTHOG_API_KEY;
    if (!apiKey) return Promise.resolve();

    const host = (process.env.POSTHOG_HOST || POSTHOG_DEFAULT_HOST).replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRACK_TIMEOUT_MS);
    // Don't let the analytics timer keep the process alive.
    if (typeof timer.unref === "function") timer.unref();

    return fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: toDistinctId(distinctId),
        properties: { ...properties },
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  } catch {
    // Analytics must never break the product.
    return Promise.resolve();
  }
}
