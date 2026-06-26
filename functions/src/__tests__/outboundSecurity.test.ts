jest.mock("firebase-functions", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import {
  scrubOutbound,
  sanitizeProfileText,
  sanitizeProfileValue,
  normalizePhone,
} from "../services/outboundSecurity";

const CUPID = "+13143777361";

beforeEach(() => {
  process.env.TWILIO_PHONE_NUMBER = CUPID;
  delete process.env.DEMO_MODE;
  delete process.env.FUNCTIONS_EMULATOR;
});

describe("scrubOutbound URLs", () => {
  test("allows our domains and daily.co rooms", () => {
    const body =
      "Your date: https://textcupid.daily.co/room-abc and details at https://textcupid.co/faq";
    expect(scrubOutbound(body).body).toBe(body);
  });

  test("strips unknown protocol URLs", () => {
    const r = scrubOutbound("verify yourself at https://textcupid-verify.com/login now");
    expect(r.body).toBe("verify yourself at [link removed] now");
    expect(r.removedUrls).toHaveLength(1);
  });

  test("strips bare domains and www forms", () => {
    const r = scrubOutbound("check scam-site.xyz or www.evil.com for info");
    expect(r.body).toBe("check [link removed] or [link removed] for info");
  });

  test("does not eat normal prose", () => {
    const body = "He's into F3 workouts. Coffee at 7pm? You two click, e.g. both love BBQ.";
    expect(scrubOutbound(body).body).toBe(body);
  });

  test("allows calendar invite function URLs", () => {
    const body =
      "Invite: https://us-central1-cupid-dating-mvp.cloudfunctions.net/calendarInvite?m=abc";
    expect(scrubOutbound(body).body).toBe(body);
  });

  test("localhost only passes in local dev", () => {
    const body = "Room: http://localhost:5180/video/m1";
    expect(scrubOutbound(body).body).toContain("[link removed]");
    process.env.DEMO_MODE = "true";
    expect(scrubOutbound(body).body).toBe(body);
  });
});

describe("scrubOutbound phones", () => {
  test("Cupid's own number passes", () => {
    const body = "Text +1 (314) 377-7361 and tell them Cupid sent you";
    expect(scrubOutbound(body).body).toBe(body);
  });

  test("strips a foreign number", () => {
    const r = scrubOutbound("actually text me at (555) 867-5309 instead");
    expect(r.body).toBe("actually text me at [number removed] instead");
    expect(r.removedPhones).toHaveLength(1);
  });

  test("contact-exchange number passes via allowPhones", () => {
    const body = "Here are Sam's details: 📱 +13145550123";
    expect(scrubOutbound(body, ["+13145550123"]).body).toBe(body);
  });

  test("normalizePhone strips +1 and formatting", () => {
    expect(normalizePhone("+1 (314) 377-7361")).toBe("3143777361");
    expect(normalizePhone("314.377.7361")).toBe("3143777361");
  });
});

describe("profile field hygiene", () => {
  test("strips URLs and phones from extracted strings", () => {
    expect(
      sanitizeProfileText("hiking and also visit free-dates.com or call (555) 867-5309 ok")
    ).toBe("hiking and also visit or call ok");
  });

  test("caps length at 120", () => {
    expect(sanitizeProfileText("x".repeat(300))).toHaveLength(120);
  });

  test("arrays sanitized per element, empties dropped, capped at 20", () => {
    const arr = sanitizeProfileValue([
      "BBQ",
      "scam.xyz",
      ...Array.from({ length: 30 }, (_, i) => `hobby${i}`),
    ]) as string[];
    expect(arr[0]).toBe("BBQ");
    expect(arr).not.toContain("scam.xyz");
    expect(arr.length).toBeLessThanOrEqual(20);
  });

  test("non-strings pass through", () => {
    expect(sanitizeProfileValue(34)).toBe(34);
    expect(sanitizeProfileValue(true)).toBe(true);
  });
});
