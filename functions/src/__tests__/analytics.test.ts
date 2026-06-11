import * as crypto from "crypto";
import { track, toDistinctId, AnalyticsEvents } from "../services/analytics";

// ─── Env + fetch harness ──────────────────────────────────────────────────────

const ENV_KEYS = ["POSTHOG_API_KEY", "POSTHOG_HOST", "DEMO_MODE"] as const;
const savedEnv: Record<string, string | undefined> = {};

let fetchMock: jest.Mock;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  (global as Record<string, unknown>).fetch = fetchMock;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const HASH = "a".repeat(64); // shaped like a real phoneHash

// ─── No-op guards ─────────────────────────────────────────────────────────────

describe("track — no-op guards", () => {
  test("no-ops (no fetch) when POSTHOG_API_KEY is missing", async () => {
    await expect(track("message_received", HASH)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("no-ops (no fetch) in DEMO_MODE even when key is set", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.DEMO_MODE = "true";
    await expect(track("message_sent", HASH)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Capture shape ────────────────────────────────────────────────────────────

describe("track — configured", () => {
  test("fires fetch with the PostHog single-event capture shape", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    await track("match_accepted", HASH, { matchId: "m1", score: 72 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/capture/");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.signal).toBeInstanceOf(AbortSignal); // 3s timeout wired up

    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "match_accepted",
      distinct_id: HASH,
      properties: { matchId: "m1", score: 72 },
    });
    expect(typeof body.timestamp).toBe("string");
  });

  test("respects POSTHOG_HOST override (trailing slash trimmed)", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.POSTHOG_HOST = "https://eu.i.posthog.com/";
    await track("user_created", HASH);
    expect(fetchMock.mock.calls[0][0]).toBe("https://eu.i.posthog.com/capture/");
  });

  test("sends empty properties object when none given", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    await track("onboarding_completed", HASH);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).properties).toEqual({});
  });
});

// ─── Never rejects ────────────────────────────────────────────────────────────

describe("track — never rejects", () => {
  test("resolves even when fetch rejects", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(track("message_sent", HASH)).resolves.toBeUndefined();
  });

  test("resolves even when fetch throws synchronously", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    (global as Record<string, unknown>).fetch = jest.fn(() => {
      throw new Error("fetch exploded");
    });
    await expect(track("message_sent", HASH)).resolves.toBeUndefined();
  });
});

// ─── distinctId safety ────────────────────────────────────────────────────────

describe("toDistinctId — never a raw phone", () => {
  test("passes a 64-char phoneHash through unchanged", () => {
    expect(toDistinctId(HASH)).toBe(HASH);
  });

  test("hashes a raw E.164 phone to the firestore phoneHash scheme", () => {
    const phone = "+13145551234";
    const expected = crypto.createHash("sha256").update(phone).digest("hex");
    const id = toDistinctId(phone);
    expect(id).toBe(expected);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).not.toContain("314555");
  });

  test("normalizes 10-digit and formatted US numbers to the same hash", () => {
    const expected = crypto.createHash("sha256").update("+13145551234").digest("hex");
    expect(toDistinctId("3145551234")).toBe(expected);
    expect(toDistinctId("(314) 555-1234")).toBe(expected);
  });

  test("track never sends a phone-shaped distinct_id", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    await track("message_sent", "+13145551234", { length: 42 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.distinct_id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain("314555");
  });
});

// ─── Catalogue ────────────────────────────────────────────────────────────────

describe("AnalyticsEvents catalogue", () => {
  test("contains the full funnel", () => {
    expect(Object.values(AnalyticsEvents).sort()).toEqual(
      [
        "user_created",
        "onboarding_completed",
        "message_received",
        "message_sent",
        "match_proposed",
        "match_accepted",
        "match_declined",
        "date_scheduled",
        "video_room_opened",
        "contact_exchanged",
        "referral_redeemed",
        "checkin_sent",
        "payment_required_shown",
      ].sort()
    );
  });
});
