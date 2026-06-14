/**
 * abuseLog (N2) tests. Fire-and-forget emitter: never throws, never rejects,
 * no-ops in DEMO_MODE, clamps evidence, writes the 6 fields + server createdAt.
 */

jest.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    now: () => ({ seconds: 111, nanoseconds: 0, __ts: true }),
  },
}));

const addMock = jest.fn();
let firestoreThrows = false;

jest.mock("firebase-admin", () => ({
  firestore: () => {
    if (firestoreThrows) throw new Error("admin.firestore boom");
    return {
      collection: (name: string) => ({
        add: (data: Record<string, unknown>) => addMock(name, data),
      }),
    };
  },
}));

import { logAbuseEvent, SYSTEM_ACTOR } from "../services/abuseLog";

const SAVED = process.env.DEMO_MODE;

beforeEach(() => {
  addMock.mockReset().mockResolvedValue({ id: "evt1" });
  firestoreThrows = false;
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  if (SAVED === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = SAVED;
});

describe("logAbuseEvent", () => {
  test("writes the 6 fields plus a server createdAt on the happy path", async () => {
    await expect(
      logAbuseEvent({
        phoneHash: "a".repeat(64),
        type: "daily_cap_breach",
        severity: "medium",
        evidence: "turn 61 over 60",
        source: "usageGuard",
      })
    ).resolves.toBeUndefined();

    expect(addMock).toHaveBeenCalledTimes(1);
    const [col, data] = addMock.mock.calls[0];
    expect(col).toBe("abuse_events");
    expect(data).toMatchObject({
      phoneHash: "a".repeat(64),
      type: "daily_cap_breach",
      severity: "medium",
      evidence: "turn 61 over 60",
      source: "usageGuard",
    });
    expect((data as { createdAt: { __ts: boolean } }).createdAt.__ts).toBe(true);
    // never pass through id
    expect(data).not.toHaveProperty("id");
  });

  test("no-ops (no .add) when DEMO_MODE is true", async () => {
    process.env.DEMO_MODE = "true";
    await expect(
      logAbuseEvent({
        phoneHash: SYSTEM_ACTOR,
        type: "contact_scrub",
        severity: "low",
        evidence: "stripped 1 url 0 phone",
        source: "outboundAllowlist",
      })
    ).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  test("never rejects when .add rejects (async failure)", async () => {
    addMock.mockRejectedValue(new Error("network"));
    await expect(
      logAbuseEvent({
        phoneHash: "x",
        type: "other",
        severity: "low",
        evidence: "e",
        source: "s",
      })
    ).resolves.toBeUndefined();
  });

  test("never throws when admin.firestore() throws (sync failure)", async () => {
    firestoreThrows = true;
    await expect(
      logAbuseEvent({
        phoneHash: "x",
        type: "other",
        severity: "low",
        evidence: "e",
        source: "s",
      })
    ).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  test("clamps evidence to 140 chars", async () => {
    await logAbuseEvent({
      phoneHash: "x",
      type: "other",
      severity: "low",
      evidence: "z".repeat(500),
      source: "s",
    });
    const [, data] = addMock.mock.calls[0];
    expect((data as { evidence: string }).evidence).toHaveLength(140);
  });

  test("SYSTEM_ACTOR is the non-user sentinel", () => {
    expect(SYSTEM_ACTOR).toBe("system");
  });
});
