import { Timestamp } from "firebase-admin/firestore";
import {
  buildOnboardingSystemPrompt,
  buildMatchDescription,
  buildDecideFollowUpPrompt,
  buildOpennessInterpretationPrompt,
  buildDebriefPrompt,
  stripDashes,
} from "../prompts/cupid";
import { UserProfile } from "../models/user";
import type { NearMatch } from "../services/nearMatch";
import type { ProfileGap } from "../services/profileGaps";

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
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
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

describe("buildDecideFollowUpPrompt", () => {
  const near: NearMatch[] = [
    {
      candidate: makeProfile({ phoneHash: "c1" }),
      softScore: 70,
      blockingFilter: "location",
      resolvable: "openness",
      question: "Would you be open to meeting someone in Kansas City?",
      topic: "openness:kansas city",
      revealCity: "Kansas City",
    },
  ];
  const gaps: ProfileGap[] = [
    { field: "values", question: "What matters most to you?", topic: "gap:values" },
  ];

  test("contains CUPID_PERSONA and JSON-only instruction", () => {
    const p = buildDecideFollowUpPrompt(makeProfile(), [], near, gaps);
    expect(p).toContain("Cupid");
    expect(p).toContain("matchmaker");
    expect(p).toContain("followUp");
    expect(p).toContain("return ONLY a JSON object");
  });

  test("includes near-match revealCity and gap questions", () => {
    const p = buildDecideFollowUpPrompt(makeProfile(), [], near, gaps);
    expect(p).toContain("Kansas City");
    expect(p).toContain("What matters most to you?");
  });

  test("forbids dashes and pitch", () => {
    const p = buildDecideFollowUpPrompt(makeProfile(), [], near, gaps);
    expect(p.toLowerCase()).toContain("no em-dashes");
    expect(p.toLowerCase()).toContain("no product pitch");
  });
});

describe("buildOpennessInterpretationPrompt", () => {
  test("asks for a JSON array and lists candidate cities", () => {
    const p = buildOpennessInterpretationPrompt("I'd drive to KC", "st. louis", ["kansas city", "columbia"]);
    expect(p).toContain("JSON array");
    expect(p).toContain("kansas city");
    expect(p).toContain("columbia");
  });
});

describe("stripDashes", () => {
  test("converts em/en dash to comma-space", () => {
    expect(stripDashes("warm — specific")).toBe("warm, specific");
    expect(stripDashes("a–b")).toBe("a, b");
  });
});

describe("buildDebriefPrompt", () => {
  const profile = makeProfile({
    demographics: { age: 31, gender: "woman", city: "st. louis", orientation: "straight" },
    personality: { interests: ["climbing", "jazz"], values: ["honesty"] },
  });
  const p = buildDebriefPrompt(profile, "32 years old, in st. louis, loves hiking and bbq");

  test("includes the Cupid persona", () => {
    expect(p).toContain("You are Cupid");
  });

  test("includes the match description as date context", () => {
    expect(p).toContain("loves hiking and bbq");
  });

  test("instructs the <debrief_read> structured format", () => {
    expect(p).toContain("<debrief_read>");
    expect(p).toContain('"fit"');
    expect(p).toContain('"done"');
  });

  test("keeps profile extraction active", () => {
    expect(p).toContain("<profile_update>");
  });

  test("forbids dashes and the contact-exchange pitch here", () => {
    expect(p).toContain("NEVER use em-dashes");
    expect(p).toContain("DO NOT raise swapping numbers");
    // The debrief-specific copy (everything after the inherited persona) must be
    // dash-free at source.
    const debriefSection = p.split("PROFILE EXTRACTION")[0].split("You are checking in after their video date")[1];
    expect(debriefSection).toBeTruthy();
    expect(debriefSection).not.toMatch(/[—–]/);
  });
});
