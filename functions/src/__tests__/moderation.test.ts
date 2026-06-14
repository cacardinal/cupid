/**
 * moderation (N4) tests. listModerationFlags default/all/clamp/order;
 * resolveModerationFlag not-found / resolve-stamps / re-open-clears / notes-clamp
 * / invalid-status.
 */

jest.mock("firebase-admin/firestore", () => ({
  Timestamp: { now: () => ({ seconds: 222, nanoseconds: 0, __ts: true }) },
}));

// ── Query spy harness ──────────────────────────────────────────────────────────
const queryCalls: {
  where?: [string, string, unknown];
  orderBy?: [string, string];
  limit?: number;
} = {};
let listDocs: Array<{ id: string; data: Record<string, unknown> }> = [];

// ── Transaction harness ─────────────────────────────────────────────────────────
let txDoc: { exists: boolean; id: string; data: () => Record<string, unknown> };
let txUpdate: jest.Mock;
// ── Upsert harness ──────────────────────────────────────────────────────────────
let addMock: jest.Mock;
let refUpdateMock: jest.Mock;

jest.mock("firebase-admin", () => {
  const makeQuery = () => {
    const q: Record<string, unknown> = {};
    q.where = (f: string, op: string, v: unknown) => {
      queryCalls.where = [f, op, v];
      return q;
    };
    q.orderBy = (f: string, dir: string) => {
      queryCalls.orderBy = [f, dir];
      return q;
    };
    q.limit = (n: number) => {
      queryCalls.limit = n;
      return q;
    };
    q.get = async () => ({
      empty: listDocs.length === 0,
      docs: listDocs.map((d) => ({
        id: d.id,
        data: () => d.data,
        ref: { update: (u: unknown) => refUpdateMock(d.id, u) },
      })),
    });
    return q;
  };

  return {
    firestore: () => ({
      collection: () => ({
        ...makeQuery(),
        doc: (id: string) => ({ __docId: id }),
        add: (data: unknown) => addMock(data),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async () => txDoc,
          update: (...args: unknown[]) => txUpdate(...args),
        };
        return fn(tx);
      },
    }),
  };
});

import {
  listModerationFlags,
  resolveModerationFlag,
  upsertModerationFlag,
} from "../services/moderation";

beforeEach(() => {
  queryCalls.where = undefined;
  queryCalls.orderBy = undefined;
  queryCalls.limit = undefined;
  listDocs = [{ id: "f1", data: { phoneHash: "abc", status: "open" } }];
  txUpdate = jest.fn();
  addMock = jest.fn(async () => ({ id: "new1" }));
  refUpdateMock = jest.fn(async () => undefined);
});

describe("listModerationFlags", () => {
  test("default status open, default limit 50, newest-first", async () => {
    const out = await listModerationFlags();
    expect(queryCalls.where).toEqual(["status", "==", "open"]);
    expect(queryCalls.orderBy).toEqual(["createdAt", "desc"]);
    expect(queryCalls.limit).toBe(50);
    expect(out[0].id).toBe("f1");
  });

  test('status "all" omits the where clause', async () => {
    await listModerationFlags({ status: "all" });
    expect(queryCalls.where).toBeUndefined();
  });

  test("resolved status filters on resolved", async () => {
    await listModerationFlags({ status: "resolved" });
    expect(queryCalls.where).toEqual(["status", "==", "resolved"]);
  });

  test("limit clamps: 0 -> 1, 999 -> 200", async () => {
    await listModerationFlags({ limit: 0 });
    expect(queryCalls.limit).toBe(1);
    await listModerationFlags({ limit: 999 });
    expect(queryCalls.limit).toBe(200);
  });
});

describe("resolveModerationFlag", () => {
  test("not-found path", async () => {
    txDoc = { exists: false, id: "x", data: () => ({}) };
    const r = await resolveModerationFlag("x", { resolvedBy: "founder" });
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  test("invalid status rejected before any read", async () => {
    const r = await resolveModerationFlag("f1", {
      // @ts-expect-error testing runtime guard
      status: "bogus",
      resolvedBy: "founder",
    });
    expect(r).toEqual({ ok: false, reason: "invalid_status" });
  });

  test("resolve stamps resolvedAt + resolvedBy", async () => {
    txDoc = { exists: true, id: "f1", data: () => ({ status: "open" }) };
    const r = await resolveModerationFlag("f1", { status: "resolved", resolvedBy: "founder" });
    expect(r.ok).toBe(true);
    const [, updates] = txUpdate.mock.calls[0];
    expect(updates.status).toBe("resolved");
    expect(updates.resolvedBy).toBe("founder");
    expect(updates.resolvedAt).toBeTruthy();
  });

  test("re-open clears resolvedAt + resolvedBy", async () => {
    txDoc = { exists: true, id: "f1", data: () => ({ status: "resolved" }) };
    const r = await resolveModerationFlag("f1", { status: "open", resolvedBy: "founder" });
    expect(r.ok).toBe(true);
    const [, updates] = txUpdate.mock.calls[0];
    expect(updates.status).toBe("open");
    expect(updates.resolvedAt).toBeNull();
    expect(updates.resolvedBy).toBeNull();
  });

  test("notes clamp to 2000", async () => {
    txDoc = { exists: true, id: "f1", data: () => ({ status: "open" }) };
    await resolveModerationFlag("f1", { notes: "z".repeat(5000), resolvedBy: "founder" });
    const [, updates] = txUpdate.mock.calls[0];
    expect(updates.notes).toHaveLength(2000);
  });

  test("notes-only update does not touch status", async () => {
    txDoc = { exists: true, id: "f1", data: () => ({ status: "open" }) };
    await resolveModerationFlag("f1", { notes: "looked into it", resolvedBy: "founder" });
    const [, updates] = txUpdate.mock.calls[0];
    expect(updates).not.toHaveProperty("status");
    expect(updates.notes).toBe("looked into it");
  });
});

describe("upsertModerationFlag", () => {
  const input = {
    phoneHash: "abc",
    types: ["injection_attempt", "freeloader"] as never,
    severity: "high" as never,
    eventCount: 4,
    evidence: ["inbound injection heuristic matched"],
  };

  test("creates a new open flag when none exists for the phoneHash", async () => {
    listDocs = []; // no existing open flag -> snap.empty
    const flag = await upsertModerationFlag(input);
    expect(addMock).toHaveBeenCalledTimes(1);
    const [created] = addMock.mock.calls[0];
    expect(created.phoneHash).toBe("abc");
    expect(created.status).toBe("open");
    expect(created.notes).toBe("");
    expect(created.resolvedAt).toBeNull();
    expect(flag.id).toBe("new1");
    expect(refUpdateMock).not.toHaveBeenCalled();
  });

  test("merges into the existing open flag (no new doc) preserving identity", async () => {
    listDocs = [{ id: "f1", data: { phoneHash: "abc", status: "open", notes: "keep" } }];
    const flag = await upsertModerationFlag(input);
    expect(addMock).not.toHaveBeenCalled();
    expect(refUpdateMock).toHaveBeenCalledTimes(1);
    const [docId, updates] = refUpdateMock.mock.calls[0];
    expect(docId).toBe("f1");
    expect(updates.severity).toBe("high");
    expect(updates.eventCount).toBe(4);
    expect(updates).not.toHaveProperty("status"); // status/notes preserved
    expect(flag.id).toBe("f1");
  });

  test("dedupes types and clamps evidence to 20", async () => {
    listDocs = [];
    await upsertModerationFlag({
      ...input,
      types: ["freeloader", "freeloader", "other"] as never,
      evidence: Array.from({ length: 50 }, (_, i) => `e${i}`),
    });
    const [created] = addMock.mock.calls[0];
    expect(created.types).toEqual(["freeloader", "other"]);
    expect(created.evidence).toHaveLength(20);
  });
});
