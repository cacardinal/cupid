import {
  buildShareBlurb,
  detectShareIntent,
  detectWingmanNumber,
  buildWingmanReply,
  buildContactCardReply,
  buildShareReply,
  handleSharingIntent,
} from "../services/sharing";
import { extractReferralCode } from "../services/referral";
import { UserProfile } from "../models/user";

// twilio is mocked so handleSharingIntent never touches the network and we can
// assert the consent-first invariant (no sends to the friend's number).
jest.mock("../services/twilio", () => ({
  sendSms: jest.fn().mockResolvedValue("SM-mock"),
  sendContactCard: jest.fn().mockResolvedValue("MM-mock"),
}));

// firebase-functions logger no-op (sharing logs wingman events)
jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilio = require("../services/twilio");

const CODE = "CUP-A1B2C3";

function fakeProfile(): UserProfile {
  return {
    phoneHash: "a1b2c3deadbeef",
    referralCode: CODE,
  } as UserProfile;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── buildShareBlurb ──────────────────────────────────────────────────────────

describe("buildShareBlurb", () => {
  const blurb = buildShareBlurb(CODE, "+13143777361");

  test("contains the referral code", () => {
    expect(blurb).toContain(CODE);
  });

  test("referral code in the blurb survives extractReferralCode round-trip", () => {
    expect(extractReferralCode(blurb)).toBe(CODE);
  });

  test("contains Cupid's number in display form", () => {
    expect(blurb).toContain("+1 (314) 377-7361");
  });

  test("tells the friend exactly what to text", () => {
    expect(blurb).toContain(`Hi Cupid ${CODE}`);
  });

  test("falls back to the default number when env and arg are absent", () => {
    const prev = process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_PHONE_NUMBER;
    expect(buildShareBlurb(CODE)).toContain("+1 (314) 377-7361");
    if (prev) process.env.TWILIO_PHONE_NUMBER = prev;
  });

  test("contains no em or en dashes", () => {
    expect(blurb).not.toMatch(/[—–]/);
  });
});

// ─── detectShareIntent ────────────────────────────────────────────────────────

describe("detectShareIntent", () => {
  const sharePositives = [
    "how do I share Cupid with someone?",
    "can I tell my friend about this",
    "I want to invite a friend",
    "what's my referral code?",
    "can you introduce you to my friend Sarah",
    "send my friend your info",
  ];

  test.each(sharePositives)("share_blurb: %s", (msg) => {
    expect(detectShareIntent(msg).kind).toBe("share_blurb");
  });

  const cardPositives = [
    "send your contact card",
    "can you send me your card?",
    "send your vcard",
    "how do I save your number",
  ];

  test.each(cardPositives)("contact_card: %s", (msg) => {
    expect(detectShareIntent(msg).kind).toBe("contact_card");
  });

  test("wingman: friend's number with intro intent", () => {
    const intent = detectShareIntent("set up my friend 314-555-0123");
    expect(intent).toEqual({ kind: "wingman_number", friendNumber: "+13145550123" });
  });

  const negatives = [
    "my friend thinks I should date more",
    "I went hiking with my friend last weekend",
    "we shared a pizza on the date",
    "can you introduce yourself",
    "my sister is visiting this weekend",
    "I'm looking for someone funny",
    "yes",
  ];

  test.each(negatives)("none: %s", (msg) => {
    expect(detectShareIntent(msg).kind).toBe("none");
  });
});

// ─── detectWingmanNumber ──────────────────────────────────────────────────────

describe("detectWingmanNumber", () => {
  test("extracts dashed number with intro intent", () => {
    expect(detectWingmanNumber("set up my friend 314-555-0123")).toBe("+13145550123");
  });

  test("extracts parenthesized number", () => {
    expect(detectWingmanNumber("introduce my coworker (314) 555-0123")).toBe("+13145550123");
  });

  test("extracts bare 10 digits", () => {
    expect(detectWingmanNumber("my buddy 3145550123 needs you")).toBe("+13145550123");
  });

  test("extracts +1 prefixed number", () => {
    expect(detectWingmanNumber("wingman duty: +1 314 555 0123")).toBe("+13145550123");
  });

  test("returns null when a number appears without intro intent", () => {
    expect(detectWingmanNumber("my new number is 314-555-0123")).toBeNull();
  });

  test("returns null with intent but no number", () => {
    expect(detectWingmanNumber("set up my friend, she's great")).toBeNull();
  });

  test("returns null on unrelated text", () => {
    expect(detectWingmanNumber("hey how are you")).toBeNull();
  });
});

// ─── Reply builders ───────────────────────────────────────────────────────────

describe("reply builders", () => {
  const replies = [
    buildShareReply(CODE),
    buildWingmanReply(CODE),
    buildContactCardReply(CODE),
  ];

  test.each(replies)("embeds the referral code: %#", (reply) => {
    expect(reply).toContain(CODE);
  });

  test.each(replies)("no em or en dashes: %#", (reply) => {
    expect(reply).not.toMatch(/[—–]/);
  });

  test("wingman reply makes the consent stance explicit", () => {
    expect(buildWingmanReply(CODE).toLowerCase()).toContain("forward");
  });
});

// ─── handleSharingIntent ──────────────────────────────────────────────────────

describe("handleSharingIntent", () => {
  const USER = "+13140000001";

  test("returns false and sends nothing on a non-sharing message", async () => {
    const handled = await handleSharingIntent(USER, "I like hiking and live music", fakeProfile());
    expect(handled).toBe(false);
    expect(twilio.sendSms).not.toHaveBeenCalled();
    expect(twilio.sendContactCard).not.toHaveBeenCalled();
  });

  test("share intent: replies to the user with a blurb containing their code", async () => {
    const handled = await handleSharingIntent(USER, "how do I share cupid?", fakeProfile());
    expect(handled).toBe(true);
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = twilio.sendSms.mock.calls[0];
    expect(to).toBe(USER);
    expect(body).toContain(CODE);
  });

  test("contact card intent: sends vCard plus blurb, both to the user", async () => {
    const handled = await handleSharingIntent(USER, "send your contact card", fakeProfile());
    expect(handled).toBe(true);
    expect(twilio.sendContactCard).toHaveBeenCalledWith(USER);
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
    expect(twilio.sendSms.mock.calls[0][0]).toBe(USER);
  });

  test("CONSENT-FIRST INVARIANT: wingman number is never texted", async () => {
    const friend = "+13145550123";
    const handled = await handleSharingIntent(
      USER,
      "set up my friend 314-555-0123",
      fakeProfile()
    );
    expect(handled).toBe(true);

    // Every outbound message goes to the user, never the friend.
    const allRecipients = [
      ...twilio.sendSms.mock.calls.map((c: string[]) => c[0]),
      ...twilio.sendContactCard.mock.calls.map((c: string[]) => c[0]),
    ];
    expect(allRecipients.length).toBeGreaterThan(0);
    for (const to of allRecipients) {
      expect(to).toBe(USER);
      expect(to).not.toBe(friend);
    }

    // The reply hands the user a forwardable blurb with their code.
    const body = twilio.sendSms.mock.calls[0][1];
    expect(body).toContain(CODE);
  });
});
