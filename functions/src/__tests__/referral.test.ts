import { extractReferralCode, buildShareMessage } from "../services/referral";

// ─── extractReferralCode ───────────────────────────────────────────────────────

describe("extractReferralCode", () => {
  test("returns null for a plain greeting", () => {
    expect(extractReferralCode("Hi Cupid!")).toBeNull();
  });

  test("extracts code from 'Hi Cupid! Referred by CUP-ABCDEF'", () => {
    expect(extractReferralCode("Hi Cupid! Referred by CUP-ABCDEF")).toBe("CUP-ABCDEF");
  });

  test("normalises lowercase input to uppercase output", () => {
    expect(extractReferralCode("my code is cup-abcdef")).toBe("CUP-ABCDEF");
  });

  test("returns null for an invalid code length", () => {
    expect(extractReferralCode("CUP-ABC")).toBeNull();   // only 3 hex chars
    expect(extractReferralCode("CUP-ABCDEFG")).toBeNull(); // 7 hex chars
  });

  test("returns null for non-hex characters", () => {
    expect(extractReferralCode("CUP-XYZXYZ")).toBeNull();
  });

  test("extracts first valid code when multiple are present", () => {
    expect(extractReferralCode("codes: CUP-AABBCC CUP-DDEEFF")).toBe("CUP-AABBCC");
  });

  test("requires word boundary — does not match mid-word", () => {
    expect(extractReferralCode("XCUP-ABCDEF")).toBeNull();
  });
});

// ─── buildShareMessage ─────────────────────────────────────────────────────────

describe("buildShareMessage", () => {
  const code = "CUP-A1B2C3";
  const num = "+15550001234";
  const msg = buildShareMessage(code, num);

  test("includes the referral code", () => {
    expect(msg).toContain(code);
  });

  test("includes an sms: deep-link with the Cupid number", () => {
    expect(msg).toContain(`sms:${num}`);
  });

  test("pre-fills the code in the SMS body query param", () => {
    expect(msg).toContain(encodeURIComponent(code));
  });

  test("contains the 'bonus free intro' incentive language", () => {
    expect(msg.toLowerCase()).toContain("bonus");
  });
});
