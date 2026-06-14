/**
 * adminModeration (E6) HTTP-layer tests: rate limit (429), auth (401 + abuse
 * emit), GET list, POST resolve, POST validation (400), not-found (404), method
 * not allowed (405).
 */

// Fully chainable firebase-functions mock so importing ../index (which defines
// many functions) does not blow up. onRequest unwraps to the raw handler.
jest.mock("firebase-functions", () => {
  const noop = () => undefined;
  const schedule = () => ({ timeZone: () => ({ onRun: noop }), onRun: noop });
  const firestore = {
    document: () => ({ onUpdate: noop, onCreate: noop, onWrite: noop, onDelete: noop }),
  };
  const https = { onRequest: (handler: unknown) => handler };
  const pubsub = { schedule };
  const builder = { runWith: () => builder, https, pubsub, firestore };
  return {
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    runWith: () => builder,
    https,
    pubsub,
    firestore,
  };
});

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: () => ({}),
}));

const listMock = jest.fn();
const resolveMock = jest.fn();
jest.mock("../services/moderation", () => ({
  listModerationFlags: (...a: unknown[]) => listMock(...a),
  resolveModerationFlag: (...a: unknown[]) => resolveMock(...a),
}));

const logAbuseEventMock = jest.fn();
jest.mock("../services/abuseLog", () => ({
  logAbuseEvent: (...a: unknown[]) => logAbuseEventMock(...a),
  SYSTEM_ACTOR: "system",
}));

import { adminModeration } from "../index";

// adminModeration is unwrapped to the raw (req,res) handler by the mock above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = adminModeration as unknown as (req: any, res: any) => Promise<void>;

const SECRET = "f".repeat(64);
const SAVED = process.env.ADMIN_API_SECRET;

function makeRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 0;
  res.body = undefined;
  res.set = jest.fn(() => res);
  res.status = jest.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  res.send = jest.fn(() => res);
  return res;
}

function makeReq(over: Record<string, unknown> = {}) {
  const headers: Record<string, string> = (over.headers as Record<string, string>) ?? {};
  return {
    method: "GET",
    query: {},
    body: {},
    ip: "1.2.3.4",
    header: (h: string) => headers[h.toLowerCase()],
    ...over,
  };
}

function authHeaders(ip = "1.2.3.4") {
  return { "x-admin-secret": SECRET, "x-forwarded-for": `client, ${ip}` };
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([{ id: "f1" }]);
  resolveMock.mockReset();
  logAbuseEventMock.mockReset();
  process.env.ADMIN_API_SECRET = SECRET;
});

afterAll(() => {
  if (SAVED === undefined) delete process.env.ADMIN_API_SECRET;
  else process.env.ADMIN_API_SECRET = SAVED;
});

describe("adminModeration", () => {
  test("OPTIONS preflight returns 204", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS", headers: {} }), res);
    expect(res.statusCode).toBe(204);
  });

  test("401 when secret missing, and emits an abuse event", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { "x-forwarded-for": "client, 9.9.9.1" } }), res);
    expect(res.statusCode).toBe(401);
    expect(logAbuseEventMock).toHaveBeenCalledTimes(1);
    expect(logAbuseEventMock.mock.calls[0][0]).toMatchObject({
      phoneHash: "system",
      type: "other",
      source: "adminModeration",
    });
  });

  test("401 when secret wrong", async () => {
    const res = makeRes();
    await handler(
      makeReq({ headers: { "x-admin-secret": "wrong", "x-forwarded-for": "client, 9.9.9.2" } }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  test("GET returns flags JSON", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET", query: { status: "open" }, headers: authHeaders("2.0.0.1") }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(listMock).toHaveBeenCalledWith({ status: "open", limit: undefined });
  });

  test("POST resolve flips status", async () => {
    resolveMock.mockResolvedValue({ ok: true, flag: { id: "f1", status: "resolved" } });
    const res = makeRes();
    await handler(
      makeReq({ method: "POST", body: { flagId: "f1", status: "resolved" }, headers: authHeaders("2.0.0.2") }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith("f1", {
      status: "resolved",
      notes: undefined,
      resolvedBy: "founder",
    });
  });

  test("POST with neither status nor notes -> 400", async () => {
    const res = makeRes();
    await handler(
      makeReq({ method: "POST", body: { flagId: "f1" }, headers: authHeaders("2.0.0.3") }),
      res
    );
    expect(res.statusCode).toBe(400);
  });

  test("POST missing flagId -> 400", async () => {
    const res = makeRes();
    await handler(
      makeReq({ method: "POST", body: { status: "resolved" }, headers: authHeaders("2.0.0.4") }),
      res
    );
    expect(res.statusCode).toBe(400);
  });

  test("POST not-found -> 404", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = makeRes();
    await handler(
      makeReq({ method: "POST", body: { flagId: "nope", status: "resolved" }, headers: authHeaders("2.0.0.5") }),
      res
    );
    expect(res.statusCode).toBe(404);
  });

  test("PUT method not allowed -> 405", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "PUT", headers: authHeaders("2.0.0.6") }), res);
    expect(res.statusCode).toBe(405);
  });

  test("429 after exceeding the per-IP rate limit", async () => {
    const ip = "7.7.7.7";
    // 10 allowed, 11th is limited. Auth passes so we reach the limiter path.
    let last = makeRes();
    for (let i = 0; i < 11; i++) {
      last = makeRes();
      await handler(makeReq({ method: "GET", headers: authHeaders(ip) }), last);
    }
    expect(last.statusCode).toBe(429);
  });
});
