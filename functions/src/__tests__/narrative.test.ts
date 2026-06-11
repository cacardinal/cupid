import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

jest.mock("../services/claude", () => {
  const actual = jest.requireActual("../services/claude");
  return {
    ...actual,
    createCompletion: jest.fn(),
  };
});

jest.mock("../services/firestore", () => ({
  updateUser: jest.fn(),
  getConversationTurnCount: jest.fn(),
}));

import { createCompletion } from "../services/claude";
import { updateUser, getConversationTurnCount } from "../services/firestore";
import {
  shouldUpdateNarrative,
  updateNarrative,
  maybeUpdateNarrative,
  buildNarrativeSystemPrompt,
} from "../services/narrative";
import {
  buildOnboardingSystemPrompt,
  buildFriendCheckinPrompt,
} from "../prompts/cupid";

const mockCreateCompletion = createCompletion as jest.Mock;
const mockUpdateUser = updateUser as jest.Mock;
const mockGetTurnCount = getConversationTurnCount as jest.Mock;

function baseProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    phoneHash: "testhash",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    onboardingComplete: true,
    onboardingStage: "complete",
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    demographics: { age: 31, city: "St. Louis" },
    preferences: {},
    personality: { interests: ["running", "cooking"] },
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
    ...overrides,
  };
}

function modelResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

function fakeHistory(turns: number) {
  return Array.from({ length: turns }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn ${i}`,
    timestamp: Timestamp.now(),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── shouldUpdateNarrative thresholds ─────────────────────────────────────────

describe("shouldUpdateNarrative", () => {
  test("false below the minimum turn floor (12)", () => {
    expect(shouldUpdateNarrative(baseProfile(), 11)).toBe(false);
    expect(shouldUpdateNarrative(baseProfile(), 0)).toBe(false);
  });

  test("false at 12+ turns when fewer than 20 new turns since last update", () => {
    // No prior narrative: delta is totalTurnCount - 0
    expect(shouldUpdateNarrative(baseProfile(), 19)).toBe(false);
    // Prior update at 20: delta 15
    expect(
      shouldUpdateNarrative(baseProfile({ narrativeTurnCount: 20 }), 35)
    ).toBe(false);
  });

  test("true when 20+ new turns have accumulated and floor is met", () => {
    expect(shouldUpdateNarrative(baseProfile(), 20)).toBe(true);
    expect(shouldUpdateNarrative(baseProfile(), 47)).toBe(true);
    expect(
      shouldUpdateNarrative(baseProfile({ narrativeTurnCount: 20 }), 40)
    ).toBe(true);
  });

  test("exact boundary: delta of exactly 20 triggers, 19 does not", () => {
    const p = baseProfile({ narrativeTurnCount: 30 });
    expect(shouldUpdateNarrative(p, 49)).toBe(false);
    expect(shouldUpdateNarrative(p, 50)).toBe(true);
  });

  test("missing narrativeTurnCount is treated as 0", () => {
    const p = baseProfile();
    expect(p.narrativeTurnCount).toBeUndefined();
    expect(shouldUpdateNarrative(p, 20)).toBe(true);
  });
});

// ─── updateNarrative ──────────────────────────────────────────────────────────

describe("updateNarrative", () => {
  test("persists the model output with turn count and timestamp", async () => {
    mockCreateCompletion.mockResolvedValue(
      modelResponse(
        "Maya is a 31 year old nurse in St. Louis training for the Chicago marathon in October. Her sister's wedding planning is stressing her out. She has warmed up to Cupid and texts playfully."
      )
    );

    await updateNarrative("testhash", baseProfile(), fakeHistory(40), 47);

    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [hash, updates] = mockUpdateUser.mock.calls[0];
    expect(hash).toBe("testhash");
    expect(updates.narrative).toContain("Chicago marathon in October");
    expect(updates.narrativeTurnCount).toBe(47);
    expect(updates.narrativeUpdatedAt).toBeDefined();
  });

  test("uses max_tokens 200 and feeds the oldest turns plus old narrative", async () => {
    mockCreateCompletion.mockResolvedValue(modelResponse("Updated summary."));
    const profile = baseProfile({ narrative: "Old summary about marathon training." });

    await updateNarrative("testhash", profile, fakeHistory(40), 47);

    const params = mockCreateCompletion.mock.calls[0][0];
    expect(params.max_tokens).toBe(200);
    expect(params.system).toContain("Old summary about marathon training.");
    // Oldest 24 turns only: turn 0 in, turn 24+ out
    const userContent = params.messages[0].content as string;
    expect(userContent).toContain("turn 0");
    expect(userContent).toContain("turn 23");
    expect(userContent).not.toContain("turn 24");
  });

  test("never throws when the model call fails, and persists nothing", async () => {
    mockCreateCompletion.mockRejectedValue(new Error("model down"));

    await expect(
      updateNarrative("testhash", baseProfile(), fakeHistory(40), 47)
    ).resolves.toBeUndefined();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  test("never throws when the persist fails", async () => {
    mockCreateCompletion.mockResolvedValue(modelResponse("Summary."));
    mockUpdateUser.mockRejectedValue(new Error("firestore down"));

    await expect(
      updateNarrative("testhash", baseProfile(), fakeHistory(40), 47)
    ).resolves.toBeUndefined();
  });

  test("strips em and en dashes from model output before persisting", async () => {
    mockCreateCompletion.mockResolvedValue(
      modelResponse("She runs marathons — fast ones – and bakes.")
    );

    await updateNarrative("testhash", baseProfile(), fakeHistory(40), 47);

    const updates = mockUpdateUser.mock.calls[0][1];
    expect(updates.narrative).not.toMatch(/[—–]/);
    expect(updates.narrative).toContain("marathons");
  });

  test("skips persist when history is empty or output is blank", async () => {
    await updateNarrative("testhash", baseProfile(), [], 47);
    expect(mockCreateCompletion).not.toHaveBeenCalled();

    mockCreateCompletion.mockResolvedValue(modelResponse("   "));
    await updateNarrative("testhash", baseProfile(), fakeHistory(10), 47);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});

// ─── maybeUpdateNarrative orchestration ───────────────────────────────────────

describe("maybeUpdateNarrative", () => {
  test("does nothing when below threshold", async () => {
    mockGetTurnCount.mockResolvedValue(15);

    await maybeUpdateNarrative("testhash", baseProfile(), fakeHistory(15));

    expect(mockCreateCompletion).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  test("runs the update when threshold is crossed", async () => {
    mockGetTurnCount.mockResolvedValue(24);
    mockCreateCompletion.mockResolvedValue(modelResponse("Summary."));

    await maybeUpdateNarrative("testhash", baseProfile(), fakeHistory(24));

    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][1].narrativeTurnCount).toBe(24);
  });

  test("never throws when the count query fails", async () => {
    mockGetTurnCount.mockRejectedValue(new Error("count failed"));

    await expect(
      maybeUpdateNarrative("testhash", baseProfile(), fakeHistory(24))
    ).resolves.toBeUndefined();
  });
});

// ─── Prompt injection ─────────────────────────────────────────────────────────

describe("narrative prompt injection", () => {
  const NARRATIVE =
    "Maya is training for the Chicago marathon in October and stressed about her sister's wedding.";

  test("onboarding prompt includes the memory line when narrative exists", () => {
    const prompt = buildOnboardingSystemPrompt(
      baseProfile({ narrative: NARRATIVE }),
      "complete"
    );
    expect(prompt).toContain("WHAT YOU REMEMBER ABOUT THEM (older context):");
    expect(prompt).toContain(NARRATIVE);
  });

  test("onboarding prompt omits the memory line when narrative is absent", () => {
    const prompt = buildOnboardingSystemPrompt(baseProfile(), "complete");
    expect(prompt).not.toContain("WHAT YOU REMEMBER ABOUT THEM");
  });

  test("friend check-in prompt includes the memory line when narrative exists", () => {
    const prompt = buildFriendCheckinPrompt(baseProfile({ narrative: NARRATIVE }));
    expect(prompt).toContain("WHAT YOU REMEMBER ABOUT THEM (older context):");
    expect(prompt).toContain(NARRATIVE);
  });

  test("friend check-in prompt omits the memory line when narrative is absent", () => {
    const prompt = buildFriendCheckinPrompt(baseProfile());
    expect(prompt).not.toContain("WHAT YOU REMEMBER ABOUT THEM");
  });
});

// ─── Prompt hygiene ───────────────────────────────────────────────────────────

describe("narrative system prompt", () => {
  test("contains no em or en dashes (brand rule)", () => {
    expect(buildNarrativeSystemPrompt("old summary")).not.toMatch(/[—–]/);
    expect(buildNarrativeSystemPrompt(undefined)).not.toMatch(/[—–]/);
  });

  test("mentions the previous summary placeholder when none exists", () => {
    expect(buildNarrativeSystemPrompt(undefined)).toContain("none yet");
    expect(buildNarrativeSystemPrompt("She bakes.")).toContain("She bakes.");
  });
});
