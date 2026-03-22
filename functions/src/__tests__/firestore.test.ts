import { hashPhone, normalizePhone } from "../services/firestore";

// These tests cover pure utility functions that don't need Firebase
describe("Phone utilities", () => {
  describe("normalizePhone", () => {
    test("normalizes 10-digit US number to E.164", () => {
      expect(normalizePhone("3145551234")).toBe("+13145551234");
    });

    test("normalizes 11-digit number starting with 1 to E.164", () => {
      expect(normalizePhone("13145551234")).toBe("+13145551234");
    });

    test("strips formatting characters", () => {
      expect(normalizePhone("(314) 555-1234")).toBe("+13145551234");
      expect(normalizePhone("314-555-1234")).toBe("+13145551234");
      expect(normalizePhone("+1 314 555 1234")).toBe("+13145551234");
    });

    test("handles already formatted E.164", () => {
      expect(normalizePhone("+13145551234")).toBe("+13145551234");
    });

    test("handles international number", () => {
      expect(normalizePhone("441234567890")).toBe("+441234567890");
    });
  });

  describe("hashPhone", () => {
    test("returns 64-char hex string (SHA-256)", () => {
      const hash = hashPhone("+13145551234");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    test("same number always produces same hash", () => {
      const hash1 = hashPhone("+13145551234");
      const hash2 = hashPhone("+13145551234");
      expect(hash1).toBe(hash2);
    });

    test("different numbers produce different hashes", () => {
      const hash1 = hashPhone("+13145551234");
      const hash2 = hashPhone("+13145555678");
      expect(hash1).not.toBe(hash2);
    });

    test("hash is not reversible to original phone", () => {
      const hash = hashPhone("+13145551234");
      // Hash should not contain the phone number
      expect(hash).not.toContain("314");
      expect(hash).not.toContain("1234");
    });
  });
});
