/**
 * Campaign code tests.
 *
 * Firestore is mocked with a tiny in-memory store (path -> data) defined inside
 * the jest.mock factory, exposed via __store/__reset on the mocked module.
 */

jest.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    now: () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }),
  },
}));

jest.mock("firebase-admin", () => {
  const store = new Map<string, Record<string, unknown>>();

  const makeSnap = (path: string) => ({
    exists: store.has(path),
    id: path.split("/").pop(),
    data: () => store.get(path),
  });

  class FakeDocRef {
    constructor(public path: string) {}
    get id() {
      return this.path.split("/").pop();
    }
    collection(name: string) {
      return new FakeCollectionRef(`${this.path}/${name}`);
    }
    async get() {
      return makeSnap(this.path);
    }
    async set(data: Record<string, unknown>) {
      store.set(this.path, { ...data });
    }
    async update(data: Record<string, unknown>) {
      if (!store.has(this.path)) throw new Error(`No document at ${this.path}`);
      store.set(this.path, { ...store.get(this.path), ...data });
    }
  }

  class FakeCollectionRef {
    constructor(public path: string) {}
    doc(id: string) {
      return new FakeDocRef(`${this.path}/${id}`);
    }
  }

  const fakeDb = {
    collection: (name: string) => new FakeCollectionRef(name),
    getAll: async (...refs: FakeDocRef[]) => refs.map((r) => makeSnap(r.path)),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: FakeDocRef) => makeSnap(ref.path),
        set: (ref: FakeDocRef, data: Record<string, unknown>) => {
          store.set(ref.path, { ...data });
        },
        create: (ref: FakeDocRef, data: Record<string, unknown>) => {
          if (store.has(ref.path)) throw new Error(`Already exists: ${ref.path}`);
          store.set(ref.path, { ...data });
        },
        update: (ref: FakeDocRef, data: Record<string, unknown>) => {
          if (!store.has(ref.path)) throw new Error(`No document at ${ref.path}`);
          store.set(ref.path, { ...store.get(ref.path), ...data });
        },
      };
      return fn(tx);
    },
  };

  return {
    firestore: () => fakeDb,
    __store: store,
    __reset: () => store.clear(),
  };
});

import * as admin from "firebase-admin";
import {
  createCampaignCode,
  detectCampaignCode,
  redeemCampaignCode,
  extractCandidateTokens,
  buildCampaignConfirmation,
} from "../services/campaignCodes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: Map<string, Record<string, unknown>> = (admin as any).__store;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resetStore: () => void = (admin as any).__reset;

const USER_HASH = "a".repeat(64);

function seedUser(phoneHash = USER_HASH, creditsRemaining = 1): void {
  store.set(`users/${phoneHash}`, { phoneHash, creditsRemaining });
}

beforeEach(() => {
  resetStore();
});

// ─── extractCandidateTokens (detection tokenization) ──────────────────────────

describe("extractCandidateTokens", () => {
  test("extracts 4-12 char alphanumeric words, uppercased", () => {
    expect(extractCandidateTokens("hey TEXTCUPID friend")).toEqual([
      "TEXTCUPID",
      "FRIEND",
    ]);
  });

  test("is case-insensitive (lowercase input uppercased)", () => {
    expect(extractCandidateTokens("textcupid")).toEqual(["TEXTCUPID"]);
  });

  test("skips tokens shorter than 4 or longer than 12 chars", () => {
    expect(extractCandidateTokens("hi ab abc ABCDEFGHIJKLM")).toEqual([]);
  });

  test("skips pure-number tokens", () => {
    expect(extractCandidateTokens("12345 CODE2024")).toEqual(["CODE2024"]);
  });

  test("splits on punctuation and whitespace", () => {
    expect(extractCandidateTokens("use code: TEXTCUPID, thanks")).toEqual([
      "CODE",
      "TEXTCUPID",
      "THANKS",
    ]);
  });

  test("de-duplicates tokens", () => {
    expect(extractCandidateTokens("CUPID cupid Cupid")).toEqual(["CUPID"]);
  });

  test("caps lookups at 5 tokens per message", () => {
    const msg = "alpha bravo charlie delta echo foxtrot golf";
    expect(extractCandidateTokens(msg)).toHaveLength(5);
  });
});

// ─── detectCampaignCode ────────────────────────────────────────────────────────

describe("detectCampaignCode", () => {
  test("finds an active code anywhere in the message", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    const found = await detectCampaignCode("hey there, my friend said TEXTCUPID works");
    expect(found).toBe("TEXTCUPID");
  });

  test("matches case-insensitively", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    expect(await detectCampaignCode("textcupid")).toBe("TEXTCUPID");
  });

  test("returns null when no token matches a code", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    expect(await detectCampaignCode("just saying hello today")).toBeNull();
  });

  test("ignores inactive codes", async () => {
    await createCampaignCode("OLDCODE", 3);
    store.set("campaign_codes/OLDCODE", {
      ...store.get("campaign_codes/OLDCODE"),
      active: false,
    });
    expect(await detectCampaignCode("trying OLDCODE")).toBeNull();
  });

  test("returns null for an empty message", async () => {
    expect(await detectCampaignCode("")).toBeNull();
  });
});

// ─── redeemCampaignCode ────────────────────────────────────────────────────────

describe("redeemCampaignCode", () => {
  test("awards credits, records redemption, increments count", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    seedUser(USER_HASH, 1);

    const result = await redeemCampaignCode("TEXTCUPID", USER_HASH);

    expect(result).toEqual({ redeemed: true, creditsAwarded: 3 });
    expect(store.get(`users/${USER_HASH}`)?.creditsRemaining).toBe(4);
    expect(store.get("campaign_codes/TEXTCUPID")?.redemptionCount).toBe(1);
    expect(store.has(`campaign_codes/TEXTCUPID/redemptions/${USER_HASH}`)).toBe(true);
  });

  test("is idempotent per user (second redemption rejected, no double credits)", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    seedUser(USER_HASH, 1);

    const first = await redeemCampaignCode("TEXTCUPID", USER_HASH);
    const second = await redeemCampaignCode("TEXTCUPID", USER_HASH);

    expect(first.redeemed).toBe(true);
    expect(second).toEqual({ redeemed: false, reason: "already_redeemed" });
    expect(store.get(`users/${USER_HASH}`)?.creditsRemaining).toBe(4);
    expect(store.get("campaign_codes/TEXTCUPID")?.redemptionCount).toBe(1);
  });

  test("different users can each redeem once", async () => {
    const otherHash = "b".repeat(64);
    await createCampaignCode("TEXTCUPID", 2);
    seedUser(USER_HASH, 1);
    seedUser(otherHash, 1);

    expect((await redeemCampaignCode("TEXTCUPID", USER_HASH)).redeemed).toBe(true);
    expect((await redeemCampaignCode("TEXTCUPID", otherHash)).redeemed).toBe(true);
    expect(store.get("campaign_codes/TEXTCUPID")?.redemptionCount).toBe(2);
  });

  test("respects maxRedemptions cap", async () => {
    const otherHash = "b".repeat(64);
    await createCampaignCode("LIMITED", 3, 1);
    seedUser(USER_HASH, 1);
    seedUser(otherHash, 1);

    const first = await redeemCampaignCode("LIMITED", USER_HASH);
    const second = await redeemCampaignCode("LIMITED", otherHash);

    expect(first.redeemed).toBe(true);
    expect(second).toEqual({ redeemed: false, reason: "max_redemptions" });
    expect(store.get(`users/${otherHash}`)?.creditsRemaining).toBe(1);
    expect(store.get("campaign_codes/LIMITED")?.redemptionCount).toBe(1);
  });

  test("rejects an inactive code", async () => {
    await createCampaignCode("PAUSED", 3);
    store.set("campaign_codes/PAUSED", {
      ...store.get("campaign_codes/PAUSED"),
      active: false,
    });
    seedUser(USER_HASH, 1);

    const result = await redeemCampaignCode("PAUSED", USER_HASH);

    expect(result).toEqual({ redeemed: false, reason: "inactive" });
    expect(store.get(`users/${USER_HASH}`)?.creditsRemaining).toBe(1);
  });

  test("rejects an unknown code", async () => {
    seedUser(USER_HASH, 1);
    expect(await redeemCampaignCode("NOPE1234", USER_HASH)).toEqual({
      redeemed: false,
      reason: "not_found",
    });
  });

  test("rejects when the user profile does not exist", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    expect(await redeemCampaignCode("TEXTCUPID", USER_HASH)).toEqual({
      redeemed: false,
      reason: "user_not_found",
    });
  });

  test("treats a missing creditsRemaining as the default of 1 (referral.ts parity)", async () => {
    await createCampaignCode("TEXTCUPID", 3);
    store.set(`users/${USER_HASH}`, { phoneHash: USER_HASH });

    const result = await redeemCampaignCode("TEXTCUPID", USER_HASH);
    expect(result.redeemed).toBe(true);
    expect(store.get(`users/${USER_HASH}`)?.creditsRemaining).toBe(4);
  });
});

// ─── createCampaignCode ────────────────────────────────────────────────────────

describe("createCampaignCode", () => {
  test("uppercases the code and applies defaults", async () => {
    const doc = await createCampaignCode("textcupid");
    expect(doc.code).toBe("TEXTCUPID");
    expect(doc.credits).toBe(3);
    expect(doc.active).toBe(true);
    expect(doc.maxRedemptions).toBeNull();
    expect(doc.redemptionCount).toBe(0);
    expect(store.has("campaign_codes/TEXTCUPID")).toBe(true);
  });

  test("rejects malformed codes", async () => {
    await expect(createCampaignCode("ab")).rejects.toThrow();
    await expect(createCampaignCode("WAY-TOO-LONG-CODE")).rejects.toThrow();
  });
});

// ─── buildCampaignConfirmation ─────────────────────────────────────────────────

describe("buildCampaignConfirmation", () => {
  test("mentions the code and credit count", () => {
    const msg = buildCampaignConfirmation("TEXTCUPID", 3);
    expect(msg).toContain("TEXTCUPID");
    expect(msg).toContain("3 free intros");
  });

  test("uses singular for one credit", () => {
    expect(buildCampaignConfirmation("SOLO", 1)).toContain("1 free intro");
  });

  test("contains no em-dashes or en-dashes", () => {
    const msg = buildCampaignConfirmation("TEXTCUPID", 3);
    expect(msg).not.toMatch(/[–—]/);
  });
});
