import { Timestamp } from "firebase-admin/firestore";
import { buildOnboardingSystemPrompt, buildMatchDescription } from "../prompts/cupid";
import { UserProfile } from "../models/user";

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    phoneHash: "testhash",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    onboardingComplete: false,
    onboardingStage: "greeting",
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    demographics: {},
    preferences: {},
    personality: {},
    ...overrides,
  };
}

describe("buildOnboardingSystemPrompt", () => {
  test("includes Cupid persona for all stages", () => {
    const profile = makeProfile();
    const prompt = buildOnboardingSystemPrompt(profile, "greeting");
    expect(prompt).toContain("Cupid");
    expect(prompt).toContain("matchmaker");
  });

  test("includes correct stage guidance for greeting", () => {
    const profile = makeProfile();
    const prompt = buildOnboardingSystemPrompt(profile, "greeting");
    expect(prompt).toContain("first message");
  });

  test("includes correct stage guidance for dealbreakers stage", () => {
    const profile = makeProfile();
    const prompt = buildOnboardingSystemPrompt(profile, "dealbreakers");
    expect(prompt).toContain("dealbreaker");
  });

  test("includes profile summary when profile has data", () => {
    const profile = makeProfile({
      demographics: { age: 30, gender: "woman", city: "St. Louis" },
      personality: { interests: ["cooking", "hiking"] },
    });
    const prompt = buildOnboardingSystemPrompt(profile, "personality");
    expect(prompt).toContain("30");
    expect(prompt).toContain("St. Louis");
  });

  test("includes profile_update extraction instructions", () => {
    const profile = makeProfile();
    const prompt = buildOnboardingSystemPrompt(profile, "basics");
    expect(prompt).toContain("<profile_update>");
    expect(prompt).toContain("demographics");
    expect(prompt).toContain("personality");
  });

  test("handles complete stage", () => {
    const profile = makeProfile({ onboardingStage: "complete", onboardingComplete: true });
    const prompt = buildOnboardingSystemPrompt(profile, "complete");
    expect(prompt).toContain("complete");
  });
});

describe("buildMatchDescription", () => {
  test("returns description with age and city", () => {
    const profile = makeProfile({
      demographics: { age: 32, city: "St. Louis", orientation: "straight" },
      preferences: { relationshipIntent: "long-term" },
      personality: { interests: ["cooking", "hiking"] },
    });
    const desc = buildMatchDescription(profile);
    expect(desc).toContain("32");
    expect(desc).toContain("St. Louis");
    expect(desc).toContain("long-term");
  });

  test("includes top 3 interests", () => {
    const profile = makeProfile({
      personality: {
        interests: ["cooking", "hiking", "reading", "yoga", "travel"],
      },
    });
    const desc = buildMatchDescription(profile);
    // Should only include up to 3
    expect(desc).toContain("cooking");
    expect(desc).toContain("hiking");
    expect(desc).toContain("reading");
    expect(desc).not.toContain("yoga");
  });

  test("handles empty profile gracefully", () => {
    const profile = makeProfile();
    const desc = buildMatchDescription(profile);
    expect(desc).toBe("");
  });

  test("includes humor style when set", () => {
    const profile = makeProfile({
      personality: { humorStyle: "dry" },
      demographics: { age: 30 },
    });
    const desc = buildMatchDescription(profile);
    expect(desc).toContain("dry");
  });
});
