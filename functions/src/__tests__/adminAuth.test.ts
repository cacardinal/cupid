/**
 * adminAuth (N3) tests. Fail-closed when unset; constant-time exact match only;
 * identical false for missing/wrong/unset (no oracle); tolerates string[] input.
 */

import { isAuthorizedAdmin, ADMIN_SECRET_HEADER } from "../services/adminAuth";

const SAVED = process.env.ADMIN_API_SECRET;
const SECRET = "f".repeat(64);

afterEach(() => {
  if (SAVED === undefined) delete process.env.ADMIN_API_SECRET;
  else process.env.ADMIN_API_SECRET = SAVED;
});

describe("isAuthorizedAdmin", () => {
  test("fails closed when ADMIN_API_SECRET is unset", () => {
    delete process.env.ADMIN_API_SECRET;
    expect(isAuthorizedAdmin(SECRET)).toBe(false);
  });

  test("fails closed when ADMIN_API_SECRET is empty string", () => {
    process.env.ADMIN_API_SECRET = "";
    expect(isAuthorizedAdmin(SECRET)).toBe(false);
  });

  test("true only on exact match", () => {
    process.env.ADMIN_API_SECRET = SECRET;
    expect(isAuthorizedAdmin(SECRET)).toBe(true);
  });

  test("false on wrong value", () => {
    process.env.ADMIN_API_SECRET = SECRET;
    expect(isAuthorizedAdmin("e".repeat(64))).toBe(false);
  });

  test("false on undefined provided", () => {
    process.env.ADMIN_API_SECRET = SECRET;
    expect(isAuthorizedAdmin(undefined)).toBe(false);
  });

  test("false on empty provided", () => {
    process.env.ADMIN_API_SECRET = SECRET;
    expect(isAuthorizedAdmin("")).toBe(false);
  });

  test("false on array input (Express header repeated)", () => {
    process.env.ADMIN_API_SECRET = SECRET;
    expect(isAuthorizedAdmin([SECRET])).toBe(false);
    expect(isAuthorizedAdmin(["wrong"])).toBe(false);
  });

  test("header constant name", () => {
    expect(ADMIN_SECRET_HEADER).toBe("x-admin-secret");
  });
});
