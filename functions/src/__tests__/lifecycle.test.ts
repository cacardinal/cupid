/**
 * Date-lifecycle behavior tests driven through the real SMS webhook
 * (handleInboundSms -> handleMatchResponse / handleDebriefReply). Covers the
 * contact-exchange both-consent gate, the mutual-decline gate, debrief profile
 * extraction, the both-positive offer, the non-positive no_fit + block path, and
 * the getPhoneByHash-null graceful path.
 *
 * The single hard PII invariant: a real phone number is sent in exactly one
 * place (sendContactExchangeMessage) and ONLY when both sides consented. These
 * tests assert no number-bearing send on single-side consent.
 */

import { Request, Response } from "firebase-functions";

// ── firestore mock (controllable per test) ─────────────────────────────────────
const fs = {
  getOrCreateUser: jest.fn(),
  getConversationHistory: jest.fn().mockResolvedValue([]),
  appendConversationTurn: jest.fn().mockResolvedValue(undefined),
  updateUser: jest.fn().mockResolvedValue(undefined),
  getUser: jest.fn(),
  getActiveMatchForUser: jest.fn(),
  updateMatchStatus: jest.fn().mockResolvedValue(undefined),
  updateMatchRecord: jest.fn().mockResolvedValue(undefined),
  getMatchBetween: jest.fn(),
  getMatchRecord: jest.fn(),
  getPhoneByHash: jest.fn(),
};
jest.mock("../services/firestore", () => fs);

// ── twilio mock ─────────────────────────────────────────────────────────────────
const twilio = {
  sendSms: jest.fn().mockResolvedValue("sid"),
  sendVideoRoomLink: jest.fn().mockResolvedValue("sid"),
  sendContactExchangeMessage: jest.fn().mockResolvedValue("sid"),
  sendDeclinedMessage: jest.fn().mockResolvedValue("sid"),
};
jest.mock("../services/twilio", () => twilio);

// ── claude mock ─────────────────────────────────────────────────────────────────
const claude = {
  generateConversationReply: jest.fn(),
  generateDebriefReply: jest.fn(),
  detectIntent: jest.fn(),
  mergeProfileUpdates: jest.fn().mockReturnValue({}),
  generateVoicedMessage: jest.fn().mockResolvedValue("voiced"),
};
jest.mock("../services/claude", () => claude);

// ── inbound security (statically dynamic-imported inside the handler) ────────────
jest.mock("../services/inboundSecurity", () => ({
  verifyTwilioRequest: () => true,
  sanitizeInboundBody: (s: string) => s,
  hasMedia: () => false,
  MEDIA_DECLINED_MESSAGE: "no media",
  detectInjection: () => false,
  detectContactShare: () => false,
  detectOffMission: () => false,
}));

// ── sharing / campaign / usage / referral / narrative (no-op for these paths) ────
jest.mock("../services/sharing", () => ({ handleSharingIntent: jest.fn().mockResolvedValue(false) }));
jest.mock("../services/campaignCodes", () => ({
  detectCampaignCode: jest.fn().mockResolvedValue(null),
  redeemCampaignCode: jest.fn(),
  buildCampaignConfirmation: jest.fn(),
}));
jest.mock("../services/referral", () => ({
  extractReferralCode: () => null,
  processReferral: jest.fn(),
  buildShareMessage: jest.fn(),
}));
jest.mock("../services/liveMatching", () => ({ setUserLive: jest.fn(), setUserOffline: jest.fn() }));
jest.mock("../services/daily", () => ({ createAnonymousRoom: jest.fn() }));
jest.mock("../services/analytics", () => ({ track: jest.fn() }));
jest.mock("../services/abuseLog", () => ({ logAbuseEvent: jest.fn(), SYSTEM_ACTOR: "system" }));

jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { handleInboundSms } from "../webhooks/sms";

const ME = "abc11111";       // this side hash
const OTHER = "def22222";    // other side hash
const MY_PHONE = "+13145550001";
const OTHER_PHONE = "+13145550002";

function onboardedProfile(phoneHash = ME) {
  return {
    phoneHash,
    onboardingComplete: true,
    onboardingStage: "complete",
    liveStatus: "offline",
    demographics: {},
    preferences: {},
    personality: {},
    blockedMatches: [],
    creditsRemaining: 1,
    referralCode: "CUP-AAAAAA",
  };
}

function res(): Response {
  return { status: () => ({ send: () => undefined }) } as unknown as Response;
}
function req(body: string): Request {
  return { body: { From: MY_PHONE, Body: body } } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.getConversationHistory.mockResolvedValue([]);
  fs.appendConversationTurn.mockResolvedValue(undefined);
  fs.updateUser.mockResolvedValue(undefined);
  fs.updateMatchRecord.mockResolvedValue(undefined);
  fs.updateMatchStatus.mockResolvedValue(undefined);
  claude.mergeProfileUpdates.mockReturnValue({});
  fs.getOrCreateUser.mockResolvedValue({ profile: onboardedProfile(), isNew: false });
});

// Returns true if any send call carried a real phone number in its text/args.
function aNumberWasSent(): boolean {
  if (twilio.sendContactExchangeMessage.mock.calls.length > 0) return true;
  for (const call of twilio.sendSms.mock.calls) {
    const body = String(call[1] ?? "");
    if (body.includes(OTHER_PHONE) || body.includes(MY_PHONE)) return true;
  }
  return false;
}

describe("contact exchange both-consent gate", () => {
  test("single-side consent NEVER sends a number", async () => {
    // This side is on the contact OFFER (video_expired) and says yes; other side
    // has NOT consented yet.
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1", status: "video_expired", matchedUserId: OTHER,
    });
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "video_expired", contactExchanged: false });
    claude.detectIntent.mockResolvedValue("yes");

    await handleInboundSms(req("yes"), res());

    expect(twilio.sendContactExchangeMessage).not.toHaveBeenCalled();
    expect(aNumberWasSent()).toBe(false);
    // This side flips to contact_shared and is told we're waiting.
    expect(fs.updateMatchRecord).toHaveBeenCalledWith(ME, "m1", expect.objectContaining({
      contactExchanged: true, status: "contact_shared",
    }));
  });

  test("both consented -> each side gets the OTHER's real number", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1", status: "video_expired", matchedUserId: OTHER,
    });
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "video_expired", contactExchanged: true });
    claude.detectIntent.mockResolvedValue("yes");
    fs.getPhoneByHash.mockImplementation((h: string) =>
      Promise.resolve(h === ME ? MY_PHONE : OTHER_PHONE)
    );

    await handleInboundSms(req("yes"), res());

    expect(twilio.sendContactExchangeMessage).toHaveBeenCalledTimes(2);
    // Each person is texted the OTHER's number.
    expect(twilio.sendContactExchangeMessage).toHaveBeenCalledWith(MY_PHONE, "your match", OTHER_PHONE);
    expect(twilio.sendContactExchangeMessage).toHaveBeenCalledWith(OTHER_PHONE, "your match", MY_PHONE);
  });

  test("getPhoneByHash null -> no crash, no number, graceful follow-up", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1", status: "video_expired", matchedUserId: OTHER,
    });
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "video_expired", contactExchanged: true });
    claude.detectIntent.mockResolvedValue("yes");
    fs.getPhoneByHash.mockResolvedValue(null); // cannot resolve a number

    await expect(handleInboundSms(req("yes"), res())).resolves.toBeUndefined();
    expect(twilio.sendContactExchangeMessage).not.toHaveBeenCalled();
    expect(aNumberWasSent()).toBe(false);
  });
});

describe("mutual-decline gate", () => {
  test("other side already declined -> no scheduling, warm close, block written", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1", status: "proposed", matchedUserId: OTHER,
    });
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "user_declined" });
    fs.getUser.mockImplementation((h: string) => Promise.resolve(onboardedProfile(h)));
    claude.detectIntent.mockResolvedValue("yes");

    await handleInboundSms(req("yes"), res());

    // No advance to scheduling: status goes no_fit, the pair is blocked.
    expect(fs.updateMatchStatus).toHaveBeenCalledWith(ME, "m1", "no_fit");
    // blockPair updates both users' blockedMatches.
    const blockWrites = fs.updateUser.mock.calls.filter(
      (c) => (c[1] as { blockedMatches?: unknown }).blockedMatches !== undefined
    );
    expect(blockWrites.length).toBe(2);
    // The mutual-decline line is now voiced (LLM), and no slots message went out.
    const sent = twilio.sendSms.mock.calls.map((c) => String(c[1]));
    expect(claude.generateVoicedMessage).toHaveBeenCalled();
    expect(sent.some((m) => /find a time/i.test(m))).toBe(false);
  });
});

describe("debrief stage", () => {
  function debriefActive() {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1", status: "debriefing", matchedUserId: OTHER, debriefTurnCount: 0,
    });
    fs.getUser.mockResolvedValue(onboardedProfile(OTHER));
  }

  test("every debrief reply runs mergeProfileUpdates (extraction stays active)", async () => {
    debriefActive();
    claude.generateDebriefReply.mockResolvedValue({
      message: "tell me more",
      profileUpdates: { personality: { interests: ["pottery"] } },
      debriefRead: null, // not confident yet
    });
    claude.mergeProfileUpdates.mockReturnValue({ personality: { interests: ["pottery"] } });

    await handleInboundSms(req("it was nice"), res());

    expect(claude.generateDebriefReply).toHaveBeenCalled();
    expect(claude.mergeProfileUpdates).toHaveBeenCalledWith(
      expect.anything(),
      { personality: { interests: ["pottery"] } }
    );
    expect(fs.updateUser).toHaveBeenCalledWith(ME, { personality: { interests: ["pottery"] } });
    // Stage continues: no feedback_given write.
    const fgWrite = fs.updateMatchRecord.mock.calls.find(
      (c) => (c[2] as { status?: string }).status === "feedback_given"
    );
    expect(fgWrite).toBeUndefined();
  });

  test("both-positive debrief -> contact OFFER sent, both -> video_expired, no number", async () => {
    debriefActive();
    claude.generateDebriefReply.mockResolvedValue({
      message: "love that",
      profileUpdates: null,
      debriefRead: { fit: "positive", feedbackScore: 5 },
    });
    // After this side writes feedback_given, sideIsPositive reads it back:
    fs.getMatchRecord.mockResolvedValue({ id: "m1", fit: "positive" });
    // Other side already finished positive.
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "feedback_given", fit: "positive" });
    fs.getPhoneByHash.mockImplementation((h: string) =>
      Promise.resolve(h === ME ? MY_PHONE : OTHER_PHONE)
    );

    await handleInboundSms(req("i'd see them again"), res());

    // Both sides moved to the offer state.
    expect(fs.updateMatchRecord).toHaveBeenCalledWith(ME, "m1", { status: "video_expired" });
    expect(fs.updateMatchRecord).toHaveBeenCalledWith(OTHER, "m2", { status: "video_expired" });
    // The offer is a yes/no prompt, NOT a number.
    expect(twilio.sendContactExchangeMessage).not.toHaveBeenCalled();
    expect(aNumberWasSent()).toBe(false);
  });

  test("non-positive debrief -> both no_fit + blockPair", async () => {
    debriefActive();
    claude.generateDebriefReply.mockResolvedValue({
      message: "got it",
      profileUpdates: null,
      debriefRead: { fit: "negative", feedbackScore: 2 },
    });
    fs.getMatchRecord.mockResolvedValue({ id: "m1", fit: "negative" });
    fs.getMatchBetween.mockResolvedValue({ id: "m2", status: "feedback_given", fit: "positive" });
    fs.getUser.mockImplementation((h: string) => Promise.resolve(onboardedProfile(h)));
    fs.getPhoneByHash.mockImplementation((h: string) =>
      Promise.resolve(h === ME ? MY_PHONE : OTHER_PHONE)
    );

    await handleInboundSms(req("not really feeling it"), res());

    expect(fs.updateMatchStatus).toHaveBeenCalledWith(ME, "m1", "no_fit");
    expect(fs.updateMatchStatus).toHaveBeenCalledWith(OTHER, "m2", "no_fit");
    // blockPair wrote both sides' blockedMatches.
    const blockWrites = fs.updateUser.mock.calls.filter(
      (c) => (c[1] as { blockedMatches?: unknown }).blockedMatches !== undefined
    );
    expect(blockWrites.length).toBe(2);
    expect(aNumberWasSent()).toBe(false);
  });
});
