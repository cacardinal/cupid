import { UserProfile } from "../models/user";

const mockUpdateUser = jest.fn();
jest.mock("../services/firestore", () => ({
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
}));

const mockLogAbuseEvent = jest.fn();
jest.mock("../services/abuseLog", () => ({
  logAbuseEvent: (...args: unknown[]) => mockLogAbuseEvent(...args),
  SYSTEM_ACTOR: "system",
}));

import {
  checkDailyTurnCap,
  ctDateString,
  DAILY_TURN_CAP,
  CAP_NOTICE_MESSAGE,
} from "../services/usageGuard";

const NOW = new Date("2026-06-11T20:00:00Z"); // 3pm CT
const TODAY = ctDateString(NOW);

function profileWith(over: Partial<UserProfile>): UserProfile {
  return { phoneHash: "abc123", ...over } as UserProfile;
}

beforeEach(() => {
  mockUpdateUser.mockReset().mockResolvedValue(undefined);
  mockLogAbuseEvent.mockReset();
});

describe("ctDateString", () => {
  test("converts UTC to CT date", () => {
    // 2am UTC June 12 is 9pm CT June 11
    expect(ctDateString(new Date("2026-06-12T02:00:00Z"))).toBe("2026-06-11");
  });
});

describe("checkDailyTurnCap", () => {
  test("first message of the day allowed, resets counter", async () => {
    const d = await checkDailyTurnCap(
      profileWith({ dailyTurnDate: "2026-06-10", dailyTurnCount: 999 }),
      NOW
    );
    expect(d.allowed).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledWith("abc123", {
      dailyTurnDate: TODAY,
      dailyTurnCount: 1,
    });
  });

  test("allowed at exactly the cap", async () => {
    const d = await checkDailyTurnCap(
      profileWith({ dailyTurnDate: TODAY, dailyTurnCount: DAILY_TURN_CAP - 1 }),
      NOW
    );
    expect(d.allowed).toBe(true);
  });

  test("blocked over cap with one notice", async () => {
    const d = await checkDailyTurnCap(
      profileWith({ dailyTurnDate: TODAY, dailyTurnCount: DAILY_TURN_CAP }),
      NOW
    );
    expect(d).toEqual({ allowed: false, sendNotice: true });
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "abc123",
      expect.objectContaining({ capNoticeDate: TODAY })
    );
  });

  test("silent after notice already sent today", async () => {
    const d = await checkDailyTurnCap(
      profileWith({
        dailyTurnDate: TODAY,
        dailyTurnCount: DAILY_TURN_CAP + 5,
        capNoticeDate: TODAY,
      }),
      NOW
    );
    expect(d).toEqual({ allowed: false, sendNotice: false });
  });

  test("fail-open on Firestore error", async () => {
    mockUpdateUser.mockRejectedValue(new Error("boom"));
    const d = await checkDailyTurnCap(
      profileWith({ dailyTurnDate: TODAY, dailyTurnCount: DAILY_TURN_CAP + 5 }),
      NOW
    );
    expect(d.allowed).toBe(true);
  });

  test("SITE 1: emits daily_cap_breach once when over cap", async () => {
    await checkDailyTurnCap(
      profileWith({ dailyTurnDate: TODAY, dailyTurnCount: DAILY_TURN_CAP }),
      NOW
    );
    expect(mockLogAbuseEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAbuseEvent).toHaveBeenCalledWith({
      phoneHash: "abc123",
      type: "daily_cap_breach",
      severity: "medium",
      evidence: `turn ${DAILY_TURN_CAP + 1} over ${DAILY_TURN_CAP}`,
      source: "usageGuard",
    });
  });

  test("SITE 1: does NOT emit when under cap", async () => {
    await checkDailyTurnCap(
      profileWith({ dailyTurnDate: TODAY, dailyTurnCount: DAILY_TURN_CAP - 1 }),
      NOW
    );
    expect(mockLogAbuseEvent).not.toHaveBeenCalled();
  });

  test("cap notice obeys voice rules", () => {
    expect(CAP_NOTICE_MESSAGE).not.toMatch(/[—–]/);
    expect(CAP_NOTICE_MESSAGE.length).toBeLessThan(200);
  });
});
