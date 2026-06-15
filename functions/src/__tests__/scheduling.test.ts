import { proposeSlots, parseSlotReply, formatSlotCT, buildIcs, slotsMessage } from "../services/scheduling";
import { isDueForCheckin, BUSY_MATCH_STATUSES } from "../scheduler/friendCheckins";
import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

describe("proposeSlots", () => {
  const base = new Date("2026-06-10T15:00:00Z");

  it("returns 3 future evening slots starting tomorrow", () => {
    const slots = proposeSlots(base);
    expect(slots).toHaveLength(3);
    for (const s of slots) expect(s.getTime()).toBeGreaterThan(base.getTime());
    // first slot = tomorrow 7pm CT, which is 00:00 UTC the day after (CT+5h rolls the UTC date)
    expect(slots[0].getUTCDate()).toBe(12);
  });

  it("slots are at 7pm/8pm CT (00:00/01:00 UTC)", () => {
    const slots = proposeSlots(base);
    const hours = slots.map((s) => s.getUTCHours());
    for (const h of hours) expect([0, 1]).toContain(h);
  });
});

describe("parseSlotReply", () => {
  it.each([
    ["1", 0],
    ["2 please", 1],
    ["option 3", 2],
    ["first one", 0],
    ["the second", 1],
    ["none of those work", "none"],
    ["can't do any", "none"],
    ["what about Sunday?", null],
    ["7", null], // out of range
  ])("%s -> %s", (input, expected) => {
    expect(parseSlotReply(input as string)).toBe(expected);
  });
});

describe("formatSlotCT / slotsMessage", () => {
  it("formats midnight UTC as 7pm CT", () => {
    expect(formatSlotCT(new Date("2026-06-12T00:00:00Z"))).toBe("Thursday 7:00 PM");
  });
  it("message lists numbered options", () => {
    const msg = slotsMessage(proposeSlots(new Date("2026-06-10T15:00:00Z")));
    expect(msg).toMatch(/1\) /);
    expect(msg).toMatch(/3\) /);
    expect(msg).toMatch(/Reply 1, 2, or 3/);
  });
});

describe("buildIcs", () => {
  it("produces a valid VCALENDAR with alarm and room URL", () => {
    const ics = buildIcs("m123", new Date("2026-06-12T00:00:00Z"), "https://textcupid.daily.co/x");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:cupid-m123@textcupid.app");
    expect(ics).toContain("DTSTART:20260612T000000Z");
    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).toContain("textcupid.daily.co/x");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics.split("\r\n").length).toBeGreaterThan(10);
  });
});

describe("isDueForCheckin", () => {
  const now = new Date("2026-06-10T18:00:00Z");
  const daysAgo = (d: number) => Timestamp.fromMillis(now.getTime() - d * 86_400_000);

  const mkUser = (over: Partial<UserProfile>): UserProfile =>
    ({
      phoneHash: "h",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(10),
      onboardingComplete: true,
      onboardingStage: "complete",
      demographics: {},
      preferences: {},
      personality: {},
      active: true,
      totalMatches: 0,
      creditsRemaining: 1,
      testUser: false,
      liveStatus: "offline",
      referralCode: "CUP-AAAAAA",
      referralCount: 0,
      ...over,
    } as UserProfile);

  it("due when never checked in and quiet for days", () => {
    expect(isDueForCheckin(mkUser({}), now)).toBe(true);
  });
  it("not due when checked in yesterday (early cadence 3d)", () => {
    expect(isDueForCheckin(mkUser({ lastCheckinAt: daysAgo(1), checkinCount: 1 }), now)).toBe(false);
  });
  it("due at 4 days with early cadence", () => {
    expect(isDueForCheckin(mkUser({ lastCheckinAt: daysAgo(4), checkinCount: 1 }), now)).toBe(true);
  });
  it("established users (3+) wait a week", () => {
    expect(isDueForCheckin(mkUser({ lastCheckinAt: daysAgo(4), checkinCount: 5 }), now)).toBe(false);
    expect(isDueForCheckin(mkUser({ lastCheckinAt: daysAgo(8), checkinCount: 5 }), now)).toBe(true);
  });
  it("skips inactive and un-onboarded users", () => {
    expect(isDueForCheckin(mkUser({ active: false }), now)).toBe(false);
    expect(isDueForCheckin(mkUser({ onboardingComplete: false }), now)).toBe(false);
  });
  it("doesn't double-text someone active in the last 24h", () => {
    expect(
      isDueForCheckin(mkUser({ lastCheckinAt: daysAgo(5), checkinCount: 1, updatedAt: Timestamp.fromMillis(now.getTime() - 3_600_000) }), now)
    ).toBe(false);
  });
});

describe("BUSY_MATCH_STATUSES leaves mid-flow members alone", () => {
  it("includes the post-date debrief and contact-offer states", () => {
    // The engagement review must never proactively text someone mid-debrief or
    // mid-contact-offer.
    expect(BUSY_MATCH_STATUSES.has("debriefing")).toBe(true);
    expect(BUSY_MATCH_STATUSES.has("video_expired")).toBe(true);
  });
});
