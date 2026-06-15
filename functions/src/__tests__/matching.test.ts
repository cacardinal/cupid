import { Timestamp } from "firebase-admin/firestore";
import { UserProfile, BlockedMatch } from "../models/user";
import {
  computeCompatibility,
  findTopMatches,
  locationMatch,
  isPairBlocked,
  CompatibilityResult,
} from "../scheduler/matchingJob";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    phoneHash: `hash_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    onboardingComplete: true,
    onboardingStage: "complete",
    active: true,
    totalMatches: 0,
    creditsRemaining: 3,
    testUser: false,
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
    demographics: {
      age: 30,
      gender: "woman",
      city: "st. louis",
      orientation: "straight",
    },
    preferences: {
      ageMin: 28,
      ageMax: 40,
      radiusMiles: 25,
      genderPreference: ["man"],
      relationshipIntent: "long-term",
      dealbreakers: [],
    },
    personality: {
      humorStyle: "dry",
      communicationStyle: "texter",
      values: ["family", "honesty", "adventure"],
      interests: ["cooking", "hiking", "reading"],
      personalityTraits: ["introvert", "creative"],
    },
    ...overrides,
  };
}

function makeCompatibleMalePair(): [UserProfile, UserProfile] {
  const alice = makeUser({
    phoneHash: "hash_alice",
    demographics: { age: 30, gender: "woman", city: "st. louis", orientation: "straight" },
    preferences: { ageMin: 28, ageMax: 38, genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    personality: { humorStyle: "dry", interests: ["cooking", "hiking"], values: ["family", "honesty"], personalityTraits: ["introvert"] },
  });

  const bob = makeUser({
    phoneHash: "hash_bob",
    demographics: { age: 32, gender: "man", city: "st. louis", orientation: "straight" },
    preferences: { ageMin: 26, ageMax: 36, genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
    personality: { humorStyle: "dry", interests: ["cooking", "travel", "hiking"], values: ["family", "adventure"], personalityTraits: ["extrovert"] },
  });

  return [alice, bob];
}

// ─── computeCompatibility tests ───────────────────────────────────────────────

describe("computeCompatibility", () => {
  test("returns high score for compatible pair", () => {
    const [alice, bob] = makeCompatibleMalePair();
    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(50);
  });

  test("fails on gender preference mismatch", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Gender"))).toBe(true);
  });

  test("fails on age range mismatch", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      preferences: { ageMin: 35, ageMax: 45, genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { age: 28, gender: "man", city: "st. louis" },
      preferences: { ageMin: 25, ageMax: 35, genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(false);
  });

  test("fails on location mismatch", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { ageMin: 28, ageMax: 40, genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { age: 32, gender: "man", city: "chicago" },
      preferences: { ageMin: 26, ageMax: 36, genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Location"))).toBe(true);
  });

  test("fails on dealbreaker: wants kids vs doesn't want kids", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      preferences: {
        genderPreference: ["man"],
        relationshipIntent: "long-term",
        dealbreakers: ["doesn't want kids"],
      },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { wantsKids: false },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(false);
  });

  test("fails on dealbreaker: doesn't want kids vs wants kids", () => {
    // Inverse: alice doesn't want kids, bob does — should also fail
    const alice = makeUser({
      phoneHash: "hash_a2",
      preferences: {
        genderPreference: ["man"],
        relationshipIntent: "long-term",
        dealbreakers: ["wants kids"],
      },
    });
    const bob = makeUser({
      phoneHash: "hash_b2",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { wantsKids: true },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(false);
  });

  test("passes when no preferences set (open to all)", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { dealbreakers: [] },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { dealbreakers: [] },
    });

    const result = computeCompatibility(alice, bob);
    expect(result.passed).toBe(true);
  });

  test("relationship intent mismatch reduces score", () => {
    const [alice, bob] = makeCompatibleMalePair();
    const aliceChanged = { ...alice, preferences: { ...alice.preferences, relationshipIntent: "long-term" as const } };
    const bobChanged = { ...bob, preferences: { ...bob.preferences, relationshipIntent: "casual" as const } };

    const result = computeCompatibility(aliceChanged, bobChanged);
    // Should still pass (not a hard block) but score reduced
    expect(result.passed).toBe(true);
    expect(result.score).toBeLessThan(80);
  });

  test("shared interests boost score", () => {
    const alice = makeUser({
      phoneHash: "hash_a",
      personality: { interests: ["cooking", "hiking", "reading", "climbing"] },
    });
    const bob = makeUser({
      phoneHash: "hash_b",
      demographics: { gender: "man", city: "st. louis", age: 32 },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { interests: ["cooking", "hiking", "reading", "yoga"] },
    });

    const resultHighOverlap = computeCompatibility(alice, bob);

    const bobFewShared = {
      ...bob,
      personality: { ...bob.personality, interests: ["golf", "gaming"] },
    };
    const resultLowOverlap = computeCompatibility(alice, bobFewShared);

    expect(resultHighOverlap.score).toBeGreaterThan(resultLowOverlap.score);
  });

  test("same humor style boosts score", () => {
    const [alice, bob] = makeCompatibleMalePair();
    const resultSameHumor = computeCompatibility(alice, bob); // both dry

    const bobDifferentHumor = {
      ...bob,
      personality: { ...bob.personality, humorStyle: "silly" as const },
    };
    const resultDiffHumor = computeCompatibility(alice, bobDifferentHumor);

    expect(resultSameHumor.score).toBeGreaterThanOrEqual(resultDiffHumor.score);
  });
});

// ─── blockingFilter + softGaps + cross-city openness ──────────────────────────

describe("blockingFilter", () => {
  test("gender mismatch sets blockingFilter gender", () => {
    const a = makeUser({
      phoneHash: "g_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { genderPreference: ["woman"], dealbreakers: [] },
    });
    const b = makeUser({
      phoneHash: "g_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], dealbreakers: [] },
    });
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(false);
    expect(r.blockingFilter).toBe("gender");
  });

  test("age mismatch sets blockingFilter age", () => {
    const a = makeUser({
      phoneHash: "a_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { ageMin: 35, ageMax: 45, genderPreference: ["man"], dealbreakers: [] },
    });
    const b = makeUser({
      phoneHash: "a_b",
      demographics: { age: 28, gender: "man", city: "st. louis" },
      preferences: { ageMin: 25, ageMax: 40, genderPreference: ["woman"], dealbreakers: [] },
    });
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(false);
    expect(r.blockingFilter).toBe("age");
  });

  test("location mismatch sets blockingFilter location", () => {
    const a = makeUser({
      phoneHash: "l_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { genderPreference: ["man"], dealbreakers: [] },
    });
    const b = makeUser({
      phoneHash: "l_b",
      demographics: { age: 32, gender: "man", city: "chicago" },
      preferences: { genderPreference: ["woman"], dealbreakers: [] },
    });
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(false);
    expect(r.blockingFilter).toBe("location");
  });

  test("dealbreaker sets blockingFilter dealbreaker", () => {
    const a = makeUser({
      phoneHash: "d_a",
      preferences: { genderPreference: ["man"], dealbreakers: ["doesn't want kids"] },
    });
    const b = makeUser({
      phoneHash: "d_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], dealbreakers: [] },
      personality: { wantsKids: false },
    });
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(false);
    expect(r.blockingFilter).toBe("dealbreaker");
  });
});

describe("softGaps", () => {
  test("present and contains a low dim on a passing-but-thin pair", () => {
    const a = makeUser({
      phoneHash: "s_a",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { interests: ["chess"], values: ["faith"] },
    });
    const b = makeUser({
      phoneHash: "s_b",
      demographics: { age: 32, gender: "man", city: "st. louis" },
      preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { interests: ["golf"], values: ["ambition"] },
    });
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(true);
    expect(r.softGaps).toBeDefined();
    expect(r.softGaps).toContain("interests");
    expect(r.softGaps).toContain("values");
  });
});

describe("cross-city openness", () => {
  test("locationMatch passes cross-city when a opened to b's city", () => {
    const a = makeUser({
      phoneHash: "o_a",
      demographics: { city: "st. louis" },
      preferences: { locationOpenCities: ["kansas city"] },
    });
    const b = makeUser({ phoneHash: "o_b", demographics: { city: "kansas city" } });
    expect(locationMatch(a, b)).toBe(true);
  });

  test("locationMatch fails (blockingFilter location) when neither side opened", () => {
    const a = makeUser({
      phoneHash: "o_a2",
      demographics: { age: 30, gender: "woman", city: "st. louis" },
      preferences: { genderPreference: ["man"], dealbreakers: [] },
    });
    const b = makeUser({
      phoneHash: "o_b2",
      demographics: { age: 32, gender: "man", city: "kansas city" },
      preferences: { genderPreference: ["woman"], dealbreakers: [] },
    });
    expect(locationMatch(a, b)).toBe(false);
    const r = computeCompatibility(a, b);
    expect(r.passed).toBe(false);
    expect(r.blockingFilter).toBe("location");
  });
});

// ─── findTopMatches tests ─────────────────────────────────────────────────────

describe("findTopMatches", () => {
  test("returns empty array for empty user list", () => {
    expect(findTopMatches([])).toEqual([]);
  });

  test("returns empty for single user", () => {
    expect(findTopMatches([makeUser()])).toEqual([]);
  });

  test("finds compatible pair in a group", () => {
    const [alice, bob] = makeCompatibleMalePair();
    // noise user: incompatible city so cannot match with either alice or bob
    const users = [alice, bob, makeUser({
      phoneHash: "hash_noise",
      demographics: { age: 30, gender: "woman", city: "kansas city" },
      preferences: { genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    })];
    const matches = findTopMatches(users, 0);
    expect(matches.length).toBeGreaterThan(0);
    const pair = matches[0];
    const hashes = [pair.userA.phoneHash, pair.userB.phoneHash];
    expect(hashes).toContain("hash_alice");
    expect(hashes).toContain("hash_bob");
  });

  test("respects maxMatchesPerUser limit", () => {
    // Create 4 compatible users — with limit=1, each should appear at most once
    const users: UserProfile[] = [
      makeUser({
        phoneHash: "h1",
        demographics: { age: 30, gender: "woman", city: "st. louis", orientation: "straight" },
        preferences: { genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
      }),
      makeUser({
        phoneHash: "h2",
        demographics: { age: 31, gender: "woman", city: "st. louis", orientation: "straight" },
        preferences: { genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
      }),
      makeUser({
        phoneHash: "h3",
        demographics: { age: 32, gender: "man", city: "st. louis", orientation: "straight" },
        preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      }),
      makeUser({
        phoneHash: "h4",
        demographics: { age: 33, gender: "man", city: "st. louis", orientation: "straight" },
        preferences: { genderPreference: ["woman"], relationshipIntent: "long-term", dealbreakers: [] },
      }),
    ];

    const matches = findTopMatches(users, 0, 1);
    const allUserHashes = matches.flatMap((m) => [m.userA.phoneHash, m.userB.phoneHash]);
    const uniqueHashes = new Set(allUserHashes);

    // Each user should appear at most once
    expect(allUserHashes.length).toBe(uniqueHashes.size);
  });

  test("filters out pairs below min score", () => {
    const [alice, bob] = makeCompatibleMalePair();
    const matches = findTopMatches([alice, bob], 999); // impossibly high threshold
    expect(matches).toHaveLength(0);
  });

  test("sorts results by score descending", () => {
    const [alice, bob] = makeCompatibleMalePair();
    const users = [alice, bob];
    const matches = findTopMatches(users, 0);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
    }
  });

  test("does not match a user with themselves", () => {
    const alice = makeUser({ phoneHash: "hash_alice_dup" });
    // Same hash, different object
    const aliceDup = { ...alice };
    const matches = findTopMatches([alice, aliceDup], 0);
    expect(matches).toHaveLength(0);
  });
});

describe("gender vocabulary normalization (zero-match root cause)", () => {
  const { normalizeGenderTerm } = require("../scheduler/matchingJob");
  test("plural/synonym forms map to the singular gender enum", () => {
    expect(normalizeGenderTerm("men")).toBe("man");
    expect(normalizeGenderTerm("women")).toBe("woman");
    expect(normalizeGenderTerm("Male")).toBe("man");
    expect(normalizeGenderTerm("females")).toBe("woman");
    expect(normalizeGenderTerm("anyone")).toBe("any");
    expect(normalizeGenderTerm("man")).toBe("man");
  });
  test("a woman wanting 'men' matches a man (was blocked before)", () => {
    const { computeCompatibility } = require("../scheduler/matchingJob");
    const base = (gender: string, pref: string): any => ({
      phoneHash: gender + pref, active: true, onboardingComplete: true,
      demographics: { age: 30, gender, city: "st. louis", orientation: "straight" },
      preferences: { ageMin: 25, ageMax: 40, genderPreference: [pref], relationshipIntent: "long-term", dealbreakers: [] },
      personality: { interests: ["hiking"], values: ["honesty"] },
    });
    const woman = base("woman", "men");
    const man = base("man", "women");
    const r = computeCompatibility(woman, man);
    expect(r.passed).toBe(true);
  });
});

// ─── Re-match avoidance (blocked pairs) ─────────────────────────────────────────

function block(otherHash: string, reason: "declined" | "no_fit" = "declined"): BlockedMatch {
  return { phoneHash: otherHash, reason, at: Timestamp.now() };
}

describe("isPairBlocked", () => {
  test("false when neither side blocked the other", () => {
    const [a, b] = makeCompatibleMalePair();
    expect(isPairBlocked(a, b)).toBe(false);
  });

  test("true when A blocked B", () => {
    const [a, b] = makeCompatibleMalePair();
    a.blockedMatches = [block(b.phoneHash)];
    expect(isPairBlocked(a, b)).toBe(true);
  });

  test("true when only B blocked A (one-sided still blocks the pair)", () => {
    const [a, b] = makeCompatibleMalePair();
    b.blockedMatches = [block(a.phoneHash, "no_fit")];
    expect(isPairBlocked(a, b)).toBe(true);
  });

  test("ignores a block keyed to an unrelated hash", () => {
    const [a, b] = makeCompatibleMalePair();
    a.blockedMatches = [block("hash_someone_else")];
    expect(isPairBlocked(a, b)).toBe(false);
  });
});

describe("findTopMatches re-match avoidance", () => {
  test("excludes a pair blocked by A", () => {
    const [a, b] = makeCompatibleMalePair();
    a.blockedMatches = [block(b.phoneHash)];
    expect(findTopMatches([a, b], 1)).toHaveLength(0);
  });

  test("excludes a pair blocked by only ONE side (B blocked A)", () => {
    const [a, b] = makeCompatibleMalePair();
    b.blockedMatches = [block(a.phoneHash, "no_fit")];
    expect(findTopMatches([a, b], 1)).toHaveLength(0);
  });

  test("an unblocked compatible pair is still selected", () => {
    const [a, b] = makeCompatibleMalePair();
    const pairs = findTopMatches([a, b], 1);
    expect(pairs).toHaveLength(1);
  });
});
