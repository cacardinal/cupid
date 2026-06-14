import { Timestamp } from "firebase-admin/firestore";
import { ConversationTurn } from "../models/user";
import {
  inferActiveWindow,
  computeSendAt,
  ACTIVE_HOURS_MIN_SAMPLES,
} from "../services/activeHours";

const CT_OFFSET_HOURS = 5;

// Build an inbound turn whose CT hour is `hourCt`.
function inboundAt(hourCt: number): ConversationTurn {
  // pick a UTC instant that maps to hourCt CT
  const utc = new Date(Date.UTC(2026, 5, 14, hourCt + CT_OFFSET_HOURS, 0, 0));
  return { role: "user", content: "x", timestamp: Timestamp.fromDate(utc) };
}

function ctHour(d: Date): number {
  return new Date(d.getTime() - CT_OFFSET_HOURS * 3600 * 1000).getUTCHours();
}

describe("inferActiveWindow", () => {
  test("thin data uses safe default afternoon window", () => {
    const w = inferActiveWindow([inboundAt(20), inboundAt(20)]);
    expect(w.fromData).toBe(false);
    expect(w.startHourCt).toBe(13);
    expect(w.endHourCt).toBe(18);
  });

  test("clustered evening inbound centers window there", () => {
    const turns = [
      inboundAt(18),
      inboundAt(19),
      inboundAt(19),
      inboundAt(20),
      inboundAt(19),
    ];
    const w = inferActiveWindow(turns);
    expect(w.fromData).toBe(true);
    // median is 19 => window 17-21, but 21 is quiet-start (exclusive) so end clamps fine
    expect(w.startHourCt).toBeGreaterThanOrEqual(9);
    expect(w.endHourCt).toBeGreaterThan(w.startHourCt);
    expect(w.startHourCt).toBeGreaterThanOrEqual(17 - 1);
  });
});

describe("computeSendAt", () => {
  test("deterministic with injected rnd, >= from, daytime, not quiet", () => {
    const from = new Date(Date.UTC(2026, 5, 14, 6, 0, 0)); // ~1am CT
    const w = { startHourCt: 13, endHourCt: 18, fromData: false };
    const rnd = () => 0.5;
    const a = computeSendAt(w, from, rnd);
    const b = computeSendAt(w, from, rnd);
    expect(a.toMillis()).toBe(b.toMillis());
    expect(a.toMillis()).toBeGreaterThanOrEqual(from.getTime());
    const h = ctHour(a.toDate());
    expect(h).toBeGreaterThanOrEqual(13);
    expect(h).toBeLessThan(18);
  });

  test("respects custom quiet hours and never lands in them", () => {
    const from = new Date(Date.UTC(2026, 5, 14, 18, 0, 0));
    // custom quiet 12-14; a window that would otherwise pick noon
    const w = { startHourCt: 13, endHourCt: 18, fromData: true };
    const send = computeSendAt(w, from, () => 0, 12, 14);
    const h = ctHour(send.toDate());
    expect(h >= 12 && h < 14).toBe(false);
  });

  test("never schedules overnight (result hour is daytime)", () => {
    const from = new Date(Date.UTC(2026, 5, 14, 4, 0, 0));
    const w = { startHourCt: 13, endHourCt: 18, fromData: false };
    for (let i = 0; i < 10; i++) {
      const send = computeSendAt(w, from, () => i / 10);
      const h = ctHour(send.toDate());
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(21);
    }
  });

  test("uses ACTIVE_HOURS_MIN_SAMPLES constant", () => {
    expect(ACTIVE_HOURS_MIN_SAMPLES).toBe(5);
  });
});
