import { UserProfile } from "../models/user";

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockGetUser = jest.fn();
const mockGetUsersWithoutRecentMatch = jest.fn();
const mockGetActiveMatchForUser = jest.fn();
const mockProposeCalls: unknown[] = [];

jest.mock("../services/firestore", () => ({
  getUser: (...a: unknown[]) => mockGetUser(...a),
  getUsersWithoutRecentMatch: (...a: unknown[]) => mockGetUsersWithoutRecentMatch(...a),
  getActiveMatchForUser: (...a: unknown[]) => mockGetActiveMatchForUser(...a),
}));

jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// We exercise attemptInstantMatch's decision logic; proposeMatchPair itself is
// covered indirectly. Spy on it by mocking the heavy downstream services it uses.
const mockCreateMatchRecord = jest.fn().mockResolvedValue("match-id");
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockGetPhoneByHash = jest.fn().mockResolvedValue("+13145550000");
jest.mock("../services/firestore", () => ({
  getUser: (...a: unknown[]) => mockGetUser(...a),
  getUsersWithoutRecentMatch: (...a: unknown[]) => mockGetUsersWithoutRecentMatch(...a),
  getActiveMatchForUser: (...a: unknown[]) => mockGetActiveMatchForUser(...a),
  createMatchRecord: (...a: unknown[]) => {
    mockProposeCalls.push(a[0]);
    return mockCreateMatchRecord(...a);
  },
  updateUser: (...a: unknown[]) => mockUpdateUser(...a),
  getPhoneByHash: (...a: unknown[]) => mockGetPhoneByHash(...a),
}));
jest.mock("../services/claude", () => ({
  generateMatchProposal: jest.fn().mockResolvedValue({ message: "I think you two would click." }),
}));
jest.mock("../services/twilio", () => ({ sendSms: jest.fn().mockResolvedValue("sid") }));
jest.mock("../services/analytics", () => ({ track: jest.fn() }));

import { attemptInstantMatch, INSTANT_MATCH_MIN_SCORE } from "../scheduler/jobs";

function user(over: Partial<UserProfile> & { phoneHash: string }): UserProfile {
  return {
    onboardingComplete: true,
    demographics: { age: 30, gender: "woman", city: "st. louis", orientation: "straight" },
    preferences: {
      ageMin: 25,
      ageMax: 40,
      genderPreference: ["man"],
      relationshipIntent: "long-term",
      dealbreakers: [],
    },
    personality: {
      interests: ["hiking", "bbq", "live music"],
      values: ["honesty", "family"],
      humorStyle: "witty",
      communicationStyle: "texter",
    },
    ...over,
  } as UserProfile;
}

// A man who is a strong match for the default woman above.
function strongMan(hash: string): UserProfile {
  return user({
    phoneHash: hash,
    demographics: { age: 32, gender: "man", city: "st. louis", orientation: "straight" },
    preferences: {
      ageMin: 27,
      ageMax: 38,
      genderPreference: ["woman"],
      relationshipIntent: "long-term",
      dealbreakers: [],
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProposeCalls.length = 0;
  mockGetActiveMatchForUser.mockResolvedValue(null);
});

describe("attemptInstantMatch", () => {
  test("not_ready when onboarding incomplete", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me", onboardingComplete: false }));
    expect(await attemptInstantMatch("me")).toEqual({ matched: false, reason: "not_ready" });
  });

  test("cooldown blocks", async () => {
    mockGetUser.mockResolvedValue(
      user({ phoneHash: "me", matchCooldownUntil: { toMillis: () => Date.now() + 1e6 } as never })
    );
    expect(await attemptInstantMatch("me")).toEqual({ matched: false, reason: "cooldown" });
  });

  test("active_match blocks", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    mockGetActiveMatchForUser.mockResolvedValueOnce({ id: "m1" });
    expect(await attemptInstantMatch("me")).toEqual({ matched: false, reason: "active_match" });
  });

  test("no_candidate when pool empty", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    mockGetUsersWithoutRecentMatch.mockResolvedValue([user({ phoneHash: "me" })]); // only self
    expect(await attemptInstantMatch("me")).toEqual({ matched: false, reason: "no_candidate" });
  });

  test("no_candidate when best below the instant bar", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    // A valid but weak match: opposite intent, no shared interests/values.
    const weak = user({
      phoneHash: "weak",
      demographics: { age: 33, gender: "man", city: "st. louis", orientation: "straight" },
      preferences: {
        ageMin: 25,
        ageMax: 40,
        genderPreference: ["woman"],
        relationshipIntent: "casual",
        dealbreakers: [],
      },
      personality: { interests: ["golf"], values: ["ambition"], humorStyle: "dry", communicationStyle: "caller" },
    });
    mockGetUsersWithoutRecentMatch.mockResolvedValue([weak]);
    const r = await attemptInstantMatch("me");
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("no_candidate");
  });

  test("introduces both sides on a high-confidence pair", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    mockGetUsersWithoutRecentMatch.mockResolvedValue([strongMan("him")]);
    const r = await attemptInstantMatch("me");
    expect(r.matched).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(INSTANT_MATCH_MIN_SCORE);
    expect(r.matchedWith).toBe("him");
    // Reciprocal records: one for each side.
    expect(mockProposeCalls).toHaveLength(2);
    const { sendSms } = jest.requireMock("../services/twilio");
    expect(sendSms).toHaveBeenCalledTimes(2);
  });

  test("picks the highest-scoring candidate", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    const good = strongMan("good");
    good.personality.interests = ["golf"]; // weaker interest overlap
    good.personality.values = ["ambition"]; // weaker values overlap
    const perfect = strongMan("perfect"); // inherits full overlap from default user()
    mockGetUsersWithoutRecentMatch.mockResolvedValue([good, perfect]);
    const r = await attemptInstantMatch("me");
    expect(r.matched).toBe(true);
    expect(r.matchedWith).toBe("perfect");
  });

  test("candidate_busy skips when chosen partner just matched", async () => {
    mockGetUser.mockResolvedValue(user({ phoneHash: "me" }));
    mockGetUsersWithoutRecentMatch.mockResolvedValue([strongMan("him")]);
    // self check passes (null), candidate check returns a match.
    mockGetActiveMatchForUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "busy" });
    expect(await attemptInstantMatch("me")).toEqual({ matched: false, reason: "candidate_busy" });
    expect(mockProposeCalls).toHaveLength(0);
  });
});
