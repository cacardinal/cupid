import * as crypto from "crypto";

/**
 * Admin endpoint auth for the moderation review surface.
 *
 * Single shared secret in ADMIN_API_SECRET (Secret Manager, never shipped to a
 * browser). Constant-time compare on sha256 digests so the comparison length is
 * fixed regardless of the provided value. Fails closed when the secret is unset.
 * Dependency-free and unit-testable (no Firestore, no network).
 */

export const ADMIN_SECRET_HEADER = "x-admin-secret";

/**
 * Returns true only when `provided` exactly matches process.env.ADMIN_API_SECRET.
 * - Fails closed (false) when ADMIN_API_SECRET is unset/empty.
 * - Accepts the raw header value, which Express types as string | string[]
 *   | undefined; arrays and undefined are rejected.
 * - Identical false for missing/wrong/unset so callers expose no oracle.
 */
export function isAuthorizedAdmin(provided: string | string[] | undefined): boolean {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) return false; // fail closed
  if (typeof provided !== "string" || provided.length === 0) return false;

  const a = crypto.createHash("sha256").update(secret).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  // Both buffers are 32 bytes (sha256), so timingSafeEqual never throws.
  return crypto.timingSafeEqual(a, b);
}
