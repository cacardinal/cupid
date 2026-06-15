import { mergeProfileUpdates, interpretDebrief, parseClaudeResponse } from "../services/claude";
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

  // Regression: wave 1-4 funnel root cause. The model sometimes emits an array
  // field as a comma-string ("hiking, biking") or bare scalar. That value later
  // hit `.join()` in buildProfileSummary and threw on every subsequent turn,
  // returning the error fallback and stalling onboarding. Coerce to an array.
  test("coerces string array-fields to arrays (interests, values, dealbreakers)", () => {
    const profile = baseProfile();
    const merged = mergeProfileUpdates(profile, {
      personality: { interests: "hiking, biking, cooking", values: "honesty" },
      preferences: { dealbreakers: "smoking; heavy drinking" },
    });
    expect(merged.personality?.interests).toEqual(["hiking", "biking", "cooking"]);
    expect(merged.personality?.values).toEqual(["honesty"]);
    expect(merged.preferences?.dealbreakers).toEqual(["smoking", "heavy drinking"]);
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

describe("interpretDebrief (<debrief_read> parser, fail-closed)", () => {
  test("parses a confident positive read to {fit, feedbackScore}", () => {
    const raw = `It really sounds like a good one.
<debrief_read>{"fit":"positive","feedbackScore":4,"done":true}</debrief_read>`;
    expect(interpretDebrief(raw)).toEqual({ fit: "positive", feedbackScore: 4 });
  });

  test("parses a negative read", () => {
    const raw = `<debrief_read>{"fit":"negative","feedbackScore":2,"done":true}</debrief_read>`;
    expect(interpretDebrief(raw)).toEqual({ fit: "negative", feedbackScore: 2 });
  });

  test("returns null when no block is present", () => {
    expect(interpretDebrief("no structured read here")).toBeNull();
  });

  test("returns null when done is not true (not yet confident)", () => {
    const raw = `<debrief_read>{"fit":"positive","feedbackScore":4,"done":false}</debrief_read>`;
    expect(interpretDebrief(raw)).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    const raw = `<debrief_read>{fit:positive,}</debrief_read>`;
    expect(interpretDebrief(raw)).toBeNull();
  });

  test("validates the fit enum (invalid fit -> null)", () => {
    const raw = `<debrief_read>{"fit":"maybe","feedbackScore":3,"done":true}</debrief_read>`;
    expect(interpretDebrief(raw)).toBeNull();
  });

  test("omits feedbackScore when out of the 1-5 range", () => {
    const raw = `<debrief_read>{"fit":"unsure","feedbackScore":9,"done":true}</debrief_read>`;
    expect(interpretDebrief(raw)).toEqual({ fit: "unsure" });
  });

  test("omits feedbackScore when not an integer", () => {
    const raw = `<debrief_read>{"fit":"positive","feedbackScore":3.5,"done":true}</debrief_read>`;
    expect(interpretDebrief(raw)).toEqual({ fit: "positive" });
  });
});

describe("parseClaudeResponse strips internal blocks from the visible message", () => {
  test("strips both profile_update and debrief_read", () => {
    const raw = `Glad it went well.
<debrief_read>{"fit":"positive","feedbackScore":5,"done":true}</debrief_read>
<profile_update>{"personality":{"interests":["climbing"]}}</profile_update>`;
    const out = parseClaudeResponse(raw);
    expect(out.message).toBe("Glad it went well.");
    expect(out.message).not.toContain("debrief_read");
    expect(out.message).not.toContain("profile_update");
    expect(out.profileUpdates).toEqual({ personality: { interests: ["climbing"] } });
  });

  test("an unterminated debrief_read block does not leak into the message", () => {
    const raw = `Sounds promising.
<debrief_read>{"fit":"positive","feedbackScore":4,"do`;
    const out = parseClaudeResponse(raw);
    expect(out.message).toBe("Sounds promising.");
    expect(out.message).not.toContain("debrief_read");
    expect(out.message).not.toContain("fit");
  });
});
