import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";
import {
  findNearMatches,
  isRevealCandidate,
  NEAR_MATCH_REVEAL_MIN,
} from "../services/nearMatch";

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
    demographics: { age: 30, gender: "woman", city: "st. louis", orientation: "straight" },
    preferences: {
      ageMin: 28,
      ageMax: 40,
      genderPreference: ["man"],
      relationshipIntent: "long-term",
      dealbreakers: [],
    },
    personality: {
      humorStyle: "dry",
      communicationStyle: "texter",
      values: ["family", "honesty", "adventure"],
      interests: ["cooking", "hiking", "reading"],
      personalityTraits: ["introvert"],
    },
    ...overrides,
  };
}

// A man who is a strong soft match for the default woman, varying only the blocker.
function strongMan(over: Partial<UserProfile> & { phoneHash: string }): UserProfile {
  return makeUser({
    demographics: { age: 32, gender: "man", city: "st. louis", orientation: "straight" },
    preferences: {
      ageMin: 26,
      ageMax: 40,
      genderPreference: ["woman"],
      relationshipIntent: "long-term",
      dealbreakers: [],
    },
    personality: {
      humorStyle: "dry",
      communicationStyle: "texter",
      values: ["family", "honesty", "adventure"],
      interests: ["cooking", "hiking", "reading"],
      personalityTraits: ["extrovert"],
    },
    ...over,
  });
}

describe("findNearMatches", () => {
  test("location-blocked candidate returned with openness + revealCity", () => {
    const member = makeUser({ phoneHash: "me" });
    const cand = strongMan({ phoneHash: "kc", demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" } });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(1);
    expect(near[0].blockingFilter).toBe("location");
    expect(near[0].resolvable).toBe("openness");
    expect(near[0].revealCity?.toLowerCase()).toBe("kansas city");
    expect(near[0].topic).toContain("openness:");
  });

  test("age-slack candidate (1 yr outside) returned with age_slack", () => {
    const member = makeUser({ phoneHash: "me" });
    // member ageMax 40; candidate 41 is 1 year over => slack
    const cand = strongMan({ phoneHash: "old", demographics: { age: 41, gender: "man", city: "st. louis", orientation: "straight" } });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(1);
    expect(near[0].blockingFilter).toBe("age");
    expect(near[0].resolvable).toBe("age_slack");
  });

  test("unknown-field candidate (member missing genderPreference) returned", () => {
    const member = makeUser({
      phoneHash: "me",
      preferences: { ageMin: 28, ageMax: 40, relationshipIntent: "long-term", dealbreakers: [] },
    });
    const cand = strongMan({ phoneHash: "him" });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(1);
    expect(near[0].blockingFilter).toBe("gender");
    expect(near[0].resolvable).toBe("unknown_field");
    expect(near[0].topic).toBe("gap:genderPreference");
  });

  test("two-blocker candidate (wrong city AND age way off) is NOT returned", () => {
    const member = makeUser({ phoneHash: "me" });
    const cand = strongMan({
      phoneHash: "twoblock",
      demographics: { age: 55, gender: "man", city: "kansas city", orientation: "straight" },
    });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(0);
  });

  test("hard gender mismatch is never a near-match", () => {
    const member = makeUser({ phoneHash: "me", preferences: { genderPreference: ["man"], ageMin: 28, ageMax: 40, dealbreakers: [] } });
    // candidate is a woman; member only wants men. Both sides known => unresolvable.
    const cand = makeUser({
      phoneHash: "her",
      demographics: { age: 32, gender: "woman", city: "kansas city", orientation: "straight" },
      preferences: { genderPreference: ["woman"], ageMin: 26, ageMax: 40, dealbreakers: [] },
    });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(0);
  });

  test("ranks higher softScore first and respects limit", () => {
    const member = makeUser({ phoneHash: "me" });
    const strong = strongMan({ phoneHash: "strong", demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" } });
    const weaker = strongMan({
      phoneHash: "weaker",
      demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" },
      personality: { humorStyle: "silly", communicationStyle: "caller", values: ["family"], interests: ["cooking"], personalityTraits: [] },
    });
    const near = findNearMatches(member, [weaker, strong], 1);
    expect(near).toHaveLength(1);
    expect(near[0].candidate.phoneHash).toBe("strong");
  });

  test("reveal threshold: location candidate below reveal min not flagged", () => {
    const member = makeUser({ phoneHash: "me" });
    // weak soft overlap but still >= NEAR_MATCH_SOFT_MIN? Make it borderline.
    const cand = strongMan({
      phoneHash: "lowreveal",
      demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" },
      personality: { humorStyle: "silly", communicationStyle: "caller", values: ["ambition"], interests: ["golf"], personalityTraits: [] },
    });
    const near = findNearMatches(member, [cand]);
    if (near.length) {
      // if it qualifies as a near-match at all, it should not be reveal-worthy
      expect(near[0].softScore).toBeLessThan(NEAR_MATCH_REVEAL_MIN);
      expect(isRevealCandidate(near[0])).toBe(false);
    }
  });

  test("strong location candidate is reveal-worthy", () => {
    const member = makeUser({ phoneHash: "me" });
    const cand = strongMan({ phoneHash: "kc", demographics: { age: 32, gender: "man", city: "kansas city", orientation: "straight" } });
    const near = findNearMatches(member, [cand]);
    expect(near).toHaveLength(1);
    expect(isRevealCandidate(near[0])).toBe(true);
  });
});
