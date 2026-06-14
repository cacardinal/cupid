import { Timestamp } from "firebase-admin/firestore";
import { UserProfile } from "../models/user";

// ── In-memory scheduled_messages store backing the admin.firestore() mock ──────
interface DocRec { id: string; data: Record<string, unknown>; }
let store: DocRec[] = [];

const addMock = jest.fn(async (data: Record<string, unknown>) => {
  const id = `doc${store.length + 1}`;
  store.push({ id, data: { ...data } });
  return { id };
});
const updateMock = jest.fn(async (id: string, patch: Record<string, unknown>) => {
  const rec = store.find((d) => d.id === id);
  if (rec) Object.assign(rec.data, patch);
});

// query state captured per-call
interface FakeQuery {
  where: (field: string, op: string, val: unknown) => FakeQuery;
  limit: () => FakeQuery;
  get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>;
}
function makeQuery(): FakeQuery {
  const filters: Array<[string, string, unknown]> = [];
  const q: FakeQuery = {
    where: (field, op, val) => {
      filters.push([field, op, val]);
      return q;
    },
    limit: () => q,
    get: async () => {
      let docs = store.slice();
      for (const [field, op, val] of filters) {
        docs = docs.filter((d) => {
          const v = d.data[field];
          if (op === "==") return v === val;
          if (op === "<=") return (v as Timestamp).toMillis() <= (val as Timestamp).toMillis();
          return true;
        });
      }
      return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
    },
  };
  return q;
}

jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => ({
      add: (data: Record<string, unknown>) => addMock(data),
      doc: (id: string) => ({ update: (patch: Record<string, unknown>) => updateMock(id, patch) }),
      where: (field: string, op: string, val: unknown) => makeQuery().where(field, op, val),
      limit: () => makeQuery(),
      get: () => makeQuery().get(),
    }),
  }),
}));

jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Downstream service mocks ───────────────────────────────────────────────────
const mockGetUser = jest.fn();
const mockGetActiveMatch = jest.fn();
const mockAppendTurn = jest.fn().mockResolvedValue(undefined);
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
const mockGetPhone = jest.fn().mockResolvedValue("+13145550000");
const mockGetLastInboundAt = jest.fn().mockResolvedValue(null);
jest.mock("../services/firestore", () => ({
  getUser: (...a: unknown[]) => mockGetUser(...a),
  getActiveMatchForUser: (...a: unknown[]) => mockGetActiveMatch(...a),
  appendConversationTurn: (...a: unknown[]) => mockAppendTurn(...a),
  updateUser: (...a: unknown[]) => mockUpdateUser(...a),
  getPhoneByHash: (...a: unknown[]) => mockGetPhone(...a),
  getLastInboundAt: (...a: unknown[]) => mockGetLastInboundAt(...a),
}));
const mockSendSms = jest.fn().mockResolvedValue("sid");
jest.mock("../services/twilio", () => ({ sendSms: (...a: unknown[]) => mockSendSms(...a) }));

import {
  enqueueScheduledMessage,
  drainScheduledMessages,
} from "../scheduler/scheduledMessages";

function member(over: Partial<UserProfile> = {}): UserProfile {
  return {
    phoneHash: "m",
    createdAt: Timestamp.fromMillis(1000),
    updatedAt: Timestamp.fromMillis(1000),
    onboardingComplete: true,
    onboardingStage: "complete",
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    liveStatus: "offline",
    referralCode: "CUP-AAAAAA",
    referralCount: 0,
    demographics: {},
    preferences: {},
    personality: {},
    ...over,
  };
}

beforeEach(() => {
  store = [];
  jest.clearAllMocks();
  mockGetActiveMatch.mockResolvedValue(null);
  mockGetPhone.mockResolvedValue("+13145550000");
  mockGetLastInboundAt.mockResolvedValue(null);
});

describe("enqueueScheduledMessage", () => {
  test("writes status pending and createdAt", async () => {
    const id = await enqueueScheduledMessage({
      phoneHash: "m",
      body: "hi",
      sendAt: Timestamp.fromMillis(2000),
      kind: "rapport",
    });
    expect(id).toBe("doc1");
    expect(store[0].data.status).toBe("pending");
    expect(store[0].data.createdAt).toBeDefined();
  });
});

describe("drainScheduledMessages", () => {
  // The message is queued with an inbound anchor of 2000ms: the member's last
  // inbound turn at enqueue time. The drain skips ONLY if a newer inbound turn
  // appeared (getLastInboundAt > anchor) — never because `updatedAt` moved.
  async function seed(extra: Partial<Record<string, unknown>> = {}) {
    store.push({
      id: "doc1",
      data: {
        phoneHash: "m",
        body: "hey, how did the trip go?",
        sendAt: Timestamp.fromMillis(1),
        kind: "rapport",
        status: "pending",
        createdAt: Timestamp.fromMillis(5000),
        inboundAnchorMs: 2000,
        ...extra,
      },
    });
  }

  test("due pending message sends, appends turn, marks sent", async () => {
    await seed();
    mockGetUser.mockResolvedValue(member({ updatedAt: Timestamp.fromMillis(1000) }));
    const r = await drainScheduledMessages(true);
    expect(r.sent).toBe(1);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockAppendTurn).toHaveBeenCalledTimes(1);
    expect(store[0].data.status).toBe("sent");
  });

  test("freshness: new inbound turn after anchor -> skipped, no send", async () => {
    await seed();
    mockGetUser.mockResolvedValue(member({ updatedAt: Timestamp.fromMillis(9000) }));
    // A genuine inbound turn arrived after we queued (anchor was 2000).
    mockGetLastInboundAt.mockResolvedValue(Timestamp.fromMillis(8000));
    const r = await drainScheduledMessages(true);
    expect(r.skipped).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(store[0].data.status).toBe("skipped");
  });

  // REGRESSION (review-produced ordering): the engagement review queues the
  // message (createdAt T1) then writes its own proactive trackers, bumping the
  // member doc's updatedAt to T2 > T1. With the OLD updatedAt-vs-createdAt guard
  // this skipped every review-queued message (sent=0). The anchor is the last
  // inbound turn, which did NOT advance, so the message must still send.
  test("review bookkeeping bumped updatedAt past createdAt but no new inbound -> still sends", async () => {
    await seed();
    // updatedAt (9000) > createdAt (5000), exactly the review-produced ordering.
    mockGetUser.mockResolvedValue(member({ updatedAt: Timestamp.fromMillis(9000) }));
    // Last inbound is still the anchor value (no genuine inbound since queueing).
    mockGetLastInboundAt.mockResolvedValue(Timestamp.fromMillis(2000));
    const r = await drainScheduledMessages(true);
    expect(r.sent).toBe(1);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(store[0].data.status).toBe("sent");
  });

  test("busy match -> skipped", async () => {
    await seed();
    mockGetUser.mockResolvedValue(member({ updatedAt: Timestamp.fromMillis(1000) }));
    mockGetActiveMatch.mockResolvedValue({ status: "scheduled" });
    const r = await drainScheduledMessages(true);
    expect(r.skipped).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  test("inactive member -> skipped", async () => {
    await seed();
    mockGetUser.mockResolvedValue(member({ active: false, updatedAt: Timestamp.fromMillis(1000) }));
    const r = await drainScheduledMessages(true);
    expect(r.skipped).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  test("over weekly cap -> skipped (cadence re-check)", async () => {
    await seed();
    const now = Date.now();
    const log = [
      { at: Timestamp.fromMillis(now - 1000), kind: "rapport" as const },
      { at: Timestamp.fromMillis(now - 2000), kind: "rapport" as const },
      { at: Timestamp.fromMillis(now - 3000), kind: "rapport" as const },
    ];
    mockGetUser.mockResolvedValue(member({ updatedAt: Timestamp.fromMillis(1000), proactiveLog: log }));
    const r = await drainScheduledMessages(true);
    expect(r.skipped).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  test("one throwing doc does not abort the rest", async () => {
    store.push({
      id: "bad",
      data: { phoneHash: "bad", body: "x", sendAt: Timestamp.fromMillis(1), kind: "rapport", status: "pending", createdAt: Timestamp.fromMillis(5000) },
    });
    store.push({
      id: "good",
      data: { phoneHash: "good", body: "y", sendAt: Timestamp.fromMillis(1), kind: "rapport", status: "pending", createdAt: Timestamp.fromMillis(5000) },
    });
    mockGetUser.mockImplementation(async (hash: string) => {
      if (hash === "bad") throw new Error("boom");
      return member({ phoneHash: "good", updatedAt: Timestamp.fromMillis(1000) });
    });
    const r = await drainScheduledMessages(true);
    expect(r.sent).toBe(1);
    expect(store.find((d) => d.id === "good")!.data.status).toBe("sent");
  });
});
