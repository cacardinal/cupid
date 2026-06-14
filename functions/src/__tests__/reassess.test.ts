import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

const mockGetUser = jest.fn();
const mockGetUsersWithoutRecentMatch = jest.fn();
const mockGetActiveMatchForUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockGetPhoneByHash = jest.fn().mockResolvedValue("+13145550000");
const mockCreateMatchRecord = jest.fn().mockResolvedValue("mid");

jest.mock("../services/firestore", () => ({
  getUser: (...a: unknown[]) => mockGetUser(...a),
  getUsersWithoutRecentMatch: (...a: unknown[]) => mockGetUsersWithoutRecentMatch(...a),
  getActiveMatchForUser: (...a: unknown[]) => mockGetActiveMatchForUser(...a),
  updateUser: (...a: unknown[]) => mockUpdateUser(...a),
  getPhoneByHash: (...a: unknown[]) => mockGetPhoneByHash(...a),
  createMatchRecord: (...a: unknown[]) => mockCreateMatchRecord(...a),
}));

const mockInterpretOpenness = jest.fn();
jest.mock("../services/claude", () => ({
  interpretOpenness: (...a: unknown[]) => mockInterpretOpenness(...a),
  generateMatchProposal: jest.fn().mockResolvedValue({ message: "intro" }),
}));
jest.mock("../services/twilio", () => ({ sendSms: jest.fn().mockResolvedValue("sid") }));
jest.mock("../services/analytics", () => ({ track: jest.fn() }));
jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { reassessMatchPool, isMaterialChange } from "../scheduler/jobs";

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
  mockGetActiveMatchForUser.mockResolvedValue(null);
  mockGetUsersWithoutRecentMatch.mockResolvedValue([]);
});

describe("reassessMatchPool", () => {
  test("not onboarded -> reassessed false", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me", onboardingComplete: false }));
    const r = await reassessMatchPool("me");
    expect(r.reassessed).toBe(false);
  });

  test("interprets openness and persists locationOpenCities", async () => {
    mockGetUser.mockResolvedValue(
      user({ phoneHash: "me", preferences: { ageMin: 25, ageMax: 40, genderPreference: ["man"], dealbreakers: [], locationOpenness: "I'd drive to KC" } })
    );
    mockGetUsersWithoutRecentMatch.mockResolvedValue([
      user({ phoneHash: "kc", demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" } }),
    ]);
    mockInterpretOpenness.mockResolvedValue(["kansas city"]);
    const r = await reassessMatchPool("me");
    expect(mockInterpretOpenness).toHaveBeenCalled();
    expect(r.openCitiesUpdated).toBe(true);
    const persisted = mockUpdateUser.mock.calls.find(
      (c) => c[1]?.preferences?.locationOpenCities
    );
    expect(persisted?.[1].preferences.locationOpenCities).toEqual(["kansas city"]);
  });

  test("calls attemptInstantMatch (proposes on strong pair)", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    mockGetUsersWithoutRecentMatch.mockResolvedValue([
      user({ phoneHash: "him", demographics: { age: 32, gender: "man", city: "st. louis", orientation: "straight" }, preferences: { ageMin: 27, ageMax: 38, genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] } }),
    ]);
    const r = await reassessMatchPool("me");
    expect(r.reassessed).toBe(true);
    // a strong same-city pair should trigger reciprocal match records
    expect(mockCreateMatchRecord).toHaveBeenCalled();
  });

  test("never throws on downstream error", async () => {
    mockGetUser.mockRejectedValue(new Error("db down"));
    const r = await reassessMatchPool("me");
    expect(r.reassessed).toBe(false);
    expect(r.reason).toBe("error");
  });
});

describe("isMaterialChange", () => {
  test("true for demographics change", () => {
    expect(isMaterialChange({ demographics: { city: "kansas city" } })).toBe(true);
  });
  test("true for a material preference key", () => {
    expect(isMaterialChange({ preferences: { relationshipIntent: "casual" } })).toBe(true);
  });
  test("true for personality values change", () => {
    expect(isMaterialChange({ personality: { values: ["faith"] } })).toBe(true);
  });
  test("false for onboardingStage-only update", () => {
    expect(isMaterialChange({ onboardingStage: "personality" })).toBe(false);
  });
  test("false for narrative-only update", () => {
    expect(isMaterialChange({ narrative: "a summary" })).toBe(false);
  });
  test("false for empty update", () => {
    expect(isMaterialChange({})).toBe(false);
  });
});
