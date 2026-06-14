import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

const mockGetAllActiveUsers = jest.fn();
const mockGetActiveMatch = jest.fn();
const mockGetHistory = jest.fn().mockResolvedValue([]);
const mockGetPool = jest.fn().mockResolvedValue([]);
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockGetLastInboundAt = jest.fn().mockResolvedValue(null);
jest.mock("../services/firestore", () => ({
  getAllActiveUsers: (...a: unknown[]) => mockGetAllActiveUsers(...a),
  getActiveMatchForUser: (...a: unknown[]) => mockGetActiveMatch(...a),
  getConversationHistory: (...a: unknown[]) => mockGetHistory(...a),
  getUsersWithoutRecentMatch: (...a: unknown[]) => mockGetPool(...a),
  getLastInboundAt: (...a: unknown[]) => mockGetLastInboundAt(...a),
  updateUser: (...a: unknown[]) => mockUpdateUser(...a),
}));

const mockIsDue = jest.fn();
jest.mock("../scheduler/friendCheckins", () => ({
  isDueForCheckin: (...a: unknown[]) => mockIsDue(...a),
  BUSY_MATCH_STATUSES: new Set(["proposed", "scheduled"]),
}));

const mockFindNear = jest.fn().mockReturnValue([]);
jest.mock("../services/nearMatch", () => ({
  findNearMatches: (...a: unknown[]) => mockFindNear(...a),
}));
jest.mock("../services/profileGaps", () => ({ profileGaps: jest.fn().mockReturnValue([]) }));

const mockDecide = jest.fn();
jest.mock("../services/claude", () => ({ decideFollowUp: (...a: unknown[]) => mockDecide(...a) }));

const mockEnqueue = jest.fn().mockResolvedValue("doc1");
jest.mock("../scheduler/scheduledMessages", () => ({
  enqueueScheduledMessage: (...a: unknown[]) => mockEnqueue(...a),
}));

jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runEngagementReview, proactiveCeilingExceeded } from "../scheduler/engagementReview";

function user(over: Partial<UserProfile> & { phoneHash: string }): UserProfile {
  return {
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    onboardingComplete: true,
    onboardingStage: "complete",
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
    demographics: { age: 30, gender: "woman", city: "st. louis", orientation: "straight" },
    preferences: { ageMin: 25, ageMax: 40, genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    personality: { interests: ["hiking"], values: ["family"] },
    ...over,
  } as UserProfile;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveMatch.mockResolvedValue(null);
  mockGetPool.mockResolvedValue([]);
  mockGetHistory.mockResolvedValue([]);
  mockIsDue.mockReturnValue(true);
  mockFindNear.mockReturnValue([]);
  mockGetLastInboundAt.mockResolvedValue(null);
});

describe("runEngagementReview", () => {
  test("decline -> nothing queued, declined counted", async () => {
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a" })]);
    mockDecide.mockResolvedValue({ followUp: false, intent: "rapport", message: "", reason: "x" });
    const s = await runEngagementReview();
    expect(s.queued).toBe(0);
    expect(s.declined).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("reveal near-match -> queues reveal_match with sendAt", async () => {
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a" })]);
    mockFindNear.mockReturnValue([
      { candidate: user({ phoneHash: "c" }), softScore: 70, blockingFilter: "location", resolvable: "openness", question: "?", topic: "openness:kansas city", revealCity: "Kansas City" },
    ]);
    mockDecide.mockResolvedValue({ followUp: true, intent: "reveal_match", message: "someone in KC", reason: "strong fit" });
    const s = await runEngagementReview();
    expect(s.queued).toBe(1);
    expect(s.byIntent.reveal_match).toBe(1);
    const arg = mockEnqueue.mock.calls[0][0];
    expect(arg.kind).toBe("reveal_match");
    expect(arg.sendAt).toBeDefined();
    expect(arg.topic).toBe("openness:kansas city");
    // openness re-ask anchor recorded
    const upd = mockUpdateUser.mock.calls.find((c) => c[1]?.preferences?.opennessAskedAt);
    expect(upd).toBeTruthy();
  });

  test("enqueues inbound anchor captured before its own bookkeeping write", async () => {
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a" })]);
    mockGetLastInboundAt.mockResolvedValue(Timestamp.fromMillis(4242));
    mockDecide.mockResolvedValue({ followUp: true, intent: "rapport", message: "hi there", reason: "x" });
    await runEngagementReview();
    const arg = mockEnqueue.mock.calls[0][0];
    // The anchor is the member's last inbound turn time, NOT the doc updatedAt
    // that the subsequent proactive-tracker write bumps. This is what lets the
    // drain distinguish a real inbound from the review's own bookkeeping.
    expect(arg.inboundAnchorMs).toBe(4242);
  });

  test("cadence ceiling (3 in 7d) skips before decide", async () => {
    const now = Date.now();
    const log = [
      { at: Timestamp.fromMillis(now - 1000), kind: "rapport" as const },
      { at: Timestamp.fromMillis(now - 2000), kind: "rapport" as const },
      { at: Timestamp.fromMillis(now - 3000), kind: "rapport" as const },
    ];
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a", proactiveLog: log })]);
    const s = await runEngagementReview();
    expect(s.considered).toBe(0);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test("min-gap (proactive 10h ago) skips", async () => {
    mockGetAllActiveUsers.mockResolvedValue([
      user({ phoneHash: "a", lastProactiveAt: Timestamp.fromMillis(Date.now() - 10 * 3600 * 1000) }),
    ]);
    const s = await runEngagementReview();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(s.considered).toBe(0);
  });

  test("busy match skips", async () => {
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a" })]);
    mockGetActiveMatch.mockResolvedValue({ status: "scheduled" });
    await runEngagementReview();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test("isDueForCheckin false skips", async () => {
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a" })]);
    mockIsDue.mockReturnValue(false);
    await runEngagementReview();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test("trims proactiveLog to 10 on queue", async () => {
    const log = Array.from({ length: 12 }, (_, i) => ({
      at: Timestamp.fromMillis(Date.now() - (i + 1) * 8 * 24 * 3600 * 1000), // all old (outside 7d)
      kind: "rapport" as const,
    }));
    mockGetAllActiveUsers.mockResolvedValue([user({ phoneHash: "a", proactiveLog: log })]);
    mockDecide.mockResolvedValue({ followUp: true, intent: "rapport", message: "hi there", reason: "x" });
    await runEngagementReview();
    const upd = mockUpdateUser.mock.calls.find((c) => c[1]?.proactiveLog);
    expect(upd?.[1].proactiveLog.length).toBe(10);
  });
});

describe("proactiveCeilingExceeded", () => {
  test("false for a clean member", () => {
    expect(proactiveCeilingExceeded(user({ phoneHash: "a" }))).toBe(false);
  });
});
