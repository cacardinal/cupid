import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

// Mock the Anthropic SDK so createCompletion returns canned text.
const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: class {
      messages = { create: (...a: unknown[]) => mockCreate(...a) };
    },
  };
});

import { decideFollowUp, interpretOpenness } from "../services/claude";
import type { NearMatch } from "../services/nearMatch";
import type { ProfileGap } from "../services/profileGaps";

function txt(s: string) {
  return { content: [{ type: "text", text: s }] };
}

function member(): UserProfile {
  return {
    phoneHash: "m",
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
    preferences: { ageMin: 28, ageMax: 40, genderPreference: ["man"], relationshipIntent: "long-term", dealbreakers: [] },
    personality: { values: ["family"], interests: ["hiking"] },
  };
}

const near: NearMatch[] = [];
const gaps: ProfileGap[] = [{ field: "values", question: "What matters most?", topic: "gap:values" }];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("decideFollowUp", () => {
  test("parses a valid followUp JSON", async () => {
    mockCreate.mockResolvedValue(
      txt('{"followUp": true, "intent": "rapport", "message": "How did the climbing trip go?", "reason": "referenced detail"}')
    );
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.followUp).toBe(true);
    expect(r.intent).toBe("rapport");
    expect(r.message).toContain("climbing");
  });

  test("honors followUp:false (decline)", async () => {
    mockCreate.mockResolvedValue(txt('{"followUp": false, "intent": "rapport", "message": "", "reason": "nothing new"}'));
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.followUp).toBe(false);
  });

  test("malformed JSON fails closed (decline, no throw)", async () => {
    mockCreate.mockResolvedValue(txt("not json at all"));
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.followUp).toBe(false);
    expect(r.reason).toBe("no_json");
  });

  test("empty message fails closed", async () => {
    mockCreate.mockResolvedValue(txt('{"followUp": true, "intent": "deepen", "message": "   ", "reason": "x"}'));
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.followUp).toBe(false);
    expect(r.reason).toBe("empty_message");
  });

  test("strips em-dash from message", async () => {
    mockCreate.mockResolvedValue(
      txt('{"followUp": true, "intent": "rapport", "message": "warm — and real", "reason": "x"}')
    );
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.message).not.toContain("—");
    expect(r.message).toBe("warm, and real");
  });

  test("does not throw when the model call rejects", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const r = await decideFollowUp(member(), [], near, gaps);
    expect(r.followUp).toBe(false);
    expect(r.reason).toBe("error");
  });
});

describe("interpretOpenness", () => {
  test("intersects with candidate list and lowercases", async () => {
    mockCreate.mockResolvedValue(txt('["Kansas City", "Denver"]'));
    const r = await interpretOpenness("anywhere in missouri", "st. louis", ["kansas city", "columbia"]);
    expect(r).toEqual(["kansas city"]); // denver not in candidate list
  });

  test("bad output returns []", async () => {
    mockCreate.mockResolvedValue(txt("nope"));
    const r = await interpretOpenness("a couple hours", "st. louis", ["kansas city"]);
    expect(r).toEqual([]);
  });

  test("empty candidate list short-circuits to []", async () => {
    const r = await interpretOpenness("anywhere", "st. louis", []);
    expect(r).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
