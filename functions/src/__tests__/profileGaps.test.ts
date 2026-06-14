import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";
import { profileGaps } from "../services/profileGaps";

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    phoneHash: "h",
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
      dealbreakers: ["smoker"],
    },
    personality: {
      values: ["family", "honesty"],
      interests: ["cooking", "hiking"],
      wantsKids: true,
    },
    ...overrides,
  };
}

describe("profileGaps", () => {
  test("rich profile returns []", () => {
    expect(profileGaps(makeUser())).toEqual([]);
  });

  test("missing relationshipIntent ranks above thin values", () => {
    const u = makeUser({
      preferences: { ageMin: 28, ageMax: 40, genderPreference: ["man"], dealbreakers: ["smoker"] },
      personality: { values: [], interests: ["cooking", "hiking"], wantsKids: true },
    });
    const gaps = profileGaps(u);
    const fields = gaps.map((g) => g.field);
    expect(fields).toContain("relationshipIntent");
    expect(fields).toContain("values");
    expect(fields.indexOf("relationshipIntent")).toBeLessThan(fields.indexOf("values"));
  });

  test("missing basics (ageRange/genderPreference) come first", () => {
    const u = makeUser({
      preferences: { dealbreakers: [] },
      personality: { values: [], interests: [], wantsKids: undefined },
    });
    const gaps = profileGaps(u);
    expect(gaps[0].field).toBe("ageRange");
    expect(gaps[1].field).toBe("genderPreference");
  });

  test("each gap has a stable topic", () => {
    const u = makeUser({
      preferences: {},
      personality: {},
    });
    const gaps = profileGaps(u);
    for (const g of gaps) {
      expect(g.topic).toBe(`gap:${g.field}`);
    }
  });
});
