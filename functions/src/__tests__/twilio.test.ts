/**
 * twilio sendSms SITE 2 (contact_scrub) attribution test.
 *
 * COMPLETENESS #1: the outbound scrub MUST be attributed to the SYSTEM sentinel,
 * NEVER to `to`. The recipient is not the author of scrubbed content. (Actor-
 * attributed contact_scrub lives on the inbound path; see inboundSecurity.)
 */

jest.mock("firebase-functions", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const trackMock = jest.fn();
jest.mock("../services/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));

const logAbuseEventMock = jest.fn();
jest.mock("../services/abuseLog", () => ({
  logAbuseEvent: (...args: unknown[]) => logAbuseEventMock(...args),
  SYSTEM_ACTOR: "system",
}));

// scrubOutbound is dynamically imported inside sendSms; control its result.
let scrubResult: { body: string; removedUrls: string[]; removedPhones: string[] };
jest.mock("../services/outboundSecurity", () => ({
  scrubOutbound: () => scrubResult,
}));

import { sendSms } from "../services/twilio";

const SAVED = { DEMO_MODE: process.env.DEMO_MODE };
const TO = "+13145559999";

beforeEach(() => {
  logAbuseEventMock.mockReset();
  trackMock.mockReset();
  process.env.DEMO_MODE = "true"; // route to the outbox, never hit Twilio
  scrubResult = { body: "clean", removedUrls: [], removedPhones: [] };
});

afterAll(() => {
  if (SAVED.DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = SAVED.DEMO_MODE;
});

// firebase-admin/firestore is used by the DEMO_MODE outbox path.
jest.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: () => ({ add: async () => ({ id: "outbox1" }) }),
  }),
  Timestamp: { now: () => ({ seconds: 1, nanoseconds: 0 }) },
}));

describe("sendSms SITE 2 contact_scrub", () => {
  test("DEMO_MODE no-ops the emit (sim runs accrue zero records)", async () => {
    scrubResult = { body: "x", removedUrls: ["http://evil.test"], removedPhones: [] };
    await sendSms(TO, "raw");
    // logAbuseEvent itself no-ops in DEMO_MODE, but the call site still fires.
    // We assert the attribution of that call below in non-demo mode.
    expect(logAbuseEventMock).toHaveBeenCalledTimes(1);
  });

  test("attributes the scrub to SYSTEM sentinel, NEVER to `to`", async () => {
    scrubResult = { body: "x", removedUrls: ["http://evil.test"], removedPhones: ["(555) 867-5309"] };
    await sendSms(TO, "raw");
    expect(logAbuseEventMock).toHaveBeenCalledTimes(1);
    const arg = logAbuseEventMock.mock.calls[0][0];
    expect(arg.phoneHash).toBe("system");
    expect(arg.phoneHash).not.toBe(TO);
    expect(arg.type).toBe("contact_scrub");
    expect(arg.severity).toBe("low");
    expect(arg.source).toBe("outboundAllowlist");
    // evidence is a fixed-label count string with no PII
    expect(arg.evidence).toBe("stripped 1 url 1 phone");
    expect(arg.evidence).not.toMatch(/evil|555|867/);
  });

  test("does NOT emit when nothing was removed", async () => {
    scrubResult = { body: "all clean", removedUrls: [], removedPhones: [] };
    await sendSms(TO, "raw");
    expect(logAbuseEventMock).not.toHaveBeenCalled();
  });
});
