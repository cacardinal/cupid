import { mergeProfileUpdates } from "../services/claude";
import { UserProfile } from "../models/user";
import { Timestamp } from "firebase-admin/firestore";

function baseProfile(): UserProfile {
  return {
    phoneHash: "testhash",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    onboardingComplete: false,
    onboardingStage: "basics",
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    demographics: {},
    preferences: {},
    personality: {},
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
  };
}

describe("mergeProfileUpdates", () => {
  test("returns empty object when updates is null", () => {
    const result = mergeProfileUpdates(baseProfile(), null);
    expect(result).toEqual({});
  });

  test("merges demographic fields from update", () => {
    const profile = baseProfile();
    const updates = {
      demographics: { age: 28, city: "St. Louis" },
    };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.demographics?.age).toBe(28);
    expect(merged.demographics?.city).toBe("St. Louis");
  });

  test("does not overwrite existing demographics with null", () => {
    const profile = {
      ...baseProfile(),
      demographics: { age: 30, gender: "woman" as const, city: "St. Louis" },
    };
    const updates = {
      demographics: { age: null, gender: null, city: "Chicago" },
    };
    const merged = mergeProfileUpdates(profile, updates);
    // null values should NOT overwrite existing
    expect(merged.demographics?.age).toBe(30);
    expect(merged.demographics?.gender).toBe("woman");
    // Non-null should update
    expect(merged.demographics?.city).toBe("Chicago");
  });

  test("merges personality interests (array)", () => {
    const profile = baseProfile();
    const updates = {
      personality: { interests: ["cooking", "hiking"] },
    };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.personality?.interests).toEqual(["cooking", "hiking"]);
  });

  test("merges preferences dealbreakers", () => {
    const profile = baseProfile();
    const updates = {
      preferences: { dealbreakers: ["smoker", "no kids"] },
    };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.preferences?.dealbreakers).toEqual(["smoker", "no kids"]);
  });

  test("updates onboarding stage", () => {
    const profile = baseProfile();
    const updates = { onboardingStage: "personality" };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.onboardingStage).toBe("personality");
  });

  test("updates onboardingComplete when true", () => {
    const profile = baseProfile();
    const updates = { onboardingComplete: true };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.onboardingComplete).toBe(true);
  });

  test("preserves existing personality when update adds new fields", () => {
    const profile = {
      ...baseProfile(),
      personality: {
        humorStyle: "dry" as const,
        interests: ["cooking"],
      },
    };
    const updates = {
      personality: { values: ["honesty", "family"] },
    };
    const merged = mergeProfileUpdates(profile, updates);
    expect(merged.personality?.humorStyle).toBe("dry");
    expect(merged.personality?.interests).toEqual(["cooking"]);
    expect(merged.personality?.values).toEqual(["honesty", "family"]);
  });

  test("handles empty update object gracefully", () => {
    const profile = baseProfile();
    const merged = mergeProfileUpdates(profile, {});
    expect(merged).toEqual({});
  });
});
