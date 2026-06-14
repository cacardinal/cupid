import { Timestamp } from "firebase-admin/firestore";
import { ConversationTurn } from "../models/user";

// ─── Active-hours inference ────────────────────────────────────────────────────
//
// Infer a member's typical CT active window from inbound (role === "user")
// message timestamps, and pick a concrete jittered send time inside it. Never
// schedules overnight; never inside the member's quiet hours. Thin data falls
// back to a safe afternoon default. Pure functions, injectable RNG for tests.

export const ACTIVE_HOURS_MIN_SAMPLES = 5;

// Matches usageGuard.ts / scheduling.ts convention (CT is UTC-5 here).
const CT_OFFSET_HOURS = 5;

// Safe defaults when data is thin or a window collapses into quiet hours.
const DEFAULT_START = 13; // 1pm CT
const DEFAULT_END = 18; // 6pm CT
const DEFAULT_QUIET_START = 21; // 9pm CT
const DEFAULT_QUIET_END = 9; // 9am CT

export interface ActiveWindow {
  startHourCt: number; // 0-23
  endHourCt: number; // 0-23 (exclusive end of the active band)
  fromData: boolean; // false = safe default used
}

function ctHour(d: Date): number {
  const ct = new Date(d.getTime() - CT_OFFSET_HOURS * 3600 * 1000);
  return ct.getUTCHours();
}

/**
 * Infer the typical CT active window from inbound turn timestamps. Uses the
 * median inbound hour as the window center, +/- 2h, clamped to daytime. Thin
 * data (< ACTIVE_HOURS_MIN_SAMPLES inbound turns) returns the safe default.
 */
export function inferActiveWindow(
  history: ConversationTurn[],
  quietStart: number = DEFAULT_QUIET_START,
  quietEnd: number = DEFAULT_QUIET_END
): ActiveWindow {
  const inboundHours = history
    .filter((t) => t.role === "user" && t.timestamp)
    .map((t) => ctHour(t.timestamp.toDate()))
    .sort((a, b) => a - b);

  if (inboundHours.length < ACTIVE_HOURS_MIN_SAMPLES) {
    return { startHourCt: DEFAULT_START, endHourCt: DEFAULT_END, fromData: false };
  }

  const median = inboundHours[Math.floor(inboundHours.length / 2)];
  let start = Math.max(0, median - 2);
  let end = Math.min(23, median + 2);

  // Trim the band so every hour in [start, end) is outside quiet hours. Walk the
  // edges inward until both ends sit in daytime.
  let guard = 0;
  while (start < end && inQuiet(start, quietStart, quietEnd) && guard < 24) {
    start++;
    guard++;
  }
  guard = 0;
  // end is exclusive; the last usable hour is end-1, so trim while end-1 is quiet
  while (end > start && inQuiet(end - 1, quietStart, quietEnd) && guard < 24) {
    end--;
    guard++;
  }
  if (end <= start) {
    // band collapsed into quiet hours; fall back to the safe default.
    return { startHourCt: DEFAULT_START, endHourCt: DEFAULT_END, fromData: true };
  }
  return { startHourCt: start, endHourCt: end, fromData: true };
}

// True if `hour` (0-23) falls inside the quiet window (which may wrap midnight).
function inQuiet(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  // wraps midnight (e.g. 21 -> 9)
  return hour >= quietStart || hour < quietEnd;
}

// First non-quiet daytime hour at or after `hour`, searching forward across the
// day. Falls back to DEFAULT_START if none found in the window's span.
function firstDaytimeHour(hour: number, quietStart: number, quietEnd: number): number {
  for (let i = 0; i < 24; i++) {
    const h = (hour + i) % 24;
    if (!inQuiet(h, quietStart, quietEnd)) return h;
  }
  return DEFAULT_START;
}

/**
 * Pick a concrete send time inside the window, jittered, on or after `from`,
 * never overnight and never inside quiet hours. Returns a Timestamp.
 */
export function computeSendAt(
  window: ActiveWindow,
  from: Date,
  rnd: () => number = Math.random,
  quietStart: number = DEFAULT_QUIET_START,
  quietEnd: number = DEFAULT_QUIET_END
): Timestamp {
  const span = Math.max(1, window.endHourCt - window.startHourCt);
  // jittered hour within the window
  let hourCt = window.startHourCt + Math.floor(rnd() * span);
  const minute = Math.floor(rnd() * 60);

  // safety: never schedule into quiet hours. Snap forward to the next daytime
  // hour (works even when DEFAULT_START itself falls in a custom quiet band).
  if (inQuiet(hourCt, quietStart, quietEnd)) {
    hourCt = firstDaytimeHour(hourCt, quietStart, quietEnd);
  }

  // Build a UTC instant for that CT hour, today (CT), advancing day(s) until it
  // is on or after `from`.
  const ctNow = new Date(from.getTime() - CT_OFFSET_HOURS * 3600 * 1000);
  let candidate = buildCtInstant(ctNow, hourCt, minute);
  let guard = 0;
  while (candidate.getTime() < from.getTime() && guard < 8) {
    ctNow.setUTCDate(ctNow.getUTCDate() + 1);
    candidate = buildCtInstant(ctNow, hourCt, minute);
    guard++;
  }
  return Timestamp.fromDate(candidate);
}

// Given a CT-shifted "now" and a target CT hour/minute, return the real UTC Date.
function buildCtInstant(ctRef: Date, hourCt: number, minute: number): Date {
  const ct = new Date(Date.UTC(
    ctRef.getUTCFullYear(),
    ctRef.getUTCMonth(),
    ctRef.getUTCDate(),
    hourCt,
    minute,
    0,
    0
  ));
  // shift back to real UTC
  return new Date(ct.getTime() + CT_OFFSET_HOURS * 3600 * 1000);
}
