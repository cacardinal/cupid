import { Timestamp } from "firebase-admin/firestore";

/**
 * Scheduled video dates: when both users accept a match, Cupid proposes
 * evening time slots instead of dropping an instant link. Both confirm by
 * text, each gets a calendar invite (ICS), and the room opens on time.
 *
 * All times are America/Chicago (launch market is St. Louis).
 */

export const SLOT_COUNT = 3;
const EVENING_HOURS_CT = [19, 20]; // 7pm, 8pm CT candidates
const TZ_OFFSET_HOURS = 5; // CT = UTC-5 (CDT); fine for launch, revisit for CST

/** Next N evening slots starting tomorrow (never same-day pressure). */
export function proposeSlots(now: Date = new Date()): Date[] {
  const slots: Date[] = [];
  let dayOffset = 1;
  while (slots.length < SLOT_COUNT) {
    for (const hour of EVENING_HOURS_CT) {
      if (slots.length >= SLOT_COUNT) break;
      const d = new Date(now);
      d.setUTCHours(hour + TZ_OFFSET_HOURS, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + dayOffset);
      slots.push(d);
    }
    dayOffset++;
  }
  return slots;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday 7:00 PM" in CT. */
export function formatSlotCT(d: Date): string {
  const ct = new Date(d.getTime() - TZ_OFFSET_HOURS * 3600_000);
  const day = DAY_NAMES[ct.getUTCDay()];
  let h = ct.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const min = String(ct.getUTCMinutes()).padStart(2, "0");
  return `${day} ${h}:${min} ${ampm}`;
}

export function slotsMessage(slots: Date[]): string {
  const lines = slots.map((s, i) => `${i + 1}) ${formatSlotCT(s)}`);
  return (
    `You're both in! 🎉 Let's find a time for your video date (15 min, anonymous, no pressure). I can do:\n\n` +
    lines.join("\n") +
    `\n\nReply 1, 2, or 3 — or "none" if none of those work.`
  );
}

/**
 * Parse a slot choice from a user reply.
 * Returns the slot index (0-based), "none", or null when unclear.
 */
export function parseSlotReply(body: string, slotCount = SLOT_COUNT): number | "none" | null {
  const t = body.trim().toLowerCase();
  if (/\b(none|neither|no(ne)? of (those|them)|can'?t (do|make))\b/.test(t)) return "none";
  const m = t.match(/(?:^|\b(?:option|slot|number)?\s*)([1-9])\b/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < slotCount) return idx;
  }
  if (/\bfirst\b/.test(t)) return 0;
  if (/\bsecond\b/.test(t)) return 1;
  if (/\bthird\b/.test(t)) return 2;
  return null;
}

/** Minimal RFC 5545 ICS for the date. Served by the calendarInvite function. */
export function buildIcs(matchId: string, scheduledAt: Date, roomUrl?: string): string {
  const dtStart = toIcsUtc(scheduledAt);
  const dtEnd = toIcsUtc(new Date(scheduledAt.getTime() + 20 * 60_000));
  const stamp = toIcsUtc(scheduledAt); // deterministic; avoids Date.now in tests
  const description = roomUrl
    ? `Your anonymous Cupid video date. Join here: ${roomUrl}`
    : "Your anonymous Cupid video date. The join link arrives by text when the room opens.";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cupid//textcupid.app//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:cupid-${matchId}@textcupid.app`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    "SUMMARY:💘 Cupid video date",
    `DESCRIPTION:${description.replace(/([,;])/g, "\\$1")}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Cupid date in 15 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function calendarLink(matchId: string, phoneHash: string): string {
  const base =
    process.env.DEMO_MODE === "true"
      ? "http://localhost:5001/cupid-dating-mvp/us-central1/calendarInvite"
      : "https://us-central1-cupid-dating-mvp.cloudfunctions.net/calendarInvite";
  return `${base}?match=${matchId}&u=${phoneHash.slice(0, 16)}`;
}

export function scheduledConfirmationMessage(scheduledAt: Date, matchId: string, phoneHash: string): string {
  return (
    `It's a date: ${formatSlotCT(scheduledAt)} 🗓\n\n` +
    `Add it to your calendar: ${calendarLink(matchId, phoneHash)}\n\n` +
    `I'll text you the video link when the room opens. Don't ghost — I'll know 😉`
  );
}

export function toTimestamp(d: Date): Timestamp {
  return Timestamp.fromMillis(d.getTime());
}
